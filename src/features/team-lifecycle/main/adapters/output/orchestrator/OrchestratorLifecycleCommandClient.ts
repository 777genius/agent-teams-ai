import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import { type QueryContext, type TeamId, type WorkspaceId } from '@shared/contracts/hosted';

import {
  type HostedLifecycleCommand,
  type HostedLifecycleControlStateRequest,
  type HostedLifecycleControlStateResult,
  type HostedLifecyclePrepareRequest,
  type HostedLifecyclePrepareResult,
  type HostedLifecycleProgressRequest,
  type HostedLifecycleProgressResult,
} from '../../../../contracts/hosted-lifecycle-commands';
import {
  type HostedLifecycleCommandAuthorization,
  type HostedLifecycleCommandAuthorizationResult,
  type HostedLifecycleCommandGatewayExecutionResult,
  type HostedLifecycleCommandGatewayPort,
  type HostedLifecycleCommandRevalidationResult,
  type HostedLifecycleOwnerEffectFence,
} from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import {
  createOrchestratorLifecycleDurableCommand,
  inspectOrchestratorLifecycleSocketIdentity,
  orchestratorLifecycleAuthorizationKey as authorizationKey,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
  parseHostedLifecycleOwnerEffectFence,
  parseOrchestratorMountGeneration,
  parseOrchestratorRestoreGeneration,
  requireOrchestratorLifecycleAuthorityRevision as requireAuthorityRevision,
  sameHostedLifecycleOwnerEffectFence,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
  serializeOrchestratorLifecycleAuthority,
  serializeOrchestratorLifecycleContext,
  validateOrchestratorLifecycleSocketPath,
} from '../../../application/ExecuteHostedLifecycleCommand';

import {
  type OrchestratorLifecycleAuthorizationIssuance,
  OrchestratorLifecycleAuthorizationRegistry,
} from './orchestratorLifecycleAuthorizationRegistry';
import { createOrchestratorLifecycleCommandOutcomeProjector } from './orchestratorLifecycleCommandOutcome';
import {
  type OrchestratorLifecycleOperation,
  type OrchestratorLifecycleReleaseOutcome,
  type OrchestratorLifecycleResponseAuthority,
  parseOrchestratorLifecycleAuthorizationResponse,
  parseOrchestratorLifecycleControlStateResponse,
  parseOrchestratorLifecycleExecutionResponse,
  parseOrchestratorLifecyclePrepareResponse,
  parseOrchestratorLifecycleProgressResponse,
  parseOrchestratorLifecycleReleaseResponse,
  parseOrchestratorLifecycleReplayLookupResponse,
  parseOrchestratorLifecycleResponseAuthority,
  parseOrchestratorLifecycleRevalidationResponse,
} from './OrchestratorLifecycleCommandResponses';
import { requireOrchestratorLifecycleDeadlineRemaining } from './orchestratorLifecycleDeadline';
import {
  createOrchestratorLifecycleExchangeId,
  createOrchestratorLifecycleQueryPayload,
  listenForOrchestratorLifecycleResponseFrame,
  parseOrchestratorLifecycleTimeout,
  requireOrchestratorLifecycleRequestSize,
} from './orchestratorLifecycleResponseFrame';
import {
  createOrchestratorLifecycleSignedRequest,
  isOrchestratorLifecycleGrantFenceCurrent,
  type OrchestratorLifecycleGrantFence,
  parseAuthenticatedOrchestratorLifecycleResponse,
} from './orchestratorLifecycleWireExchange';

