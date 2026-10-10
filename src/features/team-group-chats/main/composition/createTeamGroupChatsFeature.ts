import { withInboxLock } from '@main/services/team/inboxLock';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';

import { effectiveGroupMembers, GroupChatError } from '../../core/domain/groupChat';
import { GroupChatStorage, safeGroupTeamPath } from '../infrastructure/GroupChatStorage';

import type {
  GroupChatCreateRequest,
  GroupChatSendRequest,
  GroupChatSendResult,
  GroupDeliveryRecipient,
  TeamGroupChatDTO,
  TeamGroupChatsAPI,
} from '../../contracts';
import type { GroupChat } from '../../core/domain/groupChat';
import type { InboxMessage } from '@shared/types';

export interface GroupChatRun {
  runKey: string;
  protocolVersion: 1;
  provider: 'native' | 'lead' | 'opencode';
}

export interface TeamGroupChatsPorts {
  roster(teamName: string): Promise<string[]>;
  getRun(teamName: string, memberName: string): Promise<GroupChatRun | null>;
  configurationOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  deliver(
    teamName: string,
    message: InboxMessage & { messageId: string; to: string },
    run: GroupChatRun,
    shouldStillWrite: () => Promise<boolean>
  ): Promise<GroupDeliveryRecipient['status']>;
  changed?(teamName: string): void;
}

export interface TeamGroupChatsFeature extends TeamGroupChatsAPI {
  list(request: { teamName: string }, from?: string): Promise<TeamGroupChatDTO[]>;
  send(request: GroupChatSendRequest, from?: string): Promise<GroupChatSendResult>;
  claimGroupLeadInboxHandoffs<T extends InboxMessage>(
    teamName: string,
    memberName: string,
    batch: T[]
  ): Promise<T[]>;
  readGroupCatalogPrompt(teamName: string, memberName: string): Promise<string>;
}

function validText(value: unknown, label: string, max = 100_000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new GroupChatError('invalid-input', `Invalid ${label}`);
}
function validateId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      value
    )
  )
    throw new GroupChatError('invalid-input', 'Invalid group/message UUID');
}
function validatePhysicalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value))
    throw new GroupChatError('invalid-input', 'Invalid group/message identity');
}
function names(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((v) => typeof v !== 'string' || !v.trim() || v.trim() !== v) ||
    new Set(value).size !== value.length
  )
    throw new GroupChatError('invalid-input', 'Invalid member selection');
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
    summary: message.summary,
    taskRefs: message.taskRefs?.length ? message.taskRefs : undefined,
    relayOfMessageId: message.relayOfMessageId,
    groupChatId: message.groupChatId,
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

