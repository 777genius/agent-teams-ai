import {
  HOSTED_AUTH_HEADERS,
  HOSTED_AUTH_ROUTES,
  type HostedAuthMode,
  type HostedAuthStatus,
  type HostedPrincipal,
  parseOidcLoginAttemptId,
  parseOpaqueAuthoritySecret,
} from '../../../../contracts';
import {
  type HostedAuthenticatedPrincipal,
  type HostedAuthenticationContext,
  type HostedAuthenticationProvider,
  HostedWorkspaceAccessService,
  type OidcAuthenticationCapability,
  type PersonalAuthenticationCapability,
  sanitizeHostedAuthenticatedPrincipal,
} from '../../../../core/application';
import {
  type AdmissionWindow,
  admitFixedWindow,
  bodyRecord,
  classifyHostedHttpAuthorization,
  clearCookie,
  cookie,
  DEVICE_COOKIE,
  type HostedHttpApplication,
  type HostedHttpReply,
  type HostedHttpRequest,
  OIDC_ATTEMPT_COOKIE,
  OIDC_BACKCHANNEL_GLOBAL_LIMIT,
  OIDC_BACKCHANNEL_LIMIT_PER_SOURCE,
  OIDC_BACKCHANNEL_MAX_CONCURRENCY,
  OIDC_LOGIN_LIMIT_PER_SOURCE,
  OIDC_LOGIN_WINDOW_MS,
  OIDC_STATE_COOKIE,
  parseCookies,
  roleAllows,
  safeReturnTo,
  SESSION_COOKIE,
} from '../../../../core/domain';

