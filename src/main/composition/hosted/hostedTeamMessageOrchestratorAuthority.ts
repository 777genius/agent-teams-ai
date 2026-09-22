import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
// eslint-disable-next-line no-restricted-imports -- Public strict external-owner frame parser.
import { parseStrictOrchestratorJsonFrame } from '@features/team-lifecycle/main/hosted';
import { type CreateHostedTeamMessageRouteContributionDependencies } from '@features/team-message-delivery/main';

import {
  inspectOrchestratorLifecycleSocketIdentity,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  parseOrchestratorLifecycleOwnerBinding,
  sameOrchestratorLifecycleOwnerBinding,
} from './hostedLifecycleOrchestratorReadiness';

import type { TeamLifecycleCommandMutationLease } from './teamLifecycleCommandComposition';
import type { QueryContext, WorkspaceId } from '@shared/contracts/hosted';

const PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1';
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type HostedOwnerBoundMutationOperation =
  | 'message_persist'
  | 'message_deliver'
  | 'task_mutate';
type HostedTeamMessageMutationAuthorityPort = NonNullable<
  CreateHostedTeamMessageRouteContributionDependencies['writer']
>;
type HostedMutationGrantFence = Parameters<
  HostedTeamMessageMutationAuthorityPort['bindGrantFence']
>[1];
type SendHostedTeamMessageCommand = Parameters<
  HostedTeamMessageMutationAuthorityPort['persistMessage']
>[0];
type HostedMessagePersistenceAdmissionResult = Awaited<
  ReturnType<HostedTeamMessageMutationAuthorityPort['persistMessage']>
>;
type HostedMessageRuntimeDeliveryRequest = Parameters<
  HostedTeamMessageMutationAuthorityPort['deliverPersistedMessage']
>[0];
type HostedMessageRuntimeDeliveryResult = Awaited<
  ReturnType<HostedTeamMessageMutationAuthorityPort['deliverPersistedMessage']>
>;
type HostedMessagePersistenceReceipt = Extract<
  HostedMessagePersistenceAdmissionResult,
  { readonly kind: 'persisted' }
>['receipt'];

function parseHostedMessageId(value: unknown): HostedMessagePersistenceReceipt['messageId'] {
  if (typeof value !== 'string' || !/^message_[0-9a-f]{32}$/.test(value)) {
    throw new TypeError('hosted-team-message-id-invalid');
  }
  return value as HostedMessagePersistenceReceipt['messageId'];
}

function parseHostedClientMessageId(
  value: unknown
): HostedMessagePersistenceReceipt['clientMessageId'] {
  if (
    typeof value !== 'string' ||
    !/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)
  ) {
    throw new TypeError('hosted-team-message-client-id-invalid');
  }
  return value as HostedMessagePersistenceReceipt['clientMessageId'];
}