export function createTeamGroupChatsFeature(
  ports: TeamGroupChatsPorts,
  storage = new GroupChatStorage()
): TeamGroupChatsFeature {
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
    if (!reason) {
      const runs = await Promise.all(
        memberNames.map(async (name) => ({ name, run: await ports.getRun(teamName, name) }))
      );
      const unavailable = runs
        .filter(({ run }) => !run || run.protocolVersion !== 1)
        .map(({ name }) => name);
      if (unavailable.length) reason = `recipient-unavailable: ${unavailable.join(', ')}`;
    }
    return { ...group, memberNames, canSend: !reason, ...(reason ? { reason } : {}) };
  }
  const feature: TeamGroupChatsFeature = {
    async list({ teamName }, from = 'user') {
      validText(teamName, 'team name', 200);
      await safeGroupTeamPath(teamName);
      const roster = await ports.roster(teamName);
      return storage.withRegistry(teamName, (groups) =>
        Promise.all(groups.map((group) => project(teamName, group, roster, from)))
      );
    },
    async create(request: GroupChatCreateRequest) {
      validText(request.teamName, 'team name', 200);
      validateId(request.id);
      validText(request.name, 'chat name', 100);
      names(request.selectedMemberNames);
      names(request.excludedMemberNames);
      if (
        typeof request.autoIncludeNewMembers !== 'boolean' ||
        request.selectedMemberNames.some((name) => request.excludedMemberNames.includes(name))
      )
        throw new GroupChatError('invalid-input', 'Member selection overlaps');
      return ports.configurationOperation(request.teamName, () =>
        storage.withRegistry(request.teamName, async (groups, save) => {
          const roster = await ports.roster(request.teamName);
          const existing = groups.find((group) => group.id === request.id);
          if (existing) return project(request.teamName, existing, roster);
          if (
            request.selectedMemberNames.length < 2 ||
            request.selectedMemberNames.some((name) => !roster.includes(name))
          )
            throw new GroupChatError('invalid-members', 'Select at least two current agents');
          const group: GroupChat = {
            id: request.id,
            name: request.name.trim(),
            createdAt: new Date().toISOString(),
            archivedAt: null,
            membership: request.autoIncludeNewMembers
              ? { kind: 'auto', excludedMemberNames: [...request.excludedMemberNames] }
              : { kind: 'fixed', memberNames: [...request.selectedMemberNames] },
          };
          groups.push(group);
          await save();
          ports.changed?.(request.teamName);
          return project(request.teamName, group, roster);
        })
      );
    },
    async setArchived({ teamName, groupChatId, archived }) {
      validText(teamName, 'team name', 200);
      validateId(groupChatId);
      if (typeof archived !== 'boolean')
        throw new GroupChatError('invalid-input', 'Archive state must be boolean');
      return storage.withRegistry(teamName, async (groups, save) => {
        const group = findGroup(groups, groupChatId);
        if (!!group.archivedAt !== archived) {
          group.archivedAt = archived ? new Date().toISOString() : null;
          await save();
          ports.changed?.(teamName);
        }
        return project(teamName, group, await ports.roster(teamName));
      });
    },
    async send(request, from = 'user') {
      validText(request.teamName, 'team name', 200);
      validateId(request.groupChatId);
      validateId(request.messageId);
      validText(request.text, 'message');
      validText(from, 'sender', 200);
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
      return withInboxLock(`group-post:${request.teamName}:${request.messageId}`, async () => {
        const immutable = payload({ ...request, from });
        const prior = await storage.withInbox(request.teamName, 'user', async (rows) =>
          rows.find((row) => row?.messageId === request.messageId)
        );
        if (prior) {
          if (
            prior.groupMessageId !== request.messageId ||
            !isDeepStrictEqual(payload(prior), immutable)
          )
            throw new GroupChatError(
              'conflicting-id',
              'Message identity is already used for another payload'
            );
          return result(prior);
        }
        const runs = new Map<string, GroupChatRun>();
        const canonical = await ports.configurationOperation(request.teamName, () =>
          storage.withRegistry(request.teamName, async (groups) => {
            const group = findGroup(groups, request.groupChatId);
            const roster = await ports.roster(request.teamName);
            const members = effectiveGroupMembers(group, roster);
            if (group.archivedAt) throw new GroupChatError('archived', 'Chat is archived');
            if (members.length < 2)
              throw new GroupChatError('minimum-members', 'Chat requires two current agents');
            if (from !== 'user' && !members.includes(from))
              throw new GroupChatError('not-member', 'Sender is not a chat member');
            for (const memberName of members) {
              const run = await ports.getRun(request.teamName, memberName);
              if (!run || run.protocolVersion !== 1)
                throw new GroupChatError(
                  'recipient-unavailable',
                  `Start a compatible runtime for ${memberName}`
                );
              runs.set(memberName, run);
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
            const recipients = members.filter((name) => name !== from);
            const message: InboxMessage = {
              ...immutable,
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
              (await ports.getRun(request.teamName, memberName))?.runKey === run.runKey;
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
                  memberName: recipients[index],
                  physicalMessageId: `${request.messageId}:g:${createHash('sha256').update(recipients[index]).digest('hex').slice(0, 24)}`,
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
            row.groupDeliverySummary = canonical.groupDeliverySummary;
            await save();
            statusPersisted = true;
          });
        } catch {
          /* A saved post remains saved even if its optional result snapshot cannot be persisted. */
        }
        ports.changed?.(request.teamName);
        return { ...result(canonical), statusPersisted };
      });
    },
    async claimGroupLeadInboxHandoffs(teamName, memberName, batch) {
      return storage.withInbox(teamName, memberName, async (rows, save) => {
        const winning: typeof batch = [];
        let changed = false;
        for (const candidate of batch) {
          if (!candidate.groupChatId) {
            winning.push(candidate);
            continue;
          }
          const row = rows.find((item) => item?.messageId === candidate.messageId);
          if (
            !row ||
            row.groupHandoffStartedAt ||
            row.read ||
            row.groupMessageId === row.messageId ||
            row.to !== memberName
          )
            continue;
          if ((await ports.getRun(teamName, memberName))?.runKey !== row.groupRunKey) continue;
          row.groupHandoffStartedAt = new Date().toISOString();
          changed = true;
          winning.push({ ...candidate, groupHandoffStartedAt: row.groupHandoffStartedAt });
        }
        if (changed) await save();
        return winning;
      });
    },
    async readGroupCatalogPrompt(teamName, memberName) {
      const catalog = await feature.list({ teamName }, memberName);
      return `Group chats (refresh with group_chat_list before proactive posting):\n${catalog.map((group) => `${JSON.stringify(group.name)} id=${group.id}; members=${group.memberNames.join(',')}; archived=${!!group.archivedAt}; canSend=${group.canSend}${group.reason ? `; reason=${group.reason}` : ''}`).join('\n')}\nUse group_chat_send with explicit groupChatId; for a reply set relayOfMessageId to the physical inbound messageId. Never route a group reply to a private chat.`;
    },
  };
  return feature;
}
