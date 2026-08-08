import { createHash } from 'node:crypto';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { parseRevision, type QueryContext, type TeamId } from '@shared/contracts/hosted';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';

import { parseHostedMessageId, parseHostedMessageSourceGeneration } from '../../contracts/hosted';
import { sanitizeHostedMessageText } from '../../core/domain/hostedMessagePolicy';

import type {
  HostedMessagePersistenceAdmissionResult,
  HostedMessageRuntimeDeliveryResult,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type {
  HostedTeamMessageAuthorityPort,
  HostedTeamMessageAuthorityReadWindowResult,
} from '../ports/HostedTeamMessageAuthorityPort';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { InboxMessage } from '@shared/types';

const HOSTED_MESSAGE_RAW_SCAN_LIMIT = 1_280;

interface HostedTeamInboxAuthorityDependencies {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
  readonly inboxReader?: Pick<TeamInboxReader, 'getMessagesWindow'>;
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
  isTeamWorkspaceAuthorized(request: object, teamId: TeamId): Promise<boolean>;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
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

function hostedMessageId(input: {
  readonly teamId: TeamId;
  readonly rawMessageId: string;
  readonly from: string;
  readonly to: string | null;
}): ReturnType<typeof parseHostedMessageId> {
  return parseHostedMessageId(
    `message_${digest({ domain: 'hosted-team-message-inbox/v1', ...input }).slice(0, 32)}`
  );
}

function isBrowserVisible(message: InboxMessage): boolean {
  return (
    (message.messageKind === undefined || message.messageKind === 'default') &&
    !isTeamInternalControlMessageEnvelope(message)
  );
}

function projectInboxMessage(teamId: TeamId, message: InboxMessage): ProjectedInboxMessage | null {
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
  const messageId = hostedMessageId({
    teamId,
    rawMessageId,
    from: message.from,
    to: message.to ?? null,
  });
  return Object.freeze({
    message: Object.freeze({
      teamId,
      messageId,
      direction:
        message.from.trim().toLowerCase() === 'user' || message.source === 'user_sent'
          ? 'operator'
          : 'team',
      text,
      createdAtMs,
    }),
  });
}

function rawCursorForMessage(
  message: InboxMessage
): { readonly timestampMs: number; readonly messageId: string } | null {
  const timestampMs = Date.parse(message.timestamp);
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  return Number.isSafeInteger(timestampMs) && timestampMs >= 0 && messageId.length > 0
    ? Object.freeze({ timestampMs, messageId })
    : null;
}

function sameRawCursor(
  left: { readonly timestampMs: number; readonly messageId: string } | null,
  right: { readonly timestampMs: number; readonly messageId: string }
): boolean {
  return left?.timestampMs === right.timestampMs && left.messageId === right.messageId;
}

/**
 * Feature-owned authority for the bounded hosted inbox view. It reads the admitted mount only;
 * its persistence path fails closed unless the composition receives an existing cooperative writer.
 * Delivery stays with the external runtime and is never retried by this HTTP contribution.
 */
export class HostedTeamInboxAuthority implements HostedTeamMessageAuthorityPort {
  private readonly runtimeInstance: RuntimeInstanceContext;
  private readonly nowMs: () => number;
  private readonly inboxReader: Pick<TeamInboxReader, 'getMessagesWindow'>;

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
    this.inboxReader = dependencies.inboxReader ?? new TeamInboxReader();
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
      let rawCursor: { readonly timestampMs: number; readonly messageId: string } | null = null;
      let sourceRevision: string | null = null;
      let sourceMessageCount: number | null = null;
      let afterFound = request.afterMessageId === null;
      let hasMore = false;
      const seenMessageIds = new Set<string>();
      const visibleMessageIds = createHash('sha256');
      const candidates: ProjectedInboxMessage[] = [];

      for (;;) {
        const source = await this.inboxReader.getMessagesWindow(identity.legacyKey, {
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
          const projected = projectInboxMessage(request.teamId, rawMessage);
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
              domain: 'hosted-team-message-generation/v1',
              teamId: request.teamId,
              sourceRevision,
              sourceMessageCount,
              visibleMessageIds: visibleMessageIds.digest('hex'),
            }).slice(0, 48)}`
          );
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
    } catch {
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
    return identity.teamId === teamId &&
      identity.state === 'active' &&
      binding !== null &&
      binding.workspaceId === this.dependencies.mountBinding.workspaceId &&
      binding.generation === this.dependencies.mountBinding.mountGeneration
      ? identity
      : null;
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
    private readonly authorization: HostedTeamMessageRequestAuthorization
  ) {}

  async readWindow(
    request: Parameters<HostedTeamMessageAuthorityPort['readWindow']>[0],
    context: QueryContext
  ): Promise<HostedTeamMessageAuthorityReadWindowResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined || !(await this.queryAuthorized(httpRequest, request.teamId))) {
      return unavailableRead();
    }
    try {
      const result = await this.source.readWindow(request, context);
      return (await this.queryAuthorized(httpRequest, request.teamId)) ? result : unavailableRead();
    } catch {
      return unavailableRead();
    }
  }

  async persistMessage(
    command: Parameters<HostedTeamMessageAuthorityPort['persistMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined || !(await this.commandAuthorized(httpRequest, command.teamId))) {
      return unavailable();
    }
    try {
      const result = await this.source.persistMessage(command, context);
      return (await this.commandAuthorized(httpRequest, command.teamId)) ? result : unavailable();
    } catch {
      return unavailable();
    }
  }

  async deliverPersistedMessage(
    request: Parameters<HostedTeamMessageAuthorityPort['deliverPersistedMessage']>[0],
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined || !(await this.commandAuthorized(httpRequest, request.teamId))) {
      return operatorRequired();
    }
    try {
      const result = await this.source.deliverPersistedMessage(request, context);
      return (await this.commandAuthorized(httpRequest, request.teamId))
        ? result
        : operatorRequired();
    } catch {
      return operatorRequired();
    }
  }

  private async queryAuthorized(request: object, teamId: TeamId): Promise<boolean> {
    return (
      (await this.authorization.isHostedQueryAuthorized(request)) &&
      (await this.authorization.isTeamWorkspaceAuthorized(request, teamId))
    );
  }

  private async commandAuthorized(request: object, teamId: TeamId): Promise<boolean> {
    const principal = this.authorization.authenticatedPrincipalFor(request);
    return (
      principal?.principal.permissions.includes('hosted.command') === true &&
      (await this.queryAuthorized(request, teamId))
    );
  }
}
