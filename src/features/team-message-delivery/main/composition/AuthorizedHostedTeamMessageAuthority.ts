import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { parseRevision, type QueryContext, type TeamId } from '@shared/contracts/hosted';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';

import { parseHostedMessageId, parseHostedMessageSourceGeneration } from '../../contracts/hosted';
import { sanitizeHostedMessageText } from '../../core/domain/hostedMessagePolicy';
import {
  type DescriptorSafeHostedInboxCursor,
  type DescriptorSafeHostedInboxMessage,
  DescriptorSafeHostedInboxReader,
} from '../infrastructure/DescriptorSafeHostedInboxReader';

import { projectHostedInboxMessageId } from './hostedInboxMessageIdentity';

import type {
  HostedMessagePersistenceAdmissionResult,
  HostedMessageRuntimeDeliveryResult,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type {
  HostedMutationGrantFence,
  HostedTeamMessageAuthorityPort,
  HostedTeamMessageAuthorityReadWindowResult,
} from '../ports/HostedTeamMessageAuthorityPort';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { InboxMessage } from '@shared/types';

function inboxMessageCursorIdentity(message: InboxMessage): string {
  return JSON.stringify([
    typeof message.messageId === 'string' ? message.messageId.trim() : '',
    message.from ?? '',
    message.to ?? '',
  ]);
}

const HOSTED_MESSAGE_RAW_SCAN_LIMIT = 1_280;

interface HostedTeamInboxAuthorityDependencies {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
  readonly inboxReader?: Pick<DescriptorSafeHostedInboxReader, 'getMessagesWindow'>;
  readonly ownerProvenance?: HostedInboxOwnerProvenanceAuthority;
  readonly reportReadDiagnostic?: HostedTeamMessageReadDiagnostic;
}

export type HostedTeamMessageReadDiagnostic = (stage: string, code: string) => void;

export interface HostedInboxOwnerBinding {
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
}

export interface HostedInboxOwnerProvenanceAuthority {
  readonly ownerProofKey: string;
  currentOwnerBinding(): HostedInboxOwnerBinding | null;
}

interface ProjectedInboxMessage {
  readonly message: {
    readonly teamId: TeamId;
    readonly messageId: ReturnType<typeof parseHostedMessageId>;
    readonly direction: 'operator' | 'team';
    readonly text: string;
    readonly createdAtMs: number;
  };
}

export interface HostedTeamMessageRequestAuthorization {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  isHostedQueryAuthorized(request: object): Promise<boolean>;
  isHostedTaskMutationAuthorized(request: object, teamId: TeamId): Promise<boolean>;
  isTeamWorkspaceAuthorized(request: object, teamId: TeamId): Promise<boolean>;
  captureTeamWorkspaceGrantFence?(
    request: object,
    teamId: TeamId,
    permission: 'hosted.query' | 'hosted.command'
  ): Promise<HostedMutationGrantFence | null>;
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

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function diagnosticCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const errno = Reflect.get(error, 'code');
    if (typeof errno === 'string' && /^[A-Z0-9_]{1,32}$/u.test(errno)) {
      return `errno-${errno.toLowerCase().replaceAll('_', '-')}`;
    }
  }
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9-]{0,127}$/u.test(message) ? message : 'unknown';
}

function canonicalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return sanitizeHostedMessageText(value.replace(/\r\n?/gu, '\n').trim());
  } catch {
    return null;
  }
}

function unavailable(): HostedMessagePersistenceAdmissionResult {
  return Object.freeze({ kind: 'unavailable' });
}

function unavailableRead(): HostedTeamMessageAuthorityReadWindowResult {
  return Object.freeze({ kind: 'unavailable' });
}

function operatorRequired(): HostedMessageRuntimeDeliveryResult {
  return Object.freeze({ kind: 'operator_required' });
}

