import { parseTeamId, type TeamId } from '@shared/contracts/hosted';

import {
  type HostedPrincipal,
  type HostedRole,
  type HostedSessionId,
  type OidcLoginAttemptId,
  type OperatorId,
  parseAuditEventId,
  parseHostedSessionId,
  parseHostedWorkspaceId,
  parseOidcLoginAttemptId,
  parseUserId,
} from '../../contracts';
import {
  createHostedWorkspaceProjectionScope,
  permissionsForRole,
  projectHostedPayload,
} from '../domain';

import type {
  HostedAuditEvent,
  HostedIdentityCryptoPort,
  HostedIdentityRepositoryPort,
  HostedOperatorSessionRecord,
  HostedPersonalOwnerRecord,
  HostedWorkspaceGrant,
  OidcIdentityProvider,
  OidcLoginAttemptRecord,
} from './identityPorts';

export interface HostedIdentityServicePolicy {
  readonly oidcLoginTtlMs: number;
  readonly sessionIdleTtlMs: number;
  readonly sessionAbsoluteTtlMs: number;
  readonly restoreGeneration: number;
}

export interface HostedIdentityServiceDependencies {
  readonly repository: HostedIdentityRepositoryPort;
  readonly crypto: HostedIdentityCryptoPort;
  readonly provider: OidcIdentityProvider | null;
  readonly policy: HostedIdentityServicePolicy;
  readonly now: () => number;
}

export interface IssuedHostedSession {
  readonly sessionSecret: string;
  readonly csrfToken: string;
  readonly principal: HostedPrincipal;
  readonly session: HostedOperatorSessionRecord;
  readonly returnTo: string;
}

export type AuthenticateHostedSessionResult =
  | {
      readonly authenticated: true;
      readonly principal: HostedPrincipal;
      readonly csrfToken: string;
    }
  | {
      readonly authenticated: false;
      readonly reason: 'invalid' | 'expired' | 'revoked' | 'user-disabled';
    };

export class HostedIdentityService {
  constructor(private readonly dependencies: HostedIdentityServiceDependencies) {
    if (
      !Number.isSafeInteger(dependencies.policy.restoreGeneration) ||
      dependencies.policy.restoreGeneration < 0
    ) {
      throw new TypeError('hosted_identity_restore_generation_invalid');
    }
  }

  async createWorkspaceId() {
    return parseHostedWorkspaceId(await this.dependencies.crypto.randomId('workspace'));
  }

  async beginOidcLogin(returnTo: string): Promise<{
    readonly redirectUrl: string;
    readonly attemptId: OidcLoginAttemptId;
    readonly state: string;
  }> {
    const provider = this.oidcProvider();
    const now = this.dependencies.now();
    const attemptId = parseOidcLoginAttemptId(
      await this.dependencies.crypto.randomId('oidc-attempt')
    );
    const begun = await provider.beginLogin({ attemptId, returnTo });
    const record: OidcLoginAttemptRecord = Object.freeze({
      attemptId,
      providerId: provider.id,
      stateHash: await this.hashOidcState(begun.state),
      nonce: begun.nonce,
      pkceVerifierCiphertext: await this.dependencies.crypto.encryptLoginSecret(begun.pkceVerifier),
      returnTo,
      createdAt: now,
      expiresAt: now + this.dependencies.policy.oidcLoginTtlMs,
      consumedAt: null,
    });
    const created = await this.dependencies.repository.createOidcLoginAttempt(record);
    if (created !== 'created') {
      throw new Error(
        created === 'capacity' ? 'oidc_login_capacity_exceeded' : 'oidc_login_attempt_conflict'
      );
    }
    return Object.freeze({
      redirectUrl: begun.redirectUrl,
      attemptId,
      state: begun.state,
    });
  }