import type { OrchestratorLifecycleCommandClientOptions } from './OrchestratorLifecycleCommandClientOptions';
export type { OrchestratorLifecycleCommandClientOptions } from './OrchestratorLifecycleCommandClientOptions';
export class OrchestratorLifecycleCommandClient implements HostedLifecycleCommandGatewayPort {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly restoreGeneration: number;
  private readonly mountGeneration: number;
  private readonly generateExchangeId: () => string;
  private readonly connect: (options: { readonly path: string }) => Socket;
  private readonly ownerBinding: () => OrchestratorLifecycleOwnerBinding | null;
  private readonly ownerProofKey: () => OrchestratorLifecycleOwnerProofKey | null;
  private readonly onOwnerMismatch: () => void;
  private readonly inspectSocketIdentity: (path: string) => Promise<OrchestratorSocketIdentity>;
  private readonly grantFenceForContext: (
    context: QueryContext
  ) => Readonly<OrchestratorLifecycleGrantFence> | null;
  private readonly activeSockets = new Set<Socket>();
  private readonly authorizations = new OrchestratorLifecycleAuthorizationRegistry();
  private ownerEpoch = 0;
  private closed = false;
  constructor(options: OrchestratorLifecycleCommandClientOptions) {
    this.socketPath = validateOrchestratorLifecycleSocketPath(options.socketPath);
    this.timeoutMs = parseOrchestratorLifecycleTimeout(options.timeoutMs);
    this.now = options.now ?? Date.now;
    this.restoreGeneration = parseOrchestratorRestoreGeneration(options.restoreGeneration);
    this.mountGeneration = parseOrchestratorMountGeneration(options.mountGeneration);
    this.ownerBinding = options.ownerBinding;
    this.ownerProofKey = options.ownerProofKey;
    this.onOwnerMismatch = options.onOwnerMismatch ?? (() => undefined);
    this.generateExchangeId =
      options.generateExchangeId ?? (() => `lifecycle-request_${randomUUID().replaceAll('-', '')}`);
    this.connect = options.connect ?? createConnection;
    this.inspectSocketIdentity =
      options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
    this.grantFenceForContext = options.grantFenceForContext ?? (() => null);
  }
  getControlState(
    request: HostedLifecycleControlStateRequest,
    context: QueryContext
  ): Promise<HostedLifecycleControlStateResult> {
    return this.request(
      'control_state',
      (ownerEffectFence) =>
        createOrchestratorLifecycleQueryPayload(
          request,
          context,
          this.restoreGeneration,
          this.mountGeneration,
          ownerEffectFence
        ),
      context,
      request.workspaceId,
      request.teamId,
      (value, authority) =>
        parseOrchestratorLifecycleControlStateResponse(value, authority, request, context)
    );
  }
  prepareProvisioning(
    request: HostedLifecyclePrepareRequest,
    context: QueryContext
  ): Promise<HostedLifecyclePrepareResult> {
    return this.request(
      'prepare_provisioning',
      (ownerEffectFence) =>
        createOrchestratorLifecycleQueryPayload(
          request,
          context,
          this.restoreGeneration,
          this.mountGeneration,
          ownerEffectFence
        ),
      context,
      request.workspaceId,
      request.teamId,
      (value, authority) =>
        parseOrchestratorLifecyclePrepareResponse(value, authority, request, context)
    );
  }
  getProvisioningStatus(
    request: HostedLifecycleProgressRequest,
    context: QueryContext
  ): Promise<HostedLifecycleProgressResult> {
    return this.request(
      'get_provisioning_status',
      (ownerEffectFence) =>
        createOrchestratorLifecycleQueryPayload(
          request,
          context,
          this.restoreGeneration,
          this.mountGeneration,
          ownerEffectFence
        ),
      context,
      request.workspaceId,
      request.teamId,
      (value, authority) =>
        parseOrchestratorLifecycleProgressResponse(value, authority, request, context)
    );
  }
  authorize(
    command: HostedLifecycleCommand,
    context: QueryContext
  ): Promise<HostedLifecycleCommandAuthorizationResult> {
    return this.request(
      'authorize',
      (ownerEffectFence) =>
        Object.freeze({
          command,
          context: serializeOrchestratorLifecycleContext(context),
          authority: serializeOrchestratorLifecycleAuthority(
            context,
            command.workspaceId,
            command.teamId,
            this.restoreGeneration,
            this.mountGeneration,
            command.expectedRevision,
            ownerEffectFence
          ),
        }),
      context,
      command.workspaceId,
      command.teamId,
      (value, authority, ownerBinding) => {
        const result = parseOrchestratorLifecycleAuthorizationResponse(
          value,
          command,
          context,
          this.restoreGeneration,
          this.mountGeneration,
          authority.ownerEffectFence
        );
        requireAuthorityRevision(
          authority,
          result.kind === 'authorized'
            ? result.authorization.resourceRevision
            : result.kind === 'conflict'
              ? result.currentRevision
              : null
        );
        if (result.kind === 'authorized') {
          this.authorizations.remember(result.authorization, ownerBinding);
        }
        return result;
      }
    );
  }
  revalidate(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandRevalidationResult> {
    const issued = this.currentIssuance(authorization);
    if (issued === null) {
      return Promise.resolve({
        kind: 'conflict',
        reason: 'authorization_changed',
        currentRevision: null,
      });
    }
    return this.request(
      'revalidate',
      (ownerEffectFence) =>
        Object.freeze({
          command,
          authorization,
          context: serializeOrchestratorLifecycleContext(context),
          authority: serializeOrchestratorLifecycleAuthority(
            context,
            command.workspaceId,
            command.teamId,
            this.restoreGeneration,
            this.mountGeneration,
            authorization.resourceRevision,
            ownerEffectFence
          ),
        }),
      context,
      command.workspaceId,
      command.teamId,
      (value, authority, ownerBinding) => {
        const result = parseOrchestratorLifecycleRevalidationResponse(
          value,
          command,
          context,
          this.restoreGeneration,
          this.mountGeneration,
          authority.ownerEffectFence
        );
        requireAuthorityRevision(
          authority,
          result.kind === 'valid'
            ? result.authorization.resourceRevision
            : result.kind === 'conflict'
              ? result.currentRevision
              : null
        );
        if (
          result.kind === 'valid' &&
          (!this.authorizationIsCurrent(result.authorization) ||
            !sameOrchestratorLifecycleOwnerBinding(issued.ownerBinding, ownerBinding))
        ) {
          this.authorizations.retire(authorizationKey(authorization));
          return Object.freeze({
            kind: 'conflict' as const,
            reason: 'authorization_changed' as const,
            currentRevision: null,
          });
        }
        if (result.kind !== 'valid') {
          this.authorizations.retire(authorizationKey(authorization));
        }
        return result;
      },
      issued.ownerBinding
    );
  }
  async execute(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandGatewayExecutionResult> {
    const issued = this.currentIssuance(authorization);
    if (issued === null) {
      return Object.freeze({ kind: 'unavailable', retryAfterMs: null });
    }
    const grantFence = this.grantFenceForContext(context);
    if (grantFence === null) {
      return Object.freeze({ kind: 'unavailable', retryAfterMs: null });
    }
    let ownerEffectFence: HostedLifecycleOwnerEffectFence;
    try {
      ownerEffectFence = parseHostedLifecycleOwnerEffectFence(grantFence.ownerEffectFence);
      if (
        !sameHostedLifecycleOwnerEffectFence(ownerEffectFence, authorization.ownerEffectFence) ||
        !(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))
      ) {
        return Object.freeze({ kind: 'unavailable', retryAfterMs: null });
      }
    } catch {
      return Object.freeze({ kind: 'unavailable', retryAfterMs: null });
    }
    const durableCommand = createOrchestratorLifecycleDurableCommand(
      command,
      context,
      this.restoreGeneration,
      this.mountGeneration,
      ownerEffectFence
    );
    const requestPayload = Object.freeze({
      command,
      authorization,
      durableCommand,
      context: serializeOrchestratorLifecycleContext(context),
      authority: serializeOrchestratorLifecycleAuthority(
        context,
        command.workspaceId,
        command.teamId,
        this.restoreGeneration,
        this.mountGeneration,
        authorization.resourceRevision,
        ownerEffectFence
      ),
    });
    const outcomes = createOrchestratorLifecycleCommandOutcomeProjector(
      command,
      authorization,
      this.authorizations
    );
    const lookupReplay = () =>
      this.request(
        'replay_lookup',
        () => requestPayload,
        context,
        command.workspaceId,
        command.teamId,
        (value, authority, ownerBinding) =>
          outcomes.validate(
            parseOrchestratorLifecycleReplayLookupResponse(
              value,
              command,
              context,
              this.restoreGeneration,
              this.mountGeneration,
              durableCommand
            ),
            authority,
            ownerBinding
          ),
        issued.ownerBinding,
        grantFence,
        ownerEffectFence
      );
    const replay = await lookupReplay();
    const replayResult = outcomes.toGatewayOutcome(replay);
    if (replayResult !== null) return replayResult;
    if (!this.authorizationIsCurrent(authorization)) {
      return Object.freeze({ kind: 'unavailable', retryAfterMs: null });
    }
    let executed: ReturnType<typeof parseOrchestratorLifecycleExecutionResponse>;
    try {
      executed = await this.request(
        'execute',
        () => requestPayload,
        context,
        command.workspaceId,
        command.teamId,
        (value, authority, ownerBinding) =>
          outcomes.validate(
            parseOrchestratorLifecycleExecutionResponse(
              value,
              command,
              context,
              this.restoreGeneration,
              this.mountGeneration,
              durableCommand
            ),
            authority,
            ownerBinding
          ),
        issued.ownerBinding,
        grantFence,
        ownerEffectFence
      );
    } catch {
      // The execute write is an uncertainty boundary. Never resend it: ask the durable owner for
      // the exact ledger entry once, and report success only from a persisted settled postimage.
      if (!this.authorizationIsCurrent(authorization) || context.signal.aborted) {
        return Object.freeze({ kind: 'operator_required' });
      }
      try {
        const recovered = await lookupReplay();
        return (
          outcomes.toGatewayOutcome(recovered) ??
          Object.freeze({ kind: 'operator_required' as const })
        );
      } catch {
        return Object.freeze({ kind: 'operator_required' as const });
      }
    }
    return (
      outcomes.toGatewayOutcome(executed) ?? Object.freeze({ kind: 'operator_required' as const })
    );
  }
  async release(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<OrchestratorLifecycleReleaseOutcome> {
    const key = authorizationKey(authorization);
    const issued = this.authorizations.issued(authorization);
    if (issued === null) {
      throw new Error('orchestrator-lifecycle-release-authorization-unavailable');
    }
    const grantFence = this.grantFenceForContext(context);
    if (grantFence === null) {
      throw new Error('orchestrator-lifecycle-release-grant-fence-unavailable');
    }
    const releaseOwnerEffectFence = parseHostedLifecycleOwnerEffectFence(
      grantFence.ownerEffectFence
    );
    if (
      !sameHostedLifecycleOwnerEffectFence(releaseOwnerEffectFence, authorization.ownerEffectFence)
    ) {
      throw new Error('orchestrator-lifecycle-release-grant-fence-changed');
    }
    const cleanupController = new AbortController();
    const cleanupDeadline = this.now() + this.timeoutMs;
    if (!Number.isSafeInteger(cleanupDeadline)) {
      throw new Error('orchestrator-lifecycle-release-deadline-invalid');
    }
    const cleanupContext = Object.freeze({
      ...context,
      signal: cleanupController.signal,
      deadlineAtMs: cleanupDeadline,
    });
    const outcome = await this.request(
      'release',
      (ownerEffectFence) =>
        Object.freeze({
          command,
          authorization,
          context: serializeOrchestratorLifecycleContext(cleanupContext),
          authority: serializeOrchestratorLifecycleAuthority(
            cleanupContext,
            command.workspaceId,
            command.teamId,
            this.restoreGeneration,
            this.mountGeneration,
            authorization.resourceRevision,
            ownerEffectFence
          ),
        }),
      cleanupContext,
      command.workspaceId,
      command.teamId,
      (value, authority) =>
        parseOrchestratorLifecycleReleaseResponse(
          value,
          authority,
          command,
          cleanupContext,
          this.restoreGeneration,
          this.mountGeneration,
          authorization
        ),
      issued.ownerBinding,
      grantFence,
      releaseOwnerEffectFence
    );
    if (outcome.kind === 'released' || outcome.kind === 'already_released') {
      this.authorizations.forget(key);
    }
    return outcome;
  }
  ownerLost(): void {
    this.ownerEpoch += 1;
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    this.authorizations.clear();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ownerLost();
  }
  private authorizationIsCurrent(authorization: HostedLifecycleCommandAuthorization): boolean {
    return this.currentIssuance(authorization) !== null;
  }
  private currentIssuance(
    authorization: HostedLifecycleCommandAuthorization
  ): OrchestratorLifecycleAuthorizationIssuance | null {
    return this.authorizations.current(authorization, this.ownerBinding());
  }
  private async request<Value>(
    operation: OrchestratorLifecycleOperation,
    message: (
      ownerEffectFence: HostedLifecycleOwnerEffectFence
    ) => Readonly<Record<string, unknown>>,
    context: QueryContext,
    workspaceId: WorkspaceId,
    teamId: TeamId,
    parse: (
      value: unknown,
      authority: OrchestratorLifecycleResponseAuthority,
      ownerBinding: OrchestratorLifecycleOwnerBinding
    ) => Value,
    requiredOwnerBinding?: OrchestratorLifecycleOwnerBinding,
    requiredGrantFence?: Readonly<OrchestratorLifecycleGrantFence>,
    requiredOwnerEffectFence?: HostedLifecycleOwnerEffectFence
  ): Promise<Value> {
    const signal = context.signal;
    if (this.closed || signal.aborted) {
      return Promise.reject(new Error('orchestrator-lifecycle-client-unavailable'));
    }
    // Capture owner identity before the first asynchronous grant check. Otherwise an owner-loss
    // notification that lands while revalidation is pending can be mistaken for the beginning of
    // a new, still-valid epoch when the injected binding reader continues to expose stale bytes.
    const currentOwnerBindingAtStart = this.ownerBinding();
    const ownerBinding = requiredOwnerBinding ?? currentOwnerBindingAtStart;
    const ownerProofKey = this.ownerProofKey();
    const ownerEpoch = this.ownerEpoch;
    if (
      ownerBinding === null ||
      ownerProofKey === null ||
      currentOwnerBindingAtStart === null ||
      !sameOrchestratorLifecycleOwnerBinding(currentOwnerBindingAtStart, ownerBinding)
    ) {
      throw new Error('orchestrator-lifecycle-owner-unavailable');
    }
    let deadlineRemaining = requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
    const grantFence = requiredGrantFence ?? this.grantFenceForContext(context);
    if (grantFence === null) {
      throw new Error('orchestrator-lifecycle-grant-fence-invalid');
    }
    const currentOwnerEffectFence = parseHostedLifecycleOwnerEffectFence(
      grantFence.ownerEffectFence
    );
    const ownerEffectFence =
      requiredOwnerEffectFence === undefined
        ? currentOwnerEffectFence
        : parseHostedLifecycleOwnerEffectFence(requiredOwnerEffectFence);
    if (!sameHostedLifecycleOwnerEffectFence(currentOwnerEffectFence, ownerEffectFence)) {
      throw new Error('orchestrator-lifecycle-grant-fence-invalid');
    }
    if (!(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))) {
      throw new Error('orchestrator-lifecycle-grant-fence-invalid');
    }
    const ownerBindingBeforeInspection = this.ownerBinding();
    if (
      this.closed ||
      signal.aborted ||
      this.ownerEpoch !== ownerEpoch ||
      ownerBindingBeforeInspection === null ||
      !sameOrchestratorLifecycleOwnerBinding(ownerBindingBeforeInspection, ownerBinding) ||
      this.ownerProofKey() !== ownerProofKey
    ) {
      throw new Error('orchestrator-lifecycle-client-unavailable');
    }
    const exchangeId = createOrchestratorLifecycleExchangeId(this.generateExchangeId);
    const liveSocketIdentity = await this.inspectSocketIdentity(this.socketPath);
    deadlineRemaining = requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
    const currentOwnerBinding = this.ownerBinding();
    if (
      this.closed ||
      signal.aborted ||
      this.ownerEpoch !== ownerEpoch ||
      currentOwnerBinding === null ||
      !sameOrchestratorLifecycleOwnerBinding(currentOwnerBinding, ownerBinding) ||
      this.ownerProofKey() !== ownerProofKey
    ) {
      throw new Error('orchestrator-lifecycle-client-unavailable');
    }
    if (!sameOrchestratorSocketIdentity(liveSocketIdentity, ownerBinding.socketIdentity)) {
      this.ownerLost();
      this.onOwnerMismatch();
      throw new Error('orchestrator-lifecycle-socket-identity-changed');
    }
    const signedRequest = createOrchestratorLifecycleSignedRequest({
      key: ownerProofKey,
      context,
      ownerBinding,
      exchangeId,
      operation,
      workspaceId,
      teamId,
      ownerEffectFence,
      payload: message(ownerEffectFence),
    });
    const body = signedRequest.body;
    requireOrchestratorLifecycleRequestSize(body);
    return new Promise<Value>((resolve, reject) => {
      const socket = this.connect({ path: this.socketPath });
      this.activeSockets.add(socket);
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (error: unknown, value?: Value): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        signal.removeEventListener('abort', abort);
        this.activeSockets.delete(socket);
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(value as Value);
      };
      const abort = (): void => finish(new Error('orchestrator-lifecycle-request-cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket.setEncoding('utf8');
      socket.setTimeout(Math.min(this.timeoutMs, deadlineRemaining), () =>
        finish(new Error('orchestrator-lifecycle-request-timeout'))
      );
      deadlineTimer = setTimeout(
        () => finish(new Error('orchestrator-lifecycle-request-deadline-exceeded')),
        deadlineRemaining
      );
      deadlineTimer.unref?.();
      socket.once('connect', () => {
        void (async () => {
          requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
          if (!(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))) {
            throw new Error('orchestrator-lifecycle-grant-fence-changed');
          }
          requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
          const finalOwnerBinding = this.ownerBinding();
          if (
            this.closed ||
            signal.aborted ||
            this.ownerEpoch !== ownerEpoch ||
            finalOwnerBinding === null ||
            !sameOrchestratorLifecycleOwnerBinding(finalOwnerBinding, ownerBinding) ||
            this.ownerProofKey() !== ownerProofKey
          ) {
            throw new Error('orchestrator-lifecycle-client-unavailable');
          }
          // The owner admits only after one complete frame and EOF. A write-side half-close makes
          // trailing or delayed request bytes impossible after this authenticated frame.
          socket.end(body);
        })().catch((error) => finish(error));
      });
      socket.once('error', () => finish(new Error('orchestrator-lifecycle-unavailable')));
      const acceptResponse = async (serializedEnvelope: string): Promise<void> => {
        try {
          requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
          let authenticatedResponse: ReturnType<
            typeof parseAuthenticatedOrchestratorLifecycleResponse
          >;
          try {
            authenticatedResponse = parseAuthenticatedOrchestratorLifecycleResponse({
              serializedEnvelope,
              exchangeId,
              operation,
              ownerBinding,
              ownerEffectFence,
              responseProvenance: signedRequest.responseProvenance,
              ownerProofKey,
            });
          } catch (error) {
            this.ownerLost();
            this.onOwnerMismatch();
            finish(
              error instanceof Error ? error : new Error('orchestrator-lifecycle-response-invalid')
            );
            return;
          }
          const { envelope, ownerBinding: responseOwnerBinding } = authenticatedResponse;
          // The response proof binds the connected peer to the readiness-acquired owner session.
          const connectedSocketIdentity = await this.inspectSocketIdentity(this.socketPath).catch(
            () => null
          );
          requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
          const currentBinding = this.ownerBinding();
          if (
            this.closed ||
            signal.aborted ||
            settled ||
            this.ownerEpoch !== ownerEpoch ||
            currentBinding === null ||
            !sameOrchestratorLifecycleOwnerBinding(currentBinding, ownerBinding) ||
            this.ownerProofKey() !== ownerProofKey
          ) {
            finish(new Error('orchestrator-lifecycle-client-unavailable'));
            return;
          }
          if (
            connectedSocketIdentity === null ||
            !sameOrchestratorSocketIdentity(connectedSocketIdentity, ownerBinding.socketIdentity)
          ) {
            this.ownerLost();
            this.onOwnerMismatch();
            finish(new Error('orchestrator-lifecycle-socket-identity-changed'));
            return;
          }
          const authority = parseOrchestratorLifecycleResponseAuthority(
            envelope.authority,
            context,
            workspaceId,
            teamId,
            this.restoreGeneration,
            this.mountGeneration,
            ownerEffectFence
          );
          if (!(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))) {
            finish(new Error('orchestrator-lifecycle-grant-fence-changed'));
            return;
          }
          // Grant revalidation is asynchronous. Ownership can be revoked while it is pending,
          // and the socket close callback is intentionally suppressed while this response is
          // being validated. Recheck the captured owner immediately before accepting success.
          const finalResponseOwnerBinding = this.ownerBinding();
          if (
            this.closed ||
            signal.aborted ||
            settled ||
            this.ownerEpoch !== ownerEpoch ||
            finalResponseOwnerBinding === null ||
            !sameOrchestratorLifecycleOwnerBinding(finalResponseOwnerBinding, ownerBinding) ||
            this.ownerProofKey() !== ownerProofKey
          ) {
            finish(new Error('orchestrator-lifecycle-client-unavailable'));
            return;
          }
          const finalSocketIdentity = await this.inspectSocketIdentity(this.socketPath).catch(
            () => null
          );
          requireOrchestratorLifecycleDeadlineRemaining(context, this.now);
          const acceptedResponseOwnerBinding = this.ownerBinding();
          if (
            this.closed ||
            signal.aborted ||
            settled ||
            this.ownerEpoch !== ownerEpoch ||
            acceptedResponseOwnerBinding === null ||
            !sameOrchestratorLifecycleOwnerBinding(acceptedResponseOwnerBinding, ownerBinding) ||
            this.ownerProofKey() !== ownerProofKey
          ) {
            finish(new Error('orchestrator-lifecycle-client-unavailable'));
            return;
          }
          if (
            finalSocketIdentity === null ||
            !sameOrchestratorSocketIdentity(finalSocketIdentity, ownerBinding.socketIdentity)
          ) {
            this.ownerLost();
            this.onOwnerMismatch();
            finish(new Error('orchestrator-lifecycle-socket-identity-changed'));
            return;
          }
          // Socket inspection is asynchronous. Revalidate the durable browser-grant/team-identity
          // fence after it, then synchronously fence the captured owner epoch before publishing
          // the durable result.
          if (!(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))) {
            finish(new Error('orchestrator-lifecycle-grant-fence-changed'));
            return;
          }
          const terminalResponseOwnerBinding = this.ownerBinding();
          if (
            this.closed ||
            signal.aborted ||
            settled ||
            this.ownerEpoch !== ownerEpoch ||
            terminalResponseOwnerBinding === null ||
            !sameOrchestratorLifecycleOwnerBinding(terminalResponseOwnerBinding, ownerBinding) ||
            this.ownerProofKey() !== ownerProofKey
          ) {
            finish(new Error('orchestrator-lifecycle-client-unavailable'));
            return;
          }
          finish(null, parse(envelope.payload, authority, responseOwnerBinding));
        } catch {
          finish(new Error('orchestrator-lifecycle-response-invalid'));
        }
      };
      listenForOrchestratorLifecycleResponseFrame(socket, {
        isSettled: () => settled,
        acceptResponse,
        finish,
      });
    });
  }
}