import type { InternalStorageHostedAccessRepository } from '../../output/InternalStorageHostedAccessRepository';
import type { TeamId } from '@shared/contracts/hosted';
type RequestAuthContext = HostedAuthenticationContext;
export interface HostedAuthHttpControllerDependencies {
  readonly mode: HostedAuthMode;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly authentication: HostedAuthenticationProvider;
  readonly personal: PersonalAuthenticationCapability | null;
  readonly oidc: OidcAuthenticationCapability | null;
  readonly repository: InternalStorageHostedAccessRepository;
  readonly restoreGeneration: number;
  readonly sessionMaxAgeSeconds: number;
  readonly deviceMaxAgeSeconds: number;
  readonly tryEnterPublicRequest: () => boolean;
  readonly leavePublicRequest: () => void;
  readonly isPublicAccessActive: () => boolean;
  readonly isTaskBoardMutationRouteEnabled?: () => boolean;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<string | null>;
}
export class HostedAuthHttpController {
  private readonly requestContexts = new WeakMap<object, RequestAuthContext>();
  private readonly admittedRequests = new WeakSet<object>();
  private readonly oidcLoginAdmission = new Map<string, AdmissionWindow>();
  private readonly oidcBackchannelAdmission = new Map<string, AdmissionWindow>();
  private readonly oidcBackchannelGlobalAdmission: AdmissionWindow = { startedAt: 0, count: 0 };
  private readonly workspaceAccess: HostedWorkspaceAccessService;
  private oidcBackchannelInFlight = 0;
  constructor(private readonly dependencies: HostedAuthHttpControllerDependencies) {
    this.workspaceAccess = new HostedWorkspaceAccessService(
      dependencies.repository,
      dependencies.restoreGeneration
    );
  }
  get allowedOrigin(): string {
    return this.dependencies.publicOrigin;
  }
  register(application: unknown): void {
    const app = application as HostedHttpApplication;
    if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
      app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        }
      );
    }
    app.addHook('preHandler', async (request, reply) => {
      if (!this.dependencies.tryEnterPublicRequest()) {
        await reply.code(503).send({ error: 'auth_mode_reset_requires_restart' });
        return;
      }
      this.admittedRequests.add(request);
      reply.raw.once('close', () => {
        this.leavePublicRequest(request);
      });
      await this.authorize(request, reply);
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url.split('?', 1)[0]?.startsWith('/api/auth/')) {
        reply.header('cache-control', 'no-store, private');
        reply.header('pragma', 'no-cache');
      }
      const context = this.requestContexts.get(request);
      if (!context) return payload;
      if (this.taskBoardMutationsAreAdvertised(reply, context))
        reply.header(HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement, 'enabled');
      reply.header('cache-control', 'no-store, private');
      reply.header('pragma', 'no-cache');
      if (typeof payload !== 'string') return payload;
      if (request.url.split('?', 1)[0] === HOSTED_AUTH_ROUTES.logout) {
        return payload;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return payload;
      }
      try {
        return JSON.stringify(
          await this.workspaceAccess.projectPayload(context.principal.userId, parsed)
        );
      } catch {
        reply.code(503);
        return JSON.stringify({ error: 'hosted_projection_unavailable' });
      }
    });
    app.addHook('onResponse', async (request) => {
      this.leavePublicRequest(request);
    });
    this.registerAuthRoutes(app);
  }
  context(request: unknown): RequestAuthContext | null {
    return this.requestContexts.get(request as object) ?? null;
  }
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null {
    const context = this.requestContexts.get(request);
    return context === undefined ? null : sanitizeHostedAuthenticatedPrincipal(context);
  }
  async isWorkspaceRegistered(workspaceId: string): Promise<boolean> {
    return this.dependencies.repository.isWorkspaceRegistered(workspaceId);
  }
  async projectWorkspaceId(request: unknown, runtimeWorkspaceId: string): Promise<string | null> {
    const context = this.requestContexts.get(request as object);
    if (!context) return null;
    try {
      return await this.workspaceAccess.projectWorkspaceId(
        context.principal.userId,
        runtimeWorkspaceId
      );
    } catch {
      return null;
    }
  }
  async projectPayload(request: unknown, payload: unknown): Promise<unknown> {
    const context = this.requestContexts.get(request as object);
    if (!context) return null;
    return this.workspaceAccess.projectPayload(context.principal.userId, payload);
  }
  async projectEvent(request: unknown, _channel: string, data: unknown): Promise<unknown | null> {
    const hostedRequest = request as HostedHttpRequest;
    const context = await this.liveRequestContext(hostedRequest);
    if (!context) return null;
    try {
      const source = bodyRecord(data);
      const runtimeWorkspaceId =
        typeof source.projectId === 'string'
          ? source.projectId
          : typeof source.workspaceId === 'string'
            ? source.workspaceId
            : null;
      if (runtimeWorkspaceId === null) return null;
      return this.workspaceAccess.projectEvent(context.principal.userId, runtimeWorkspaceId, data);
    } catch {
      return null;
    }
  }
  async isEventStreamAuthorized(request: unknown): Promise<boolean> {
    return (await this.liveRequestContext(request as HostedHttpRequest)) !== null;
  }
  async isHostedQueryAuthorized(request: unknown): Promise<boolean> {
    const context = await this.liveRequestContext(request as HostedHttpRequest);
    return context !== null && roleAllows(context.principal.role, 'hosted.query');
  }
  async isTeamWorkspaceAuthorized(request: unknown, teamId: TeamId): Promise<boolean> {
    const context = await this.liveRequestContext(request as HostedHttpRequest);
    if (!context) return false;
    return this.workspaceAccess
      .hasTeamWorkspaceGrant(
        context.principal.userId,
        teamId,
        this.dependencies.resolveTeamWorkspaceId
      )
      .catch(() => false);
  }
  async isHostedTaskMutationAuthorized(request: unknown, teamId: TeamId): Promise<boolean> {
    const hostedRequest = request as HostedHttpRequest;
    const context = await this.liveRequestContext(hostedRequest);
    const presented = hostedRequest.headers[HOSTED_AUTH_HEADERS.csrf];
    if (
      context === null ||
      typeof presented !== 'string' ||
      !roleAllows(context.principal.role, 'hosted.command') ||
      !this.hasTrustedOrigin(hostedRequest)
    ) {
      return false;
    }
    return (
      (await this.dependencies.authentication.verifyCsrf(context, presented).catch(() => false)) &&
      (await this.isTeamWorkspaceAuthorized(hostedRequest, teamId))
    );
  }
  private async liveRequestContext(request: HostedHttpRequest): Promise<RequestAuthContext | null> {
    if (!this.dependencies.isPublicAccessActive()) return null;
    const context = this.requestContexts.get(request);
    if (!context) return null;
    try {
      const result = await this.dependencies.authentication.authenticate({
        sessionSecret: context.sessionSecret,
        allowRenewal: false,
        sourceIp: request.ip,
      });
      return result.authenticated &&
        context.authenticatedSessionId !== undefined &&
        result.context.authenticatedSessionId === context.authenticatedSessionId &&
        result.context.principal.userId === context.principal.userId
        ? result.context
        : null;
    } catch {
      return null;
    }
  }
  private taskBoardMutationsAreAdvertised(
    reply: HostedHttpReply,
    context: RequestAuthContext
  ): boolean {
    try {
      const statusCode = Reflect.get(reply, 'statusCode');
      const routeEnabled = this.dependencies.isTaskBoardMutationRouteEnabled?.() === true;
      return (
        Number.isSafeInteger(statusCode) &&
        statusCode < 400 &&
        routeEnabled &&
        roleAllows(context.principal.role, 'hosted.command')
      );
    } catch {
      return false;
    }
  }
  private registerAuthRoutes(app: HostedHttpApplication): void {
    app.get(HOSTED_AUTH_ROUTES.status, async (request, reply) => {
      const authenticated = await this.authenticate(request, reply, true);
      if (reply.sent) return;
      if (authenticated === null) return this.status(null, null);
      return this.status(authenticated.principal, authenticated.csrfToken);
    });
    app.post(HOSTED_AUTH_ROUTES.pair, async (request, reply) => {
      if (this.dependencies.personal === null) {
        return reply.code(404).send({ error: 'auth_mode_mismatch' });
      }
      if (!this.hasTrustedOrigin(request)) {
        return reply.code(403).send({ error: 'origin_invalid' });
      }
      const pairingCode = bodyRecord(request.body).pairingCode;
      try {
        const result = await this.dependencies.personal.pair(
          parseOpaqueAuthoritySecret(pairingCode)
        );
        if (!result.ok) {
          await this.auditPersonal(request, null, 'auth.personal.pair', 'denied', result.code);
          return reply.code(401).send({ error: result.code });
        }
        await this.auditPersonal(
          request,
          result.value.principal.userId,
          'auth.personal.pair',
          'success'
        );
        this.setCredentialCookies(reply, result.value.sessionSecret, result.value.deviceSecret);
        return this.status(result.value.principal, result.value.csrfToken);
      } catch (error) {
        const storageUnavailable =
          error instanceof Error &&
          (error.message === 'personal_identity_storage_unavailable' ||
            error.message === 'personal_authority_unavailable');
        await this.auditPersonal(
          request,
          null,
          'auth.personal.pair',
          'failure',
          storageUnavailable ? 'identity_storage_unavailable' : 'invalid_request'
        );
        return reply.code(storageUnavailable ? 503 : 401).send({
          error: storageUnavailable ? 'identity_storage_unavailable' : 'pairing_code_invalid',
        });
      }
    });
    app.get(HOSTED_AUTH_ROUTES.login, async (request, reply) => {
      if (this.dependencies.oidc === null) {
        return reply.code(404).send({ error: 'auth_mode_mismatch' });
      }
      if (!this.admitOidcLogin(request.ip)) {
        reply.header('retry-after', '60');
        return reply.code(429).send({ error: 'oidc_login_rate_limited' });
      }
      const query = request.query as { returnTo?: unknown };
      const returnTo = safeReturnTo(query.returnTo, this.dependencies.publicOrigin);
      try {
        const begun = await this.dependencies.oidc.beginLogin(returnTo);
        reply.headers({
          'cache-control': 'no-store',
          'set-cookie': [
            cookie(OIDC_ATTEMPT_COOKIE, begun.attemptId, {
              maxAge: 600,
              secure: this.dependencies.secureCookies,
              sameSite: 'Lax',
            }),
            cookie(OIDC_STATE_COOKIE, begun.state, {
              maxAge: 600,
              secure: this.dependencies.secureCookies,
              sameSite: 'Lax',
            }),
          ],
        });
        return reply.redirect(begun.redirectUrl);
      } catch (error) {
        return reply.code(503).send({
          error:
            error instanceof Error && error.message === 'oidc_provider_unavailable'
              ? 'oidc_provider_unavailable'
              : 'oidc_login_unavailable',
        });
      }
    });
    app.get(HOSTED_AUTH_ROUTES.callback, async (request, reply) => {
      if (this.dependencies.oidc === null) {
        return reply.code(404).send({ error: 'auth_mode_mismatch' });
      }
      const cookies = parseCookies(request.headers.cookie);
      const state = cookies.get(OIDC_STATE_COOKIE);
      const attempt = cookies.get(OIDC_ATTEMPT_COOKIE);
      if (!state || !attempt) {
        reply.header('set-cookie', [
          clearCookie(OIDC_ATTEMPT_COOKIE, this.dependencies.secureCookies),
          clearCookie(OIDC_STATE_COOKIE, this.dependencies.secureCookies),
        ]);
        return reply.code(401).send({ error: 'oidc_state_missing' });
      }
      try {
        const callbackUrl = new URL(request.url, this.dependencies.publicOrigin);
        const issued = await this.dependencies.oidc.completeLogin({
          callbackUrl,
          expectedState: state,
          attemptId: parseOidcLoginAttemptId(attempt),
          sourceIp: request.ip,
        });
        reply.headers({
          'cache-control': 'no-store',
          'set-cookie': [
            cookie(SESSION_COOKIE, issued.sessionSecret, {
              maxAge: this.dependencies.sessionMaxAgeSeconds,
              secure: this.dependencies.secureCookies,
              sameSite: 'Strict',
            }),
            clearCookie(OIDC_ATTEMPT_COOKIE, this.dependencies.secureCookies),
            clearCookie(OIDC_STATE_COOKIE, this.dependencies.secureCookies),
          ],
        });
        return reply.redirect(issued.returnTo);
      } catch (error) {
        reply.header('set-cookie', [
          clearCookie(OIDC_ATTEMPT_COOKIE, this.dependencies.secureCookies),
          clearCookie(OIDC_STATE_COOKIE, this.dependencies.secureCookies),
        ]);
        const code =
          error instanceof Error && /^oidc_[a-z0-9_]+$/.test(error.message)
            ? error.message
            : 'oidc_callback_unavailable';
        const statusCode = code.endsWith('_unavailable')
          ? 503
          : code === 'oidc_user_disabled'
            ? 403
            : 401;
        return reply.code(statusCode).send({ error: code });
      }
    });
    app.post(HOSTED_AUTH_ROUTES.logout, async (request, reply) => {
      const context = await this.requireContext(request, reply);
      if (context === null) return;
      const global = bodyRecord(request.body).global === true;
      let redirectUrl: string | null = null;
      let providerLogoutError: string | null = null;
      if (this.dependencies.personal !== null) {
        try {
          await this.dependencies.authentication.logout({
            context,
            global: false,
            postLogoutRedirectUri: `${this.dependencies.publicOrigin}/`,
            sourceIp: request.ip,
          });
        } catch {
          return reply.code(503).send({ error: 'personal_logout_unavailable' });
        }
        await this.auditPersonal(
          request,
          context.principal.userId,
          'auth.personal.logout',
          'success'
        );
      } else {
        try {
          redirectUrl = (
            await this.dependencies.authentication.logout({
              context,
              global,
              postLogoutRedirectUri: `${this.dependencies.publicOrigin}/`,
              sourceIp: request.ip,
            })
          ).redirectUrl;
        } catch (error) {
          if (global && error instanceof Error && error.message === 'oidc_provider_unavailable') {
            providerLogoutError = 'oidc_provider_unavailable';
          } else {
            // Preserve the cookie when revocation is unconfirmed; clearing it could leave a stolen copy active.
            return reply.code(503).send({ error: 'oidc_logout_unavailable' });
          }
        }
      }
      reply.header('set-cookie', clearCookie(SESSION_COOKIE, this.dependencies.secureCookies));
      return { ok: true, redirectUrl, providerLogoutError };
    });
    app.post(HOSTED_AUTH_ROUTES.forgetDevice, async (request, reply) => {
      if (this.dependencies.personal === null) {
        return reply.code(404).send({ error: 'auth_mode_mismatch' });
      }
      const context = await this.requireContext(request, reply);
      if (context === null) return;
      try {
        const result = await this.dependencies.personal.forgetDevice(context);
        await this.auditPersonal(
          request,
          context.principal.userId,
          'auth.personal.forget-device',
          result.ok ? 'success' : 'failure',
          result.ok ? undefined : result.code
        );
        if (!result.ok) {
          return reply.code(result.code === 'session_invalid' ? 401 : 503).send({
            error:
              result.code === 'session_invalid'
                ? 'session_invalid'
                : 'personal_forget_device_unavailable',
          });
        }
        reply.header('set-cookie', [
          clearCookie(SESSION_COOKIE, this.dependencies.secureCookies),
          clearCookie(DEVICE_COOKIE, this.dependencies.secureCookies),
        ]);
        return { ok: true };
      } catch {
        await this.auditPersonal(
          request,
          context.principal.userId,
          'auth.personal.forget-device',
          'failure',
          'authority_unavailable'
        );
        return reply.code(503).send({ error: 'personal_forget_device_unavailable' });
      }
    });
    app.post(HOSTED_AUTH_ROUTES.backchannelLogout, async (request, reply) => {
      if (this.dependencies.oidc === null) {
        return reply.code(404).send({ error: 'auth_mode_mismatch' });
      }
      const token = bodyRecord(request.body).logout_token;
      if (typeof token !== 'string') {
        return reply.code(400).send({ error: 'logout_token_missing' });
      }
      if (!this.admitOidcBackchannel(request.ip)) {
        reply.header('retry-after', '1');
        return reply.code(429).send({ error: 'oidc_backchannel_logout_rate_limited' });
      }
      try {
        await this.dependencies.oidc.backchannelLogout(token);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof Error && error.message.endsWith('_unavailable')) {
          return reply.code(503).send({
            error:
              error.message === 'oidc_provider_unavailable'
                ? 'oidc_provider_unavailable'
                : 'oidc_backchannel_logout_unavailable',
          });
        }
        if (!(error instanceof Error && /^oidc_[a-z0-9_]+$/.test(error.message))) {
          return reply.code(503).send({ error: 'oidc_backchannel_logout_unavailable' });
        }
        return reply.code(400).send({ error: 'logout_token_invalid' });
      } finally {
        this.oidcBackchannelInFlight -= 1;
      }
    });
  }
  private leavePublicRequest(request: HostedHttpRequest): void {
    if (this.admittedRequests.delete(request)) this.dependencies.leavePublicRequest();
  }
  private async authorize(request: HostedHttpRequest, reply: HostedHttpReply): Promise<void> {
    const policy = classifyHostedHttpAuthorization(request.method, request.url);
    if (policy.kind === 'public') return;
    if (policy.kind === 'forbidden') {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }
    const context = await this.authenticate(request, reply, false);
    if (context === null) {
      if (reply.sent) return;
      await reply.code(401).send({ error: 'authentication_required' });
      return;
    }
    if (!roleAllows(context.principal.role, policy.permission)) {
      await this.auditDenied(request, context, policy.permission, 'permission_denied');
      await reply.code(403).send({ error: 'permission_denied' });
      return;
    }
    if (policy.csrfRequired) {
      if (!this.hasTrustedOrigin(request)) {
        await this.auditDenied(request, context, policy.permission, 'origin_invalid');
        await reply.code(403).send({ error: 'origin_invalid' });
        return;
      }
      const presented = request.headers[HOSTED_AUTH_HEADERS.csrf];
      let csrfValid = false;
      try {
        csrfValid =
          typeof presented === 'string' &&
          (await this.dependencies.authentication.verifyCsrf(context, presented));
      } catch {
        await reply.code(503).send({ error: 'identity_storage_unavailable' });
        return;
      }
      if (!csrfValid) {
        await this.auditDenied(request, context, policy.permission, 'csrf_invalid');
        await reply.code(403).send({ error: 'csrf_invalid' });
        return;
      }
    }
    if (policy.workspaceRequired) {
      const parameters = request.params as Record<string, unknown>;
      const body = bodyRecord(request.body);
      const publicWorkspaceId =
        typeof parameters.projectId === 'string'
          ? parameters.projectId
          : typeof parameters.id === 'string'
            ? parameters.id
            : typeof body.projectId === 'string'
              ? body.projectId
              : null;
      let grant = null;
      if (publicWorkspaceId !== null) {
        try {
          grant = await this.workspaceAccess.resolvePublicGrant(
            context.principal.userId,
            publicWorkspaceId
          );
        } catch {
          await reply.code(503).send({ error: 'identity_storage_unavailable' });
          return;
        }
      }
      if (grant === null) {
        await this.auditDenied(request, context, policy.permission, 'workspace_denied');
        await reply.code(403).send({ error: 'workspace_access_denied' });
        return;
      }
      if (typeof parameters.projectId === 'string') {
        parameters.projectId = grant.runtimeWorkspaceId;
      } else if (typeof parameters.id === 'string') {
        parameters.id = grant.runtimeWorkspaceId;
      } else if (typeof body.projectId === 'string') {
        body.projectId = grant.runtimeWorkspaceId;
      }
    }
    if (
      policy.teamWorkspaceRequired &&
      !(await this.authorizeTeamWorkspace(request, reply, context, policy.permission))
    ) {
      return;
    }
  }
  private async authorizeTeamWorkspace(
    request: HostedHttpRequest,
    reply: HostedHttpReply,
    context: RequestAuthContext,
    permission: string
  ): Promise<boolean> {
    let granted: boolean;
    try {
      granted = await this.workspaceAccess.hasTeamWorkspaceGrant(
        context.principal.userId,
        bodyRecord(request.body).teamId,
        this.dependencies.resolveTeamWorkspaceId
      );
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'identity_storage_unavailable'
          ? error.message
          : 'workspace_attribution_unavailable';
      await reply.code(503).send({ error: code });
      return false;
    }
    if (!granted) {
      await this.auditDenied(request, context, permission, 'workspace_denied');
      await reply.code(403).send({ error: 'workspace_access_denied' });
      return false;
    }
    return true;
  }
  private async auditDenied(
    request: HostedHttpRequest,
    context: RequestAuthContext,
    permission: string,
    reason: 'permission_denied' | 'origin_invalid' | 'csrf_invalid' | 'workspace_denied'
  ): Promise<void> {
    await this.dependencies.authentication
      .auditAuthorization({
        principal: context.principal,
        sourceIp: request.ip,
        reason,
        method: request.method,
        permission,
      })
      .catch(() => undefined);
  }
  private async authenticate(
    request: HostedHttpRequest,
    reply: HostedHttpReply,
    allowRenewal: boolean
  ): Promise<RequestAuthContext | null> {
    const existing = this.requestContexts.get(request);
    if (existing) return existing;
    const cookies = parseCookies(request.headers.cookie);
    const sessionSecret = cookies.get(SESSION_COOKIE);
    const deviceSecret = cookies.get(DEVICE_COOKIE);
    try {
      const result = await this.dependencies.authentication.authenticate({
        ...(sessionSecret === undefined ? {} : { sessionSecret }),
        ...(deviceSecret === undefined ? {} : { deviceSecret }),
        allowRenewal,
        sourceIp: request.ip,
      });
      if (!result.authenticated) {
        if (this.dependencies.personal !== null && allowRenewal && deviceSecret) {
          await this.auditPersonal(request, null, 'auth.personal.renew', 'failure', result.reason);
        }
        return null;
      }
      if (result.replacementDeviceSecret !== null) {
        await this.auditPersonal(
          request,
          result.context.principal.userId,
          'auth.personal.renew',
          'success'
        );
        this.setCredentialCookies(
          reply,
          result.context.sessionSecret,
          result.replacementDeviceSecret
        );
      }
      const context = result.context;
      this.requestContexts.set(request, context);
      return context;
    } catch (error) {
      const unavailable =
        error instanceof Error &&
        (error.message === 'personal_identity_storage_unavailable' ||
          error.message === 'personal_authority_unavailable' ||
          error.message === 'oidc_authentication_unavailable');
      if (unavailable) {
        if (this.dependencies.personal !== null) {
          await this.auditPersonal(
            request,
            null,
            'auth.personal.renew',
            'failure',
            'identity_storage_unavailable'
          );
        }
        await reply.code(503).send({ error: 'identity_storage_unavailable' });
        return null;
      }
      return null;
    }
  }
  private async auditPersonal(
    request: HostedHttpRequest,
    userId: HostedPrincipal['userId'] | null,
    action:
      | 'auth.personal.pair'
      | 'auth.personal.renew'
      | 'auth.personal.logout'
      | 'auth.personal.forget-device',
    outcome: 'success' | 'denied' | 'failure',
    reason?: string
  ): Promise<void> {
    try {
      await this.dependencies.personal?.auditPersonalAuthentication({
        userId,
        action,
        outcome,
        sourceIp: request.ip,
        reason,
      });
    } catch {
      // Never roll back a completed authority transition when its secondary audit append fails.
    }
  }
  private async requireContext(
    request: HostedHttpRequest,
    reply: HostedHttpReply
  ): Promise<RequestAuthContext | null> {
    const context = this.requestContexts.get(request) ?? null;
    if (context === null) await reply.code(401).send({ error: 'authentication_required' });
    return context;
  }
  private hasTrustedOrigin(request: HostedHttpRequest): boolean {
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    return (
      origin === this.dependencies.publicOrigin &&
      (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'same-site')
    );
  }
  private setCredentialCookies(
    reply: HostedHttpReply,
    sessionSecret: string,
    deviceSecret: string
  ): void {
    reply.header('set-cookie', [
      cookie(SESSION_COOKIE, sessionSecret, {
        maxAge: this.dependencies.sessionMaxAgeSeconds,
        secure: this.dependencies.secureCookies,
        sameSite: 'Strict',
      }),
      cookie(DEVICE_COOKIE, deviceSecret, {
        maxAge: this.dependencies.deviceMaxAgeSeconds,
        secure: this.dependencies.secureCookies,
        sameSite: 'Strict',
      }),
    ]);
  }
  private status(
    principalValue: HostedPrincipal | null,
    csrfToken: string | null
  ): HostedAuthStatus {
    return Object.freeze({
      mode: this.dependencies.mode,
      authenticated: principalValue !== null,
      principal: principalValue,
      csrfToken,
      oidcProviderName:
        this.dependencies.oidc === null ? null : this.dependencies.authentication.displayName,
    });
  }
  private admitOidcLogin(source: string): boolean {
    return admitFixedWindow(
      this.oidcLoginAdmission,
      source,
      Date.now(),
      OIDC_LOGIN_LIMIT_PER_SOURCE
    );
  }
  private admitOidcBackchannel(source: string): boolean {
    if (this.oidcBackchannelInFlight >= OIDC_BACKCHANNEL_MAX_CONCURRENCY) return false;
    const now = Date.now();
    const global = this.oidcBackchannelGlobalAdmission;
    if (now - global.startedAt >= OIDC_LOGIN_WINDOW_MS) {
      global.startedAt = now;
      global.count = 0;
    }
    if (global.count >= OIDC_BACKCHANNEL_GLOBAL_LIMIT) return false;
    if (
      !admitFixedWindow(
        this.oidcBackchannelAdmission,
        source,
        now,
        OIDC_BACKCHANNEL_LIMIT_PER_SOURCE
      )
    ) {
      return false;
    }
    global.count += 1;
    this.oidcBackchannelInFlight += 1;
    return true;
  }
}