  async completeOidcLogin(input: {
    readonly callbackUrl: URL;
    readonly expectedState: string;
    readonly attemptId: OidcLoginAttemptId;
    readonly sourceIp?: string;
  }): Promise<IssuedHostedSession> {
    const provider = this.oidcProvider();
    const now = this.dependencies.now();
    const callbackState = input.callbackUrl.searchParams.get('state');
    if (
      callbackState === null ||
      !(await this.dependencies.crypto.secureEqual(callbackState, input.expectedState))
    ) {
      await this.audit(null, null, 'auth.oidc.callback', 'denied', input.sourceIp, {
        reason: 'state_mismatch',
      });
      throw new Error('oidc_state_mismatch');
    }
    const stateHash = await this.hashOidcState(callbackState);
    const attempt = await this.dependencies.repository.consumeOidcLoginAttempt({
      attemptId: input.attemptId,
      providerId: provider.id,
      stateHash,
      now,
    });
    if (attempt === null) {
      await this.audit(null, null, 'auth.oidc.callback', 'denied', input.sourceIp, {
        reason: 'state_invalid_or_replayed',
      });
      throw new Error('oidc_state_invalid_or_replayed');
    }

    let claims;
    try {
      claims = await provider.completeLogin({
        callbackUrl: input.callbackUrl,
        expectedState: input.expectedState,
        attemptId: input.attemptId,
        nonce: attempt.nonce,
        pkceVerifier: await this.dependencies.crypto.decryptLoginSecret(
          attempt.pkceVerifierCiphertext
        ),
      });
    } catch (error) {
      await this.audit(null, null, 'auth.oidc.callback', 'failure', input.sourceIp, {
        reason:
          error instanceof Error && /^oidc_[a-z0-9_]+$/.test(error.message)
            ? error.message
            : 'provider_failure',
      });
      throw error;
    }

    const proposedUserId = parseUserId(await this.dependencies.crypto.randomId('user'));
    const binding = await this.dependencies.repository.bindExternalIdentity({
      identity: {
        issuer: claims.issuer,
        subject: claims.subject,
        providerId: provider.id,
        createdAt: now,
        lastAuthenticatedAt: now,
      },
      proposedUser: {
        userId: proposedUserId,
        displayName: claims.displayName,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    if (binding.user.status !== 'active') {
      await this.audit(binding.user.userId, null, 'auth.oidc.login', 'denied', input.sourceIp, {
        reason: 'user_disabled',
      });
      throw new Error('oidc_user_disabled');
    }
    const localRole = await this.dependencies.repository.getLocalRoleAssignment(
      binding.user.userId
    );
    const effectiveRole = localRole?.role ?? claims.role;
    const issued = await this.issueSession({
      userId: binding.user.userId,
      displayName: binding.user.displayName,
      role: effectiveRole,
      roleSource: localRole === null ? 'oidc-claim' : 'local-cli',
      issuer: claims.issuer,
      subject: claims.subject,
      providerSessionId: claims.providerSessionId,
    });
    await this.audit(
      issued.principal.userId,
      issued.session.sessionId,
      'auth.oidc.login',
      'success',
      input.sourceIp,
      {
        provider: provider.id,
        role: effectiveRole,
        roleSource: localRole === null ? 'oidc-claim' : 'local-cli',
      }
    );
    return Object.freeze({ ...issued, returnTo: attempt.returnTo });
  }

  async authenticate(
    sessionSecret: string,
    sourceIp?: string,
    allowRenewal = true
  ): Promise<AuthenticateHostedSessionResult> {
    const now = this.dependencies.now();
    const secretHash = await this.hashSessionSecret(sessionSecret);
    const session = await this.dependencies.repository.findSessionBySecretHash(secretHash);
    if (session === null) return Object.freeze({ authenticated: false, reason: 'invalid' });
    if (session.status !== 'active') {
      return Object.freeze({ authenticated: false, reason: 'revoked' });
    }
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      await this.dependencies.repository.revokeSession({
        sessionId: session.sessionId,
        now,
        reason: 'expired',
      });
      await this.audit(
        session.userId,
        session.sessionId,
        'auth.session.authenticate',
        'denied',
        sourceIp,
        { reason: 'expired' }
      );
      return Object.freeze({ authenticated: false, reason: 'expired' });
    }
    const user = await this.dependencies.repository.getUser(session.userId);
    if (user?.status !== 'active') {
      return Object.freeze({ authenticated: false, reason: 'user-disabled' });
    }
    if (!allowRenewal) {
      return Object.freeze({
        authenticated: true,
        principal: principal(
          user.userId,
          user.displayName,
          session.roleSnapshot.role,
          session.sessionId
        ),
        csrfToken: await this.dependencies.crypto.deriveCsrf(session.sessionId, sessionSecret),
      });
    }
    const idleExpiresAt = Math.min(
      now + this.dependencies.policy.sessionIdleTtlMs,
      session.absoluteExpiresAt
    );
    const touched = await this.dependencies.repository.touchSession({
      sessionId: session.sessionId,
      expectedLastUsedAt: session.lastUsedAt,
      lastUsedAt: now,
      idleExpiresAt,
    });
    if (!touched) {
      // The read and idle-extension write are deliberately a CAS. A concurrent
      // logout, disable, back-channel logout, or expiry must win and this
      // request must not authenticate from its stale pre-revocation snapshot.
      return Object.freeze({ authenticated: false, reason: 'revoked' });
    }
    return Object.freeze({
      authenticated: true,
      principal: principal(
        user.userId,
        user.displayName,
        session.roleSnapshot.role,
        session.sessionId
      ),
      csrfToken: await this.dependencies.crypto.deriveCsrf(session.sessionId, sessionSecret),
    });
  }

  async verifyCsrf(
    sessionId: HostedSessionId,
    sessionSecret: string,
    presentedCsrf: string
  ): Promise<boolean> {
    const expected = await this.dependencies.crypto.deriveCsrf(sessionId, sessionSecret);
    return this.dependencies.crypto.secureEqual(expected, presentedCsrf);
  }

  async logout(input: {
    readonly sessionSecret: string;
    readonly global: boolean;
    readonly postLogoutRedirectUri: string;
    readonly sourceIp?: string;
  }): Promise<{ readonly redirectUrl: string | null }> {
    const provider = this.oidcProvider();
    const secretHash = await this.hashSessionSecret(input.sessionSecret);
    const session = await this.dependencies.repository.findSessionBySecretHash(secretHash);
    if (session === null) return Object.freeze({ redirectUrl: null });
    await this.dependencies.repository.revokeSession({
      sessionId: session.sessionId,
      now: this.dependencies.now(),
      reason: input.global ? 'provider_logout' : 'local_logout',
    });
    if (!input.global) {
      await this.audit(
        session.userId,
        session.sessionId,
        'auth.logout',
        'success',
        input.sourceIp,
        {}
      );
      return Object.freeze({ redirectUrl: null });
    }
    try {
      const result = await provider.logout({
        session,
        postLogoutRedirectUri: input.postLogoutRedirectUri,
      });
      await this.audit(
        session.userId,
        session.sessionId,
        'auth.oidc.global-logout',
        'success',
        input.sourceIp,
        {}
      );
      return result;
    } catch (error) {
      await this.audit(
        session.userId,
        session.sessionId,
        'auth.oidc.global-logout',
        'failure',
        input.sourceIp,
        {
          localSessionRevoked: true,
          reason:
            error instanceof Error && error.message === 'oidc_provider_unavailable'
              ? 'provider_unavailable'
              : 'provider_failure',
        }
      );
      throw error;
    }
  }

  async backchannelLogout(token: string): Promise<number> {
    const provider = this.oidcProvider();
    const logout = await provider.verifyBackchannelLogout(token);
    const applied = await this.dependencies.repository.applyBackchannelLogout({
      providerId: provider.id,
      issuer: logout.issuer,
      subject: logout.subject,
      providerSessionId: logout.providerSessionId,
      jti: logout.jti,
      expiresAt: logout.expiresAt,
      consumedAt: this.dependencies.now(),
      reason: 'backchannel_logout',
    });
    if (!applied.consumed) throw new Error('oidc_backchannel_logout_replayed');
    await this.audit(null, null, 'auth.oidc.backchannel-logout', 'success', undefined, {
      revoked: applied.revoked,
    });
    return applied.revoked;
  }

  async ensurePersonalOwner(
    operatorId: OperatorId,
    displayName = 'Personal owner'
  ): Promise<HostedPersonalOwnerRecord> {
    const now = this.dependencies.now();
    return this.dependencies.repository.ensurePersonalOwner({
      operatorId,
      user: {
        userId: parseUserId(`usr_${operatorId.replace(/^[^_]+_/, '')}`),
        displayName,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async auditAuthorization(input: {
    readonly principal: HostedPrincipal;
    readonly sourceIp?: string;
    readonly reason: 'permission_denied' | 'origin_invalid' | 'csrf_invalid' | 'workspace_denied';
    readonly method: string;
    readonly permission: string;
  }): Promise<void> {
    await this.audit(
      input.principal.userId,
      input.principal.sessionId,
      'auth.http.authorize',
      'denied',
      input.sourceIp,
      {
        reason: input.reason,
        method: input.method,
        permission: input.permission,
      }
    );
  }

  async auditLocalControl(
    action: string,
    outcome: HostedAuditEvent['outcome'],
    details: HostedAuditEvent['details']
  ): Promise<void> {
    if (!/^auth\.local\.[a-z-]+$/.test(action)) {
      throw new TypeError('hosted_local_control_audit_action_invalid');
    }
    await this.dependencies.repository.appendAudit(
      await this.createLocalControlAuditEvent(action, outcome, details)
    );
  }

  async createLocalControlAuditEvent(
    action: string,
    outcome: HostedAuditEvent['outcome'],
    details: HostedAuditEvent['details']
  ): Promise<HostedAuditEvent> {
    if (!/^auth\.local\.[a-z-]+$/.test(action)) {
      throw new TypeError('hosted_local_control_audit_action_invalid');
    }
    return this.createAuditEvent(null, null, action, outcome, undefined, {
      ...details,
      actor: 'local-cli',
    });
  }

  async auditPersonalAuthentication(input: {
    readonly userId: ReturnType<typeof parseUserId> | null;
    readonly action:
      | 'auth.personal.pair'
      | 'auth.personal.renew'
      | 'auth.personal.logout'
      | 'auth.personal.forget-device';
    readonly outcome: HostedAuditEvent['outcome'];
    readonly sourceIp?: string;
    readonly reason?: string;
  }): Promise<void> {
    await this.audit(input.userId, null, input.action, input.outcome, input.sourceIp, {
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  private async issueSession(input: {
    readonly userId: ReturnType<typeof parseUserId>;
    readonly displayName: string;
    readonly role: HostedRole;
    readonly roleSource: 'oidc-claim' | 'local-cli';
    readonly issuer: string;
    readonly subject: string;
    readonly providerSessionId: string | null;
  }): Promise<IssuedHostedSession> {
    const provider = this.oidcProvider();
    const now = this.dependencies.now();
    const sessionId = parseHostedSessionId(await this.dependencies.crypto.randomId('session'));
    const sessionSecret = await this.dependencies.crypto.randomSecret('session');
    const session: HostedOperatorSessionRecord = Object.freeze({
      sessionId,
      userId: input.userId,
      secretHash: await this.hashSessionSecret(sessionSecret),
      authenticationMethod: 'oidc',
      providerId: provider.id,
      providerIssuer: input.issuer,
      providerSubject: input.subject,
      providerSessionId: input.providerSessionId,
      roleSnapshot: Object.freeze({
        role: input.role,
        source: input.roleSource,
        capturedAt: now,
      }),
      issuedAt: now,
      lastUsedAt: now,
      idleExpiresAt: now + this.dependencies.policy.sessionIdleTtlMs,
      absoluteExpiresAt: now + this.dependencies.policy.sessionAbsoluteTtlMs,
      status: 'active',
      revokedAt: null,
      revocationReason: null,
    });
    await this.dependencies.repository.createSession(session);
    return Object.freeze({
      sessionSecret,
      csrfToken: await this.dependencies.crypto.deriveCsrf(sessionId, sessionSecret),
      principal: principal(input.userId, input.displayName, input.role, sessionId),
      session,
      returnTo: '/',
    });
  }

  private async audit(
    userId: ReturnType<typeof parseUserId> | null,
    sessionId: HostedSessionId | null,
    action: string,
    outcome: HostedAuditEvent['outcome'],
    sourceIp: string | undefined,
    details: HostedAuditEvent['details']
  ): Promise<void> {
    await this.dependencies.repository.appendAudit(
      await this.createAuditEvent(userId, sessionId, action, outcome, sourceIp, details)
    );
  }

  private async createAuditEvent(
    userId: ReturnType<typeof parseUserId> | null,
    sessionId: HostedSessionId | null,
    action: string,
    outcome: HostedAuditEvent['outcome'],
    sourceIp: string | undefined,
    details: HostedAuditEvent['details']
  ): Promise<HostedAuditEvent> {
    return Object.freeze({
      eventId: parseAuditEventId(await this.dependencies.crypto.randomId('audit-event')),
      occurredAt: this.dependencies.now(),
      userId,
      sessionId,
      action,
      outcome,
      sourceIpHash: sourceIp
        ? await this.dependencies.crypto.hashSecret('source-ip', sourceIp)
        : null,
      details: Object.freeze({ ...details }),
    });
  }

  private oidcProvider(): OidcIdentityProvider {
    if (this.dependencies.provider === null) {
      throw new Error('oidc_capability_unavailable');
    }
    return this.dependencies.provider;
  }

  private hashOidcState(state: string): Promise<string> {
    return this.dependencies.crypto.hashSecret('oidc-state', this.bindToRestoreGeneration(state));
  }

  private hashSessionSecret(sessionSecret: string): Promise<string> {
    return this.dependencies.crypto.hashSecret(
      'session',
      this.bindToRestoreGeneration(sessionSecret)
    );
  }

  private bindToRestoreGeneration(value: string): string {
    return `${this.dependencies.policy.restoreGeneration}\0${value}`;
  }
}

export class HostedWorkspaceAccessService {
  constructor(
    private readonly repository: HostedIdentityRepositoryPort,
    private readonly restoreGeneration: number
  ) {
    if (!Number.isSafeInteger(restoreGeneration) || restoreGeneration < 0) {
      throw new TypeError('hosted_workspace_restore_generation_invalid');
    }
  }

  async resolvePublicGrant(userId: ReturnType<typeof parseUserId>, workspaceId: string) {
    return (await this.grants(userId)).find((grant) => grant.workspaceId === workspaceId) ?? null;
  }

  async projectWorkspaceId(userId: ReturnType<typeof parseUserId>, runtimeWorkspaceId: string) {
    return (
      (await this.grants(userId)).find((grant) => grant.runtimeWorkspaceId === runtimeWorkspaceId)
        ?.workspaceId ?? null
    );
  }

  async hasTeamWorkspaceGrant(
    userId: ReturnType<typeof parseUserId>,
    teamIdValue: unknown,
    resolveTeamWorkspaceId: ((teamId: TeamId) => Promise<string | null>) | undefined
  ): Promise<boolean> {
    let teamId: TeamId;
    try {
      teamId = parseTeamId(teamIdValue);
    } catch {
      return false;
    }
    if (resolveTeamWorkspaceId === undefined) return false;
    let runtimeWorkspaceId: string | null;
    try {
      runtimeWorkspaceId = await resolveTeamWorkspaceId(teamId);
    } catch {
      throw new Error('workspace_attribution_unavailable');
    }
    if (runtimeWorkspaceId === null) return false;
    try {
      return (await this.projectWorkspaceId(userId, runtimeWorkspaceId)) !== null;
    } catch {
      throw new Error('identity_storage_unavailable');
    }
  }

  async projectPayload(userId: ReturnType<typeof parseUserId>, payload: unknown): Promise<unknown> {
    const [grants, workspaces] = await Promise.all([
      this.grants(userId),
      this.repository.listWorkspaces(),
    ]);
    return projectHostedPayload(payload, createHostedWorkspaceProjectionScope(grants, workspaces));
  }

  async projectEvent(
    userId: ReturnType<typeof parseUserId>,
    runtimeWorkspaceId: string,
    payload: unknown
  ): Promise<unknown | null> {
    const grants = await this.grants(userId);
    if (!grants.some((grant) => grant.runtimeWorkspaceId === runtimeWorkspaceId)) return null;
    const workspaces = await this.repository.listWorkspaces();
    return projectHostedPayload(payload, createHostedWorkspaceProjectionScope(grants, workspaces));
  }

  private grants(userId: ReturnType<typeof parseUserId>): Promise<readonly HostedWorkspaceGrant[]> {
    return this.repository.listWorkspaceGrants({
      userId,
      grantGeneration: this.restoreGeneration,
    });
  }
}

export function principal(
  userId: ReturnType<typeof parseUserId>,
  displayName: string,
  role: HostedRole,
  sessionId: HostedSessionId | null,
  authenticationMethod: HostedPrincipal['authenticationMethod'] = 'oidc'
): HostedPrincipal {
  return Object.freeze({
    userId,
    displayName,
    role,
    permissions: permissionsForRole(role),
    authenticationMethod,
    sessionId,
  });
}
