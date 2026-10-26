import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';

import { DEFAULT_TEAM_GROUP_CHAT_ID, DEFAULT_TEAM_GROUP_CHAT_NAME } from './contracts.js';
import {
  effectiveGroupMembers,
  GroupChatError,
  groupSendRecipients,
  isGroupPhysicalId,
  isGroupUuid,
  matchesHumanGroupTarget,
} from './model.js';
import { createGroupCreation } from './createGroupCreation.js';
import { createGroupReactions } from './createGroupReactions.js';
import type { GroupChatStorage } from './storage.js';

import type {
  AgentGroupChatCreateRequest,
  GroupChatReactionRequest,
  GroupChatReactionResult,
  GroupChatSendRequest,
  GroupChatSendResult,
  GroupDeliveryRecipient,
  GroupInboundAcknowledgementTarget,
  TeamGroupChatDTO,
  TeamGroupChatsAPI,
} from './contracts.js';
import type { GroupChat } from './model.js';
import type { GroupMessage as InboxMessage } from './message.js';

export interface GroupChatRun {
  runKey: string;
  protocolVersion: 1;
  groupReactionProtocolVersion?: 1;
  provider: 'native' | 'lead' | 'opencode' | 'host';
  /** Local-only currency check for an admitted live owner; never launches a provider. */
  isCurrent?: () => Promise<boolean>;
}

export interface TeamGroupChatsPorts {
  roster(teamName: string): Promise<string[]>;
  leadName?(teamName: string): Promise<string | null>;
  getRun(teamName: string, memberName: string): Promise<GroupChatRun | null>;
  configurationOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  deliver(
    teamName: string,
    message: InboxMessage & { messageId: string; to: string },
    run: GroupChatRun,
    shouldStillWrite: () => Promise<boolean>
  ): Promise<GroupDeliveryRecipient['status']>;
  changed?(teamName: string): void;
  reactionChanged?(teamName: string, messageId: string): void;
}

export interface TeamGroupChatsFeature extends TeamGroupChatsAPI {
  createFromAgent(request: AgentGroupChatCreateRequest): Promise<TeamGroupChatDTO>;
  react(request: GroupChatReactionRequest): Promise<GroupChatReactionResult>;
  hasAcknowledgedInbound(request: GroupInboundAcknowledgementTarget): Promise<boolean>;
  list(request: { teamName: string }, from?: string): Promise<TeamGroupChatDTO[]>;
  send(request: GroupChatSendRequest, from?: string): Promise<GroupChatSendResult>;
}

function validText(value: unknown, label: string, max = 100_000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new GroupChatError('invalid-input', `Invalid ${label}`);
}
function validateId(value: unknown): asserts value is string {
  if (!isGroupUuid(value)) throw new GroupChatError('invalid-input', 'Invalid group/message UUID');
}
function validatePhysicalId(value: unknown): asserts value is string {
  if (!isGroupPhysicalId(value))
    throw new GroupChatError('invalid-input', 'Invalid group/message identity');
}
function payload(
  message: Pick<
    InboxMessage,
    'from' | 'text' | 'summary' | 'taskRefs' | 'relayOfMessageId' | 'groupChatId'
  >
) {
  return {
    from: message.from,
    text: message.text,
    ...(message.summary === undefined ? {} : { summary: message.summary }),
    ...(message.taskRefs?.length ? { taskRefs: message.taskRefs } : {}),
    ...(message.relayOfMessageId === undefined
      ? {}
      : { relayOfMessageId: message.relayOfMessageId }),
    ...(message.groupChatId === undefined ? {} : { groupChatId: message.groupChatId }),
  };
}
function result(message: InboxMessage): GroupChatSendResult {
  return {
    saved: true,
    groupChatId: message.groupChatId!,
    messageId: message.messageId!,
    statusPersisted: !!message.groupDeliverySummary,
    ...(message.groupDeliverySummary ? { deliverySummary: message.groupDeliverySummary } : {}),
  };
}
function findGroup(groups: GroupChat[], id: string): GroupChat {
  const group = groups.find((item) => item.id === id);
  if (!group) throw new GroupChatError('not-found', 'Group chat does not exist');
  return group;
}