export interface HostedTeamMessageOrchestratorAuthorityOptions {
  readonly lease: TeamLifecycleCommandMutationLease;
  readonly ownerProofKey: OrchestratorLifecycleOwnerProofKey;
  readonly mountBinding: Readonly<{
    workspaceId: WorkspaceId;
    mountGeneration: number;
    declaredRootHash: string;
  }>;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly restoreGeneration: number;
  readonly connect?: (path: string) => Socket;
  readonly inspectSocketIdentity?: (
    path: string
  ) => Promise<OrchestratorLifecycleOwnerBinding['socketIdentity']>;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sameSocketIdentity(
  left: OrchestratorLifecycleOwnerBinding['socketIdentity'],
  right: OrchestratorLifecycleOwnerBinding['socketIdentity']
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

function sameActiveTeamIdentity(
  left: TeamIdentityRecord,
  right: TeamIdentityRecord | null
): boolean {
  return (
    right !== null &&
    right.state === 'active' &&
    right.teamId === left.teamId &&
    right.legacyKey === left.legacyKey &&
    right.directoryFingerprint === left.directoryFingerprint &&
    right.workspaceBinding?.workspaceId === left.workspaceBinding?.workspaceId &&
    right.workspaceBinding?.generation === left.workspaceBinding?.generation &&
    right.adoptionIntentId === left.adoptionIntentId &&
    right.identityChecksum === left.identityChecksum &&
    right.createdAt === left.createdAt &&
    right.activatedAt === left.activatedAt &&
    right.tombstonedAt === left.tombstonedAt
  );
}

function proof(
  key: OrchestratorLifecycleOwnerProofKey,
  operation: HostedOwnerBoundMutationOperation,
  direction: 'request' | 'response',
  envelope: Readonly<Record<string, unknown>>
): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${PROOF_DOMAIN}\u0000${operation}\u0000${direction}\u0000${JSON.stringify(envelope)}`)
    .digest('hex');
}

function proofMatches(expected: string, actual: unknown): boolean {
  return (
    typeof actual === 'string' &&
    /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
  );
}

function unavailable(): HostedMessagePersistenceAdmissionResult {
  return Object.freeze({ kind: 'unavailable' });
}

function operatorRequired(): HostedMessageRuntimeDeliveryResult {
  return Object.freeze({ kind: 'operator_required' });
}

/**
 * Mutation-only client borrowing the lifecycle owner's live Unix socket lease. It never creates a
 * second readiness connection and never retries an ambiguous runtime effect.
 */
export class HostedTeamMessageOrchestratorAuthority implements HostedTeamMessageMutationAuthorityPort {
  private readonly connect: (path: string) => Socket;
  private readonly inspectSocketIdentity: (
    path: string
  ) => Promise<OrchestratorLifecycleOwnerBinding['socketIdentity']>;
  private readonly timeoutMs: number;
  private readonly activeSockets = new Set<Socket>();
  private readonly grantFences = new WeakMap<QueryContext, HostedMutationGrantFence>();
  private readonly observedBindings = new Map<
    TeamIdentityRecord['teamId'],
    NonNullable<TeamIdentityRecord['workspaceBinding']>
  >();
  private closed = false;
  private epoch = 0;

  constructor(private readonly options: HostedTeamMessageOrchestratorAuthorityOptions) {
    if (
      !Number.isSafeInteger(options.restoreGeneration) ||
      options.restoreGeneration < 0 ||
      !isRecord(options.mountBinding) ||
      !Number.isSafeInteger(options.mountBinding.mountGeneration) ||
      options.mountBinding.mountGeneration < 1 ||
      !/^[0-9a-f]{64}$/.test(options.mountBinding.declaredRootHash) ||
      typeof options.teamIdentities?.getTeamIdentity !== 'function' ||
      !Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1
    ) {
      throw new TypeError('hosted-team-message-orchestrator-options-invalid');
    }
    this.connect = options.connect ?? connectSocket;
    this.inspectSocketIdentity =
      options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void {
    const ownerEffectFence = fence?.ownerEffectFence;
    if (
      this.closed ||
      typeof fence?.revalidate !== 'function' ||
      !isRecord(ownerEffectFence) ||
      !hasExactKeys(ownerEffectFence, ['grantRevision', 'identityChecksum']) ||
      typeof ownerEffectFence.grantRevision !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(ownerEffectFence.grantRevision) ||
      typeof ownerEffectFence.identityChecksum !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(ownerEffectFence.identityChecksum)
    ) {
      throw new Error('hosted-team-message-grant-fence-invalid');
    }
    this.grantFences.set(
      context,
      Object.freeze({
        ownerEffectFence: Object.freeze({
          grantRevision: ownerEffectFence.grantRevision,
          identityChecksum: ownerEffectFence.identityChecksum,
        }),
        revalidate: fence.revalidate.bind(fence),
      })
    );
  }

  async persistMessage(
    command: SendHostedTeamMessageCommand,
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult> {
    try {
      const payload = await this.exchangeOwnerMutation(
        'message_persist',
        command,
        command.teamId,
        context
      );
      return this.parsePersistence(payload, command);
    } catch {
      return unavailable();
    }
  }

  async deliverPersistedMessage(
    request: HostedMessageRuntimeDeliveryRequest,
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult> {
    try {
      const payload = await this.exchangeOwnerMutation(
        'message_deliver',
        request,
        request.teamId,
        context
      );
      if (!isRecord(payload) || payload.schemaVersion !== 2) return operatorRequired();
      if (
        (payload.kind === 'delivered' ||
          payload.kind === 'pending' ||
          payload.kind === 'operator_required') &&
        hasExactKeys(payload, ['schemaVersion', 'kind'])
      ) {
        return Object.freeze({ kind: payload.kind });
      }
      if (
        payload.kind === 'unavailable' &&
        hasExactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs']) &&
        (payload.retryAfterMs === null ||
          (Number.isSafeInteger(payload.retryAfterMs) && (payload.retryAfterMs as number) > 0))
      ) {
        return payload.retryAfterMs === null
          ? Object.freeze({ kind: 'unavailable' })
          : Object.freeze({
              kind: 'unavailable',
              retryAfterMs: payload.retryAfterMs as number,
            });
      }
      return operatorRequired();
    } catch {
      return operatorRequired();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.revokeSockets();
  }

  private parsePersistence(
    payload: unknown,
    command: SendHostedTeamMessageCommand
  ): HostedMessagePersistenceAdmissionResult {
    if (!isRecord(payload) || payload.schemaVersion !== 2) return unavailable();
    if (
      (payload.kind === 'persisted' || payload.kind === 'idempotent_replay') &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'receipt']) &&
      isRecord(payload.receipt) &&
      hasExactKeys(payload.receipt, [
        'schemaVersion',
        'teamId',
        'messageId',
        'clientMessageId',
        'persistence',
      ]) &&
      payload.receipt.schemaVersion === 1 &&
      payload.receipt.teamId === command.teamId &&
      payload.receipt.clientMessageId === command.clientMessageId &&
      payload.receipt.persistence === 'durable'
    ) {
      const receipt = Object.freeze({
        schemaVersion: 1 as const,
        teamId: command.teamId,
        messageId: parseHostedMessageId(payload.receipt.messageId),
        clientMessageId: parseHostedClientMessageId(payload.receipt.clientMessageId),
        persistence: 'durable' as const,
      });
      return Object.freeze({ kind: payload.kind, receipt });
    }
    if (
      payload.kind === 'conflict' &&
      payload.reason === 'idempotency_mismatch' &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'reason'])
    ) {
      return Object.freeze({
        kind: 'conflict',
        reason: 'idempotency_mismatch',
      });
    }
    if (payload.kind === 'not_found' && hasExactKeys(payload, ['schemaVersion', 'kind'])) {
      return Object.freeze({ kind: 'not_found' });
    }
    if (
      payload.kind === 'unavailable' &&
      hasExactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs']) &&
      (payload.retryAfterMs === null ||
        (Number.isSafeInteger(payload.retryAfterMs) && (payload.retryAfterMs as number) > 0))
    ) {
      return payload.retryAfterMs === null
        ? unavailable()
        : Object.freeze({
            kind: 'unavailable',
            retryAfterMs: payload.retryAfterMs as number,
          });
    }
    return unavailable();
  }

  async exchangeOwnerMutation(
    operation: HostedOwnerBoundMutationOperation,
    payload: object,
    teamId: SendHostedTeamMessageCommand['teamId'],
    context: QueryContext
  ): Promise<unknown> {
    const epoch = this.epoch;
    this.assertActive(epoch, context);
    const grantFence = this.grantFences.get(context);
    if (grantFence === undefined || !(await grantFence.revalidate())) throw new Error();
    const ownerBinding = this.options.lease.currentBinding();
    if (ownerBinding === null) throw new Error();
    const teamIdentity = await this.readActiveIdentity(teamId);
    this.assertCurrentOwner(epoch, context, ownerBinding);
    const ownerEffectFence = grantFence.ownerEffectFence;
    if (
      teamIdentity === null ||
      ownerEffectFence === undefined ||
      teamIdentity.identityChecksum !== ownerEffectFence.identityChecksum
    ) {
      throw new Error();
    }
    const authority = Object.freeze({
      actorId: context.actorId,
      deploymentId: context.deploymentId,
      bootId: context.bootId,
      restoreGeneration: this.options.restoreGeneration,
      workspaceId: this.options.mountBinding.workspaceId,
      mountBinding: Object.freeze({
        mountGeneration: this.options.mountBinding.mountGeneration,
        declaredRootHash: this.options.mountBinding.declaredRootHash,
      }),
      teamId,
      ownerEffectFence,
    });
    const unsignedRequest = Object.freeze({
      schemaVersion: 2 as const,
      exchangeId: `${operation === 'task_mutate' ? 'task' : 'message'}-request_${randomBytes(16).toString('hex')}`,
      operation,
      ownerBinding,
      authority,
      payload,
    });
    const body = `${JSON.stringify({
      ...unsignedRequest,
      ownerProof: proof(this.options.ownerProofKey, operation, 'request', unsignedRequest),
    })}\n`;
    if (Buffer.byteLength(body) > MAXIMUM_MESSAGE_BYTES) throw new Error();
    // Team identity is the last potentially attacker-influenced await before this fresh socket
    // fence. There is no async gap between the fence and connection admission.
    const beforeIdentity = await this.inspectCurrentSocketIdentity();
    this.assertCurrentOwner(epoch, context, ownerBinding);
    if (!sameSocketIdentity(beforeIdentity, ownerBinding.socketIdentity)) {
      this.ownerMismatch();
      throw new Error();
    }
    const response = await this.request(body, context, epoch, ownerBinding, grantFence);
    this.assertCurrentOwner(epoch, context, ownerBinding);
    if (
      !isRecord(response) ||
      !hasExactKeys(response, [
        'schemaVersion',
        'exchangeId',
        'operation',
        'ownerBinding',
        'authority',
        'payload',
        'ownerProof',
      ]) ||
      response.schemaVersion !== 2 ||
      response.exchangeId !== unsignedRequest.exchangeId ||
      response.operation !== operation ||
      !isRecord(response.authority) ||
      JSON.stringify(response.authority) !== JSON.stringify(authority)
    ) {
      this.ownerMismatch();
      throw new Error();
    }
    const responseBinding = this.parseResponseOwnerBinding(response.ownerBinding);
    if (!sameOrchestratorLifecycleOwnerBinding(ownerBinding, responseBinding)) {
      this.ownerMismatch();
      throw new Error();
    }
    const unsignedResponse = {
      schemaVersion: response.schemaVersion,
      exchangeId: response.exchangeId,
      operation: response.operation,
      ownerBinding: response.ownerBinding,
      authority: response.authority,
      payload: response.payload,
    };
    if (
      !proofMatches(
        proof(this.options.ownerProofKey, operation, 'response', unsignedResponse),
        response.ownerProof
      )
    ) {
      this.ownerMismatch();
      throw new Error();
    }
    // The authenticated owner response is the durable-effect boundary. Revalidate the exact
    // browser grant and durable team identity together immediately after it, then retain a final
    // grant fence after socket inspection so a revocation cannot win an intervening async race.
    const [postEffectGrantValid, currentTeamIdentity] = await Promise.all([
      grantFence.revalidate(),
      this.readActiveIdentity(teamId),
    ]);
    this.assertCurrentOwner(epoch, context, ownerBinding);
    // A grant revocation or team tombstone/rebind invalidates this result, not the shared
    // lifecycle-owner lease.
    if (
      !postEffectGrantValid ||
      !sameActiveTeamIdentity(teamIdentity, currentTeamIdentity) ||
      currentTeamIdentity?.identityChecksum !== ownerEffectFence.identityChecksum
    ) {
      throw new Error();
    }
    // Team identity resolution is complete. Fence the socket after its final attacker-influenced
    // await, then make the exact grant the last asynchronous acceptance check.
    const afterIdentity = await this.inspectCurrentSocketIdentity();
    this.assertCurrentOwner(epoch, context, ownerBinding);
    if (!sameSocketIdentity(afterIdentity, ownerBinding.socketIdentity)) {
      this.ownerMismatch();
      throw new Error();
    }
    if (!(await grantFence.revalidate())) throw new Error('hosted-grant-fence-changed');
    this.assertCurrentOwner(epoch, context, ownerBinding);
    const finalSocketIdentity = await this.inspectCurrentSocketIdentity();
    this.assertCurrentOwner(epoch, context, ownerBinding);
    if (!sameSocketIdentity(finalSocketIdentity, ownerBinding.socketIdentity)) {
      this.ownerMismatch();
      throw new Error('hosted-owner-socket-changed');
    }
    // Socket inspection is asynchronous. Revalidate the durable grant/identity fence once more
    // after it, then synchronously fence the captured owner epoch before exposing the result.
    if (!(await grantFence.revalidate())) throw new Error('hosted-grant-fence-changed');
    this.assertCurrentOwner(epoch, context, ownerBinding);
    return response.payload;
  }

  private request(
    body: string,
    context: QueryContext,
    epoch: number,
    ownerBinding: OrchestratorLifecycleOwnerBinding,
    grantFence: HostedMutationGrantFence
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.assertCurrentOwner(epoch, context, ownerBinding);
      const socket = this.connect(this.options.lease.socketPath);
      this.activeSockets.add(socket);
      let responseBody = '';
      let settled = false;
      let readableEnded = false;
      const remaining = Math.max(1, Math.min(this.timeoutMs, context.deadlineAtMs - Date.now()));
      const finish = (error?: unknown, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        this.activeSockets.delete(socket);
        socket.removeAllListeners();
        socket.destroy();
        if (error !== undefined) {
          reject(error instanceof Error ? error : new Error('request-failed'));
        } else resolve(value);
      };
      const abort = (): void => finish(new Error('aborted'));
      const timer = setTimeout(() => finish(new Error('timeout')), remaining);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) {
        abort();
        return;
      }
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        void (async () => {
          this.assertCurrentOwner(epoch, context, ownerBinding);
          if (!(await grantFence.revalidate())) throw new Error('hosted-grant-fence-changed');
          const connectedIdentity = await this.inspectCurrentSocketIdentity();
          this.assertCurrentOwner(epoch, context, ownerBinding);
          if (!sameSocketIdentity(connectedIdentity, ownerBinding.socketIdentity)) {
            this.ownerMismatch();
            throw new Error('hosted-owner-socket-changed');
          }
          if (!(await grantFence.revalidate())) throw new Error('hosted-grant-fence-changed');
          this.assertCurrentOwner(epoch, context, ownerBinding);
          // One authenticated frame plus write-side EOF is the admission boundary. The owner
          // cannot begin a mutation while delayed trailing bytes are still possible.
          socket.end(body);
        })().catch(finish);
      });
      socket.on('data', (chunk: string) => {
        if (settled) return;
        responseBody += chunk;
        if (Buffer.byteLength(responseBody) > MAXIMUM_MESSAGE_BYTES) {
          finish(new Error('oversize'));
          return;
        }
        const newline = responseBody.indexOf('\n');
        if (newline < 0) return;
        if (newline !== responseBody.length - 1) {
          finish(new Error('trailing-data'));
        }
      });
      socket.once('error', (error) => finish(error));
      socket.once('end', () => {
        readableEnded = true;
        if (settled) return;
        try {
          finish(undefined, parseStrictOrchestratorJsonFrame(responseBody));
        } catch (error) {
          finish(error);
        }
      });
      socket.once('close', () => {
        if (settled) return;
        finish(new Error(readableEnded ? 'invalid-close' : 'closed'));
      });
    });
  }

  private async readActiveIdentity(
    teamId: SendHostedTeamMessageCommand['teamId']
  ): Promise<TeamIdentityRecord | null> {
    const value = await this.options.teamIdentities.getTeamIdentity(teamId);
    if (value === null) return null;
    const identity = parseTeamIdentityRecord(value);
    const binding = identity.workspaceBinding;
    if (identity.teamId !== teamId || identity.state !== 'active' || binding === null) return null;
    const observed = this.observedBindings.get(identity.teamId);
    if (
      observed &&
      (binding.generation < observed.generation ||
        (binding.generation === observed.generation &&
          binding.workspaceId !== observed.workspaceId))
    ) {
      throw new TypeError('hosted-team-message-identity-binding-replayed');
    }
    this.observedBindings.set(identity.teamId, binding);
    // The external-owner request remains fenced by the current mount generation below; the team
    // identity's stable binding generation must not be compared with that boot-scoped counter.
    return binding.workspaceId === this.options.mountBinding.workspaceId ? identity : null;
  }

  private async inspectCurrentSocketIdentity(): Promise<
    OrchestratorLifecycleOwnerBinding['socketIdentity']
  > {
    try {
      return await this.inspectSocketIdentity(this.options.lease.socketPath);
    } catch (error) {
      this.ownerMismatch();
      throw error;
    }
  }

  private parseResponseOwnerBinding(value: unknown): OrchestratorLifecycleOwnerBinding {
    try {
      return parseOrchestratorLifecycleOwnerBinding(value);
    } catch (error) {
      this.ownerMismatch();
      throw error;
    }
  }

  private assertActive(epoch: number, context: QueryContext): void {
    if (
      this.closed ||
      this.epoch !== epoch ||
      context.signal.aborted ||
      Date.now() >= context.deadlineAtMs
    ) {
      throw new Error();
    }
  }

  private assertCurrentOwner(
    epoch: number,
    context: QueryContext,
    ownerBinding: OrchestratorLifecycleOwnerBinding
  ): void {
    this.assertActive(epoch, context);
    const currentBinding = this.options.lease.currentBinding();
    if (
      currentBinding === null ||
      !sameOrchestratorLifecycleOwnerBinding(ownerBinding, currentBinding)
    ) {
      this.ownerMismatch();
      throw new Error();
    }
  }

  private ownerMismatch(): void {
    this.revokeSockets();
    this.options.lease.invalidate();
  }

  private revokeSockets(): void {
    this.epoch += 1;
    for (const socket of this.activeSockets) socket.destroy();
  }
}