function isBrowserVisible(message: InboxMessage): boolean {
  return (
    (message.messageKind === undefined || message.messageKind === 'default') &&
    !isTeamInternalControlMessageEnvelope(message)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isExactHostedMutationGrantFence(value: unknown): value is HostedMutationGrantFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  const ownerEffectFence = fence.ownerEffectFence;
  if (
    typeof fence.revalidate !== 'function' ||
    typeof ownerEffectFence !== 'object' ||
    ownerEffectFence === null ||
    Array.isArray(ownerEffectFence)
  ) {
    return false;
  }
  const effect = ownerEffectFence as Record<string, unknown>;
  return (
    hasExactKeys(effect, ['grantRevision', 'identityChecksum']) &&
    typeof effect.grantRevision === 'string' &&
    /^[0-9a-f]{64}$/u.test(effect.grantRevision) &&
    typeof effect.identityChecksum === 'string' &&
    /^[0-9a-f]{64}$/u.test(effect.identityChecksum)
  );
}

function isOwnerProvenanceValid(
  teamId: TeamId,
  message: DescriptorSafeHostedInboxMessage,
  dependencies: HostedTeamInboxAuthorityDependencies,
  createdAtMs: number,
  rawMessageId: string
): boolean {
  const authority = dependencies.ownerProvenance;
  const value = message.hostedOwnerProvenance;
  if (
    authority === undefined ||
    !/^[0-9a-f]{64}$/u.test(authority.ownerProofKey) ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const record = value as unknown as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'domain',
    'actorId',
    'deploymentId',
    'bootId',
    'workspaceId',
    'mountGeneration',
    'teamId',
    'messageId',
    'from',
    'to',
    'target',
    'textHash',
    'createdAtMs',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'ownerProof',
  ] as const;
  if (!hasExactKeys(record, keys) || typeof record.ownerProof !== 'string') return false;
  const binding = authority.currentOwnerBinding();
  if (binding === null) return false;
  const unsigned = Object.freeze({
    schemaVersion: record.schemaVersion,
    domain: record.domain,
    actorId: record.actorId,
    deploymentId: record.deploymentId,
    bootId: record.bootId,
    workspaceId: record.workspaceId,
    mountGeneration: record.mountGeneration,
    teamId: record.teamId,
    messageId: record.messageId,
    from: record.from,
    to: record.to,
    target: record.target,
    textHash: record.textHash,
    createdAtMs: record.createdAtMs,
    ownerAuthority: record.ownerAuthority,
    ownerGeneration: record.ownerGeneration,
    ownerSessionId: record.ownerSessionId,
  });
  if (
    unsigned.schemaVersion !== 1 ||
    unsigned.domain !== 'agent-teams.hosted-team-message.inbox-provenance/v1' ||
    typeof unsigned.actorId !== 'string' ||
    unsigned.deploymentId !== dependencies.runtimeInstance.deploymentId ||
    unsigned.bootId !== dependencies.runtimeInstance.bootId ||
    unsigned.workspaceId !== dependencies.mountBinding.workspaceId ||
    unsigned.mountGeneration !== dependencies.mountBinding.mountGeneration ||
    unsigned.teamId !== teamId ||
    unsigned.messageId !== rawMessageId ||
    unsigned.from !== message.from ||
    unsigned.to !== (message.to ?? null) ||
    unsigned.target !== message.hostedInboxTarget ||
    unsigned.createdAtMs !== createdAtMs ||
    unsigned.textHash !== createHash('sha256').update(message.text, 'utf8').digest('hex') ||
    unsigned.ownerAuthority !== binding.ownerAuthority ||
    unsigned.ownerGeneration !== binding.ownerGeneration ||
    unsigned.ownerSessionId !== binding.ownerSessionId ||
    !/^[0-9a-f]{64}$/u.test(record.ownerProof)
  ) {
    return false;
  }
  const expected = createHmac('sha256', Buffer.from(authority.ownerProofKey, 'hex'))
    .update(
      `agent-teams.hosted-team-message.inbox-provenance/v1\u0000${JSON.stringify(unsigned)}`,
      'utf8'
    )
    .digest();
  return timingSafeEqual(expected, Buffer.from(record.ownerProof, 'hex'));
}

function projectInboxMessage(
  teamId: TeamId,
  message: DescriptorSafeHostedInboxMessage,
  dependencies: HostedTeamInboxAuthorityDependencies
): ProjectedInboxMessage | null {
  if (!isBrowserVisible(message)) return null;
  const rawMessageId = typeof message.messageId === 'string' ? message.messageId : '';
  const createdAtMs = Date.parse(message.timestamp);
  const text = canonicalText(message.text);
  if (
    rawMessageId.length === 0 ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    text === null
  ) {
    return null;
  }
  const messageId = projectHostedInboxMessageId({
    teamId,
    rawMessageId,
    from: message.from,
    to: message.to ?? null,
  });
  return Object.freeze({
    message: Object.freeze({
      teamId,
      messageId,
      direction: isOwnerProvenanceValid(teamId, message, dependencies, createdAtMs, rawMessageId)
        ? 'operator'
        : 'team',
      text,
      createdAtMs,
    }),
  });
}

function rawCursorForMessage(
  message: InboxMessage
): Readonly<DescriptorSafeHostedInboxCursor> | null {
  const timestampMs = Date.parse(message.timestamp);
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  return Number.isSafeInteger(timestampMs) && timestampMs >= 0 && messageId.length > 0
    ? Object.freeze({
        timestampMs,
        messageId,
        messageIdentity: inboxMessageCursorIdentity(message),
      })
    : null;
}

function sameRawCursor(
  left: Readonly<DescriptorSafeHostedInboxCursor> | null,
  right: Readonly<DescriptorSafeHostedInboxCursor>
): boolean {
  return (
    left?.timestampMs === right.timestampMs &&
    left.messageId === right.messageId &&
    left.messageIdentity === right.messageIdentity
  );
}

/**
 * Feature-owned authority for the bounded hosted inbox view. It reads the admitted mount only;
 * its persistence path fails closed unless the composition receives an existing cooperative writer.
 * Delivery stays with the external runtime and is never retried by this HTTP contribution.
 */
export class HostedTeamInboxAuthority implements HostedTeamMessageAuthorityPort {
  private readonly runtimeInstance: RuntimeInstanceContext;
  private readonly nowMs: () => number;
  private readonly inboxReader: Pick<DescriptorSafeHostedInboxReader, 'getMessagesWindow'>;
  private readonly observedBindings = new Map<
    TeamIdentityRecord['teamId'],
    NonNullable<TeamIdentityRecord['workspaceBinding']>
  >();

  constructor(private readonly dependencies: HostedTeamInboxAuthorityDependencies) {
    this.runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
    if (
      !(dependencies.mountBinding instanceof WorkspaceMountBinding) ||
      dependencies.mountBinding.health === 'unavailable' ||
      dependencies.mountBinding.bootId !== this.runtimeInstance.bootId
    ) {
      throw new TypeError('hosted-team-message-inbox-binding-invalid');
    }
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.inboxReader =
      dependencies.inboxReader ??
      new DescriptorSafeHostedInboxReader({
        teamsRoot: join(this.runtimeInstance.claudeRoot.reference, 'teams'),
      });
  }

  async readWindow(
    request: Parameters<HostedTeamMessageAuthorityPort['readWindow']>[0],
    context: QueryContext
  ): Promise<HostedTeamMessageAuthorityReadWindowResult> {
    try {
      this.assertActive(context, request.deadlineAtMs);
      if (
        !Number.isSafeInteger(request.itemLimit) ||
        request.itemLimit < 1 ||
        request.itemLimit > 51
      ) {
        return unavailableRead();
      }
      if (request.afterMessageId !== null) parseHostedMessageId(request.afterMessageId);
      if (request.expectedSourceGeneration !== null) {
        parseHostedMessageSourceGeneration(request.expectedSourceGeneration);
      }
      const identity = await this.resolveActiveIdentity(
        request.teamId,
        context,
        request.deadlineAtMs
      );
      if (identity === null) return Object.freeze({ kind: 'not_found' });
      let rawCursor: Readonly<DescriptorSafeHostedInboxCursor> | null = null;
      let sourceRevision: string | null = null;
      let sourceMessageCount: number | null = null;
      let afterFound = request.afterMessageId === null;
      let hasMore = false;
      const seenMessageIds = new Set<string>();
      const visibleMessageIds = createHash('sha256');
      const candidates: ProjectedInboxMessage[] = [];

      for (;;) {
        const source = await this.inboxReader.getMessagesWindow(identity, {
          cursor: rawCursor,
          limit: HOSTED_MESSAGE_RAW_SCAN_LIMIT,
        });
        this.assertActive(context, request.deadlineAtMs);
        if (
          !Array.isArray(source.messages) ||
          typeof source.sourceRevision !== 'string' ||
          !Number.isSafeInteger(source.sourceMessageCount) ||
          source.sourceMessageCount < 0 ||
          typeof source.truncated !== 'boolean'
        ) {
          return unavailableRead();
        }
        if (sourceRevision === null || sourceMessageCount === null) {
          sourceRevision = source.sourceRevision;
          sourceMessageCount = source.sourceMessageCount;
        } else if (
          source.sourceRevision !== sourceRevision ||
          source.sourceMessageCount !== sourceMessageCount
        ) {
          return unavailableRead();
        }

        for (const rawMessage of source.messages) {
          const projected = projectInboxMessage(request.teamId, rawMessage, this.dependencies);
          if (projected === null || seenMessageIds.has(projected.message.messageId)) continue;
          seenMessageIds.add(projected.message.messageId);
          visibleMessageIds.update(projected.message.messageId, 'utf8');
          visibleMessageIds.update('\n', 'utf8');
          if (!afterFound) {
            afterFound = projected.message.messageId === request.afterMessageId;
            continue;
          }
          if (candidates.length < request.itemLimit) {
            candidates.push(projected);
            continue;
          }
          hasMore = true;
        }

        if (!source.truncated) {
          if (!afterFound) return unavailableRead();
          const sourceGeneration = parseHostedMessageSourceGeneration(
            `generation_${digest({
              domain: 'hosted-team-message-generation/v2',
              deploymentId: this.runtimeInstance.deploymentId,
              bootId: this.runtimeInstance.bootId,
              workspaceId: this.dependencies.mountBinding.workspaceId,
              mountGeneration: this.dependencies.mountBinding.mountGeneration,
              teamId: request.teamId,
              sourceRevision,
              sourceMessageCount,
              visibleMessageIds: visibleMessageIds.digest('hex'),
            }).slice(0, 48)}`
          );
          const currentIdentity = await this.resolveActiveIdentity(
            request.teamId,
            context,
            request.deadlineAtMs
          );
          if (!sameActiveTeamIdentity(identity, currentIdentity)) return unavailableRead();
          if (
            request.expectedSourceGeneration !== null &&
            request.expectedSourceGeneration !== sourceGeneration
          ) {
            return Object.freeze({
              kind: 'stale_generation',
              currentSourceGeneration: sourceGeneration,
            });
          }
          return this.foundWindow({
            teamId: request.teamId,
            sourceGeneration,
            sourceRevision,
            candidates,
            hasMore,
          });
        }
        const lastRawMessage = source.messages.at(-1);
        const nextRawCursor =
          lastRawMessage === undefined ? null : rawCursorForMessage(lastRawMessage);
        if (nextRawCursor === null || sameRawCursor(rawCursor, nextRawCursor)) {
          return unavailableRead();
        }
        rawCursor = nextRawCursor;
      }
    } catch (error) {
      this.dependencies.reportReadDiagnostic?.('inbox-read-exception', diagnosticCode(error));
      return unavailableRead();
    }
  }

  async persistMessage(
    command: Parameters<HostedTeamMessageAuthorityPort['persistMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult> {
    try {
      this.assertActive(context);
      const identity = await this.resolveActiveIdentity(command.teamId, context);
      if (identity === null) return Object.freeze({ kind: 'not_found' });
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  async deliverPersistedMessage(
    request: Parameters<HostedTeamMessageAuthorityPort['deliverPersistedMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult> {
    try {
      this.assertActive(context);
      parseHostedMessageId(request.messageId);
      await this.resolveActiveIdentity(request.teamId, context);
      return operatorRequired();
    } catch {
      return operatorRequired();
    }
  }

  private async resolveActiveIdentity(
    teamId: TeamId,
    context: QueryContext,
    operationDeadlineAtMs = context.deadlineAtMs
  ) {
    const value = await this.dependencies.teamIdentities.getTeamIdentity(teamId);
    this.assertActive(context, operationDeadlineAtMs);
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
    // Stable team binding generations and boot-scoped workspace mount generations are separate.
    return binding.workspaceId === this.dependencies.mountBinding.workspaceId ? identity : null;
  }

  private foundWindow(input: {
    readonly teamId: TeamId;
    readonly sourceGeneration: ReturnType<typeof parseHostedMessageSourceGeneration>;
    readonly sourceRevision: string;
    readonly candidates: readonly ProjectedInboxMessage[];
    readonly hasMore: boolean;
  }): HostedTeamMessageAuthorityReadWindowResult {
    return Object.freeze({
      kind: 'found',
      teamId: input.teamId,
      sourceGeneration: input.sourceGeneration,
      revision: parseRevision(
        `revision_${digest({
          sourceGeneration: input.sourceGeneration,
          sourceRevision: input.sourceRevision,
        }).slice(0, 48)}`
      ),
      messages: Object.freeze(input.candidates.map(({ message }) => message)),
      hasMore: input.hasMore,
    });
  }

  private assertActive(context: QueryContext, deadlineAtMs = context.deadlineAtMs): void {
    const nowMs = this.nowMs();
    if (
      context.deploymentId !== this.runtimeInstance.deploymentId ||
      context.bootId !== this.runtimeInstance.bootId ||
      context.signal.aborted ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > context.deadlineAtMs ||
      nowMs >= deadlineAtMs
    ) {
      throw new Error('hosted-team-message-context-inactive');
    }
  }
}

/**
 * Applies the current request grant before and after feature-owned inbox operations. It consumes
 * the narrow host authorization port and owns neither authentication nor an identity provider.
 */
export class AuthorizedHostedTeamMessageAuthority implements HostedTeamMessageAuthorityPort {
  constructor(
    private readonly source: HostedTeamMessageAuthorityPort,
    private readonly requests: WeakMap<QueryContext, object>,
    private readonly authorization: HostedTeamMessageRequestAuthorization,
    private readonly reportReadDiagnostic?: HostedTeamMessageReadDiagnostic
  ) {}

  async readWindow(
    request: Parameters<HostedTeamMessageAuthorityPort['readWindow']>[0],
    context: QueryContext
  ): Promise<HostedTeamMessageAuthorityReadWindowResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined) {
      this.reportReadDiagnostic?.('authorization-context-missing', 'unavailable');
      return unavailableRead();
    }
    const fence = await this.captureFence(httpRequest, request.teamId, 'hosted.query');
    if (fence === null) {
      this.reportReadDiagnostic?.('authorization-fence-missing', 'unavailable');
      return unavailableRead();
    }
    if (!(await fence.revalidate())) {
      this.reportReadDiagnostic?.('authorization-fence-stale-before-read', 'unavailable');
      return unavailableRead();
    }
    try {
      const result = await this.source.readWindow(request, context);
      if (result.kind === 'unavailable') {
        this.reportReadDiagnostic?.('inbox-source-unavailable', 'unavailable');
      }
      if (!(await fence.revalidate())) {
        this.reportReadDiagnostic?.('authorization-fence-stale-after-read', 'unavailable');
        return unavailableRead();
      }
      return result;
    } catch (error) {
      this.reportReadDiagnostic?.('authorized-read-exception', diagnosticCode(error));
      return unavailableRead();
    }
  }

  async persistMessage(
    command: Parameters<HostedTeamMessageAuthorityPort['persistMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult> {
    const httpRequest = this.requests.get(context);
    const bindGrantFence = this.source.bindGrantFence;
    const fence =
      httpRequest === undefined
        ? null
        : await this.captureFence(httpRequest, command.teamId, 'hosted.command');
    if (
      httpRequest === undefined ||
      fence === null ||
      typeof bindGrantFence !== 'function' ||
      !(await fence.revalidate())
    ) {
      return unavailable();
    }
    try {
      bindGrantFence.call(this.source, context, fence);
      const result = await this.source.persistMessage(command, context);
      return (await fence.revalidate()) ? result : unavailable();
    } catch {
      return unavailable();
    }
  }

  async deliverPersistedMessage(
    request: Parameters<HostedTeamMessageAuthorityPort['deliverPersistedMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult> {
    const httpRequest = this.requests.get(context);
    const bindGrantFence = this.source.bindGrantFence;
    const fence =
      httpRequest === undefined
        ? null
        : await this.captureFence(httpRequest, request.teamId, 'hosted.command');
    if (
      httpRequest === undefined ||
      fence === null ||
      typeof bindGrantFence !== 'function' ||
      !(await fence.revalidate())
    ) {
      return operatorRequired();
    }
    try {
      bindGrantFence.call(this.source, context, fence);
      const result = await this.source.deliverPersistedMessage(request, context);
      return (await fence.revalidate()) ? result : operatorRequired();
    } catch {
      return operatorRequired();
    }
  }

  private async captureFence(
    request: object,
    teamId: TeamId,
    permission: 'hosted.query' | 'hosted.command'
  ): Promise<HostedMutationGrantFence | null> {
    const capture = this.authorization.captureTeamWorkspaceGrantFence;
    if (typeof capture !== 'function') return null;
    try {
      const fence = await capture.call(this.authorization, request, teamId, permission);
      return isExactHostedMutationGrantFence(fence) ? fence : null;
    } catch {
      return null;
    }
  }
}