function resolveSendGroup(groups: GroupChat[], groupChatId: string, from: string) {
  const existing = groups.find((group) => group.id === groupChatId);
  const isDefault = groupChatId === DEFAULT_TEAM_GROUP_CHAT_ID;
  if (
    isDefault &&
    existing &&
    (existing.name !== DEFAULT_TEAM_GROUP_CHAT_NAME ||
      existing.archivedAt !== null ||
      existing.membership.kind !== 'auto' ||
      existing.membership.excludedMemberNames.length)
  )
    throw new GroupChatError('reserved-group', 'Invalid standard group destination');
  const group =
    !existing && isDefault && from === 'user'
      ? {
          id: DEFAULT_TEAM_GROUP_CHAT_ID,
          name: DEFAULT_TEAM_GROUP_CHAT_NAME,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          membership: { kind: 'auto' as const, excludedMemberNames: [] },
        }
      : findGroup(groups, groupChatId);
  return { existing, group };
}

export function createTeamGroupChatsFeature(
  ports: TeamGroupChatsPorts,
  storage: GroupChatStorage
): TeamGroupChatsFeature {
  const catalogCurrency = new Map<string, () => Promise<boolean>>();
  async function catalogAvailable(teamName: string, memberName: string): Promise<boolean> {
    const key = JSON.stringify([teamName, memberName]);
    const check = catalogCurrency.get(key);
    if (check && (await check().catch(() => false))) return true;
    catalogCurrency.delete(key);
    const run = await ports.getRun(teamName, memberName);
    if (run?.protocolVersion !== 1) return false;
    // Display-only reuse: fresh send admission below never reads this map.
    // isCurrent checks the live owner/session/lane/manifest without a CLI process.
    if (run.provider === 'opencode' && run.isCurrent) {
      if (catalogCurrency.size >= 256) catalogCurrency.delete(catalogCurrency.keys().next().value!);
      catalogCurrency.set(key, run.isCurrent);
    }
    return true;
  }
  async function project(
    teamName: string,
    group: GroupChat,
    roster: string[],
    from = 'user'
  ): Promise<TeamGroupChatDTO> {
    const memberNames = effectiveGroupMembers(group, roster);
    let reason = group.archivedAt
      ? 'archived'
      : memberNames.length < 2
        ? 'minimum-members'
        : from !== 'user' && !memberNames.includes(from)
          ? 'not-member'
          : undefined;
    let availableRecipientNames: string[] = [];
    if (!reason) {
      const runs = await Promise.all(
        memberNames.map(async (name) => ({
          name,
          available: await catalogAvailable(teamName, name),
        }))
      );
      availableRecipientNames = runs
        .filter(({ name, available }) => name !== from && available)
        .map(({ name }) => name);
      const unavailable = runs.filter(({ available }) => !available).map(({ name }) => name);
      if (unavailable.length) reason = `recipient-unavailable: ${unavailable.join(', ')}`;
    }
    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      membership: structuredClone(group.membership),
      archivedAt: group.archivedAt,
      memberNames,
      availableRecipientNames,
      canSend: !reason,
      ...(reason ? { reason } : {}),
    };
  }
  const feature: TeamGroupChatsFeature = {
    ...createGroupReactions(ports, storage),
    ...createGroupCreation(ports, storage, project),
    async list({ teamName }, from = 'user') {
      validText(teamName, 'team name', 200);
      await storage.teamRoot(teamName);
      const roster = await ports.roster(teamName);
      // Runtime projection may await provider handshakes; keep it outside the registry lock.
      const groups = await storage.withRegistry(teamName, async (snapshot) =>
        structuredClone(snapshot)
      );
      return Promise.all(groups.map((group) => project(teamName, group, roster, from)));
    },
    async setArchived({ teamName, groupChatId, archived }) {
      validText(teamName, 'team name', 200);
      validateId(groupChatId);
      if (groupChatId === DEFAULT_TEAM_GROUP_CHAT_ID)
        throw new GroupChatError('reserved-group', 'The standard group cannot be archived');
      if (typeof archived !== 'boolean')
        throw new GroupChatError('invalid-input', 'Archive state must be boolean');
      const savedGroup = await ports.configurationOperation(teamName, () =>
        storage.withRegistry(teamName, async (groups, save) => {
          const group = findGroup(groups, groupChatId);
          if (!!group.archivedAt !== archived) {
            group.archivedAt = archived ? new Date().toISOString() : null;
            await save();
            ports.changed?.(teamName);
          }
          return structuredClone(group);
        })
      );
      return project(teamName, savedGroup, await ports.roster(teamName));
    },
    async send(request, from = 'user') {
      validText(request.teamName, 'team name', 200);
      validateId(request.groupChatId);
      validateId(request.messageId);
      validText(request.text, 'message');
      validText(from, 'sender', 200);
      if (from !== 'user' && Object.prototype.hasOwnProperty.call(request, 'recipientName'))
        throw new GroupChatError('invalid-input', 'Only human posts may select a recipient');
      if (request.recipientName !== undefined) {
        validText(request.recipientName, 'recipient', 200);
        if (request.recipientName.trim() !== request.recipientName)
          throw new GroupChatError('invalid-input', 'Invalid recipient');
      }
      if (
        request.summary !== undefined &&
        (typeof request.summary !== 'string' || request.summary.length > 1000)
      )
        throw new GroupChatError('invalid-input', 'Invalid message summary');
      if (request.relayOfMessageId !== undefined) validatePhysicalId(request.relayOfMessageId);
      if (
        request.taskRefs !== undefined &&
        (!Array.isArray(request.taskRefs) ||
          request.taskRefs.length > 100 ||
          request.taskRefs.some(
            (ref) =>
              !ref ||
              typeof ref.teamName !== 'string' ||
              typeof ref.taskId !== 'string' ||
              typeof ref.displayId !== 'string'
          ))
      )
        throw new GroupChatError('invalid-input', 'Invalid task references');
      // Logical serialization includes fanout, so transport retries read its final snapshot.
      return storage.logicalPost(
        `group-post:${request.teamName}:${request.messageId}`,
        async () => {
          const immutable = payload({ ...request, from });
          const prior = await storage.withInbox(request.teamName, 'user', async (rows) =>
            rows.find((row) => row?.messageId === request.messageId)
          );
          if (prior) {
            if (
              prior.groupMessageId !== request.messageId ||
              !isDeepStrictEqual(payload(prior), immutable) ||
              (from === 'user' &&
                !matchesHumanGroupTarget(prior.groupRecipientNames!, request.recipientName))
            )
              throw new GroupChatError(
                'conflicting-id',
                'Message identity is already used for another payload'
              );
            return result(prior);
          }
          const preparedGroup = await storage.withRegistry(request.teamName, async (groups) =>
            structuredClone(resolveSendGroup(groups, request.groupChatId, from).group)
          );
          const preparedMembers = effectiveGroupMembers(
            preparedGroup,
            await ports.roster(request.teamName)
          );
          if (preparedGroup.archivedAt) throw new GroupChatError('archived', 'Chat is archived');
          if (preparedMembers.length < 2)
            throw new GroupChatError('minimum-members', 'Chat requires two current agents');
          if (from !== 'user' && !preparedMembers.includes(from))
            throw new GroupChatError('not-member', 'Sender is not a chat member');
          const preparedRecipients = groupSendRecipients(
            preparedMembers,
            from,
            request.recipientName
          );
          const requiredRuns = from === 'user' ? preparedRecipients : preparedMembers;
          const runs = new Map<string, GroupChatRun>();
          // Never hold configuration/registry locks while waiting for a provider.
          // Bound probes even for a large group; concurrent catalog calls share the pending handshake.
          let nextRun = 0;
          let admissionFailed = false;
          const admissions = await Promise.allSettled(
            Array.from({ length: Math.min(4, requiredRuns.length) }, async () => {
              while (!admissionFailed && nextRun < requiredRuns.length) {
                const memberName = requiredRuns[nextRun++]!;
                try {
                  const run = await ports.getRun(request.teamName, memberName);
                  if (!run || run.protocolVersion !== 1)
                    throw new GroupChatError(
                      'recipient-unavailable',
                      `Start a compatible runtime for ${memberName}`
                    );
                  runs.set(memberName, run);
                } catch (error) {
                  admissionFailed = true;
                  throw error;
                }
              }
            })
          );
          const failure = admissions.find((admission) => admission.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          const canonical = await ports.configurationOperation(request.teamName, () =>
            storage.withRegistry(request.teamName, async (groups, save) => {
              const { existing, group } = resolveSendGroup(groups, request.groupChatId, from);
              const roster = await ports.roster(request.teamName);
              const members = effectiveGroupMembers(group, roster);
              if (group.archivedAt) throw new GroupChatError('archived', 'Chat is archived');
              if (members.length < 2)
                throw new GroupChatError('minimum-members', 'Chat requires two current agents');
              if (from !== 'user' && !members.includes(from))
                throw new GroupChatError('not-member', 'Sender is not a chat member');
              const recipients = groupSendRecipients(members, from, request.recipientName);
              if (
                !isDeepStrictEqual(members, preparedMembers) ||
                !isDeepStrictEqual(recipients, preparedRecipients) ||
                !isDeepStrictEqual(group.membership, preparedGroup.membership)
              )
                throw new GroupChatError(
                  'recipient-unavailable',
                  'Group membership changed during admission; retry the same message'
                );
              for (const memberName of requiredRuns) {
                const run = runs.get(memberName)!;
                const current = run.isCurrent
                  ? await run.isCurrent()
                  : run.provider === 'opencode' || run.provider === 'host'
                    ? false
                    : (await ports.getRun(request.teamName, memberName))?.runKey === run.runKey;
                if (!current)
                  throw new GroupChatError(
                    'recipient-unavailable',
                    `Runtime changed for ${memberName}`
                  );
              }
              if (request.relayOfMessageId) {
                if (from === 'user')
                  throw new GroupChatError(
                    'invalid-relay',
                    'Human posts cannot claim agent relay identity'
                  );
                const valid = await storage.withInbox(request.teamName, from, async (rows) =>
                  rows.some(
                    (row) =>
                      row?.messageId === request.relayOfMessageId &&
                      row.groupChatId === group.id &&
                      row.groupMessageId !== row.messageId &&
                      row.to === from
                  )
                );
                if (!valid)
                  throw new GroupChatError(
                    'invalid-relay',
                    'Reply does not reference a physical inbound for this sender'
                  );
              }
              if (!existing) {
                groups.push(group);
                await save();
              }
              const message: InboxMessage = {
                ...immutable,
                groupChatId: request.groupChatId,
                to: 'user',
                messageId: request.messageId,
                groupMessageId: request.messageId,
                groupChatProtocolVersion: 1,
                groupChatName: group.name,
                timestamp: new Date().toISOString(),
                read: false,
                source: from === 'user' ? 'user_sent' : 'runtime_delivery',
                groupRecipientNames: recipients,
                groupRecipientRunKeys: Object.fromEntries(
                  recipients.map((name) => [name, runs.get(name)!.runKey])
                ),
              };
              await storage.withInbox(request.teamName, 'user', async (rows, save) => {
                rows.push(message);
                await save();
              });
              return message;
            })
          );
          ports.changed?.(request.teamName);
          const recipients = canonical.groupRecipientNames!;
          const attempts = await Promise.allSettled(
            recipients.map(async (memberName): Promise<GroupDeliveryRecipient> => {
              const physicalMessageId = `${request.messageId}:g:${createHash('sha256').update(memberName).digest('hex').slice(0, 24)}`;
              const run = runs.get(memberName)!;
              const shouldStillWrite = async () =>
                (await ports.roster(request.teamName)).includes(memberName) &&
                (run.isCurrent
                  ? await run.isCurrent()
                  : run.provider === 'opencode' || run.provider === 'host'
                    ? false
                    : (await ports.getRun(request.teamName, memberName))?.runKey === run.runKey);
              try {
                if (!(await shouldStillWrite()))
                  return {
                    memberName,
                    physicalMessageId,
                    status: 'skipped',
                    reason: 'Runtime or membership changed',
                  };
                const physical = {
                  ...canonical,
                  messageId: physicalMessageId,
                  to: memberName,
                  groupRunKey: run.runKey,
                };
                const status = await ports.deliver(request.teamName, physical, run, shouldStillWrite);
                return { memberName, physicalMessageId, status };
              } catch (error) {
                return {
                  memberName,
                  physicalMessageId,
                  status: 'unknown',
                  reason: error instanceof Error ? error.message : String(error),
                };
              }
            })
          );
          canonical.groupDeliverySummary = {
            recordedAt: new Date().toISOString(),
            recipients: attempts.map((attempt, index) =>
              attempt.status === 'fulfilled'
                ? attempt.value
                : {
                    memberName: recipients[index]!,
                    physicalMessageId: `${request.messageId}:g:${createHash('sha256').update(recipients[index]!).digest('hex').slice(0, 24)}`,
                    status: 'unknown',
                    reason: String(attempt.reason),
                  }
            ),
          };
          let statusPersisted = false;
          try {
            await storage.withInbox(request.teamName, 'user', async (rows, save) => {
              const row = rows.find((message) => message?.messageId === request.messageId);
              if (!row || !isDeepStrictEqual(payload(row), immutable))
                throw new GroupChatError('storage-unavailable', 'Canonical post changed');
              row.groupDeliverySummary = canonical.groupDeliverySummary!;
              await save();
              statusPersisted = true;
            });
          } catch {
            /* A saved post remains saved even if its optional result snapshot cannot be persisted. */
          }
          ports.changed?.(request.teamName);
          return { ...result(canonical), statusPersisted };
        }
      );
    },
  };
  return feature;
}
