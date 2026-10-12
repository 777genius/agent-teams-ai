import {
  effectiveGroupMembers,
  GroupChatError,
  isGroupPhysicalId,
  isGroupUuid,
} from '../../core/domain/groupChat';

import type {
  GroupChatReactionRequest,
  GroupChatReactionResult,
  GroupInboundAcknowledgementTarget,
  GroupMessageReactionDTO,
  GroupMessageReactionTarget,
} from '../../contracts';
import type { GroupChat } from '../../core/domain/groupChat';
import type { GroupMessageReactions } from '../../core/domain/groupReactions';
import type { TeamGroupChatsPorts } from '../composition/createTeamGroupChatsFeature';
import type { GroupChatStorage } from '../infrastructure/GroupChatStorage';

function validateTeam(teamName: unknown): asserts teamName is string {
  if (
    typeof teamName !== 'string' ||
    !teamName ||
    teamName.length > 200 ||
    teamName.trim() !== teamName
  )
    throw new GroupChatError('invalid-input', 'Invalid team name');
}
function validateTarget(target: GroupMessageReactionTarget): void {
  validateTeam(target.teamName);
  if (!isGroupUuid(target.groupChatId) || !isGroupUuid(target.messageId))
    throw new GroupChatError('invalid-input', 'Invalid reaction target');
}
function snapshot(
  target: GroupMessageReactionTarget,
  entries: GroupMessageReactions[],
  archived: boolean
): GroupMessageReactionDTO {
  const actorNames =
    entries
      .find(
        (entry) => entry.groupChatId === target.groupChatId && entry.messageId === target.messageId
      )
      ?.actors.map((actor) => actor.name) ?? [];
  return {
    groupChatId: target.groupChatId,
    messageId: target.messageId,
    actorNames,
    hasUserReacted: actorNames.includes('user'),
    canReact: !archived,
  };
}

/** One canonical actor set, with a separate current physical consumption proof per agent. */
export function createGroupReactions(ports: TeamGroupChatsPorts, storage: GroupChatStorage) {
  async function canonical(target: GroupMessageReactionTarget): Promise<void> {
    const matches = await storage.withInbox(target.teamName, 'user', async (rows) =>
      rows.filter(
        (row) =>
          row?.messageId === target.messageId &&
          row.groupMessageId === target.messageId &&
          row.groupChatId === target.groupChatId &&
          row.groupChatProtocolVersion === 1 &&
          row.to === 'user'
      )
    );
    if (matches.length !== 1)
      throw new GroupChatError('not-found', 'Canonical group message does not exist');
  }
  async function withGroup<T>(
    teamName: string,
    groupChatId: string,
    action: (group: GroupChat) => Promise<T>
  ): Promise<T> {
    return ports.configurationOperation(teamName, () =>
      storage.withRegistry(teamName, async (groups) => {
        const group = groups.find((entry) => entry.id === groupChatId);
        if (!group) throw new GroupChatError('not-found', 'Group chat does not exist');
        return action(group);
      })
    );
  }
  return {
    async getReaction(target: GroupMessageReactionTarget): Promise<GroupMessageReactionDTO> {
      validateTarget(target);
      return withGroup(target.teamName, target.groupChatId, async (group) => {
        await canonical(target);
        return snapshot(target, await storage.readReactions(target.teamName), !!group.archivedAt);
      });
    },
    async setReaction(
      target: GroupMessageReactionTarget & { active: boolean }
    ): Promise<GroupMessageReactionDTO> {
      validateTarget(target);
      if (typeof target.active !== 'boolean')
        throw new GroupChatError('invalid-input', 'Reaction state must be boolean');
      let changed = false;
      const result = await withGroup(target.teamName, target.groupChatId, async (group) => {
        await canonical(target);
        return storage.withReactions(target.teamName, async (entries, save) => {
          let entry = entries.find(
            (row) => row.groupChatId === target.groupChatId && row.messageId === target.messageId
          );
          const active = !!entry?.actors.some((actor) => actor.name === 'user');
          if (active === target.active) return snapshot(target, entries, !!group.archivedAt);
          if (group.archivedAt) throw new GroupChatError('archived', 'Chat is archived');
          if (!entry) {
            entry = { groupChatId: target.groupChatId, messageId: target.messageId, actors: [] };
            entries.push(entry);
          }
          if (target.active)
            entry.actors.push({ name: 'user', reactedAt: new Date().toISOString() });
          else entry.actors = entry.actors.filter((actor) => actor.name !== 'user');
          await save();
          changed = true;
          return snapshot(target, entries, false);
        });
      });
      if (changed) ports.reactionChanged?.(target.teamName, target.messageId);
      return result;
    },
    async react(request: GroupChatReactionRequest): Promise<GroupChatReactionResult> {
      validateTeam(request.teamName);
      if (
        !isGroupUuid(request.groupChatId) ||
        !isGroupPhysicalId(request.relayOfMessageId) ||
        typeof request.from !== 'string' ||
        !request.from ||
        request.from.length > 200 ||
        request.from.trim() !== request.from ||
        request.from.toLowerCase() === 'user'
      )
        throw new GroupChatError(
          'invalid-input',
          'Agent reaction requires a physical inbound and configured sender'
        );
      let visibleChange = false;
      const result = await withGroup(request.teamName, request.groupChatId, async (group) => {
        const members = effectiveGroupMembers(group, await ports.roster(request.teamName));
        if (!members.includes(request.from))
          throw new GroupChatError('not-member', 'Sender is not a current chat member');
        // Admission probes stay outside every inbox lock and concern only this actor.
        const run = await ports.getRun(request.teamName, request.from);
        if (
          !run ||
          run.protocolVersion !== 1 ||
          run.groupReactionProtocolVersion !== 1 ||
          !run.runKey ||
          run.runKey.length > 500
        )
          throw new GroupChatError(
            'reaction-unsupported',
            'Current runtime does not support group acknowledgements'
          );
        const physicals = await storage.withInbox(request.teamName, request.from, async (rows) =>
          rows.filter(
            (row) =>
              row?.messageId === request.relayOfMessageId &&
              row.to === request.from &&
              row.groupChatId === group.id &&
              row.groupChatProtocolVersion === 1 &&
              row.groupMessageId !== row.messageId &&
              isGroupUuid(row.groupMessageId) &&
              row.groupRunKey === run.runKey
          )
        );
        if (physicals.length !== 1)
          throw new GroupChatError(
            'invalid-relay',
            'Reaction does not reference one current physical inbound'
          );
        const target = {
          teamName: request.teamName,
          groupChatId: group.id,
          messageId: physicals[0].groupMessageId!,
        };
        await canonical(target);
        const currentRun =
          run.provider === 'opencode' ? run : await ports.getRun(request.teamName, request.from);
        const current =
          currentRun?.runKey === run.runKey &&
          currentRun.groupReactionProtocolVersion === 1 &&
          (run.provider !== 'opencode' || (await run.isCurrent?.()) === true);
        if (!current) throw new GroupChatError('reaction-unsupported', 'Reaction runtime changed');
        return storage.withReactions(request.teamName, async (entries, save) => {
          let entry = entries.find(
            (row) => row.groupChatId === target.groupChatId && row.messageId === target.messageId
          );
          const actor = entry?.actors.find((row) => row.name === request.from);
          const sameProof =
            actor?.inboxMessageId === request.relayOfMessageId && actor.groupRunKey === run.runKey;
          if (!sameProof) {
            if (group.archivedAt) throw new GroupChatError('archived', 'Chat is archived');
            if (actor) {
              actor.inboxMessageId = request.relayOfMessageId;
              actor.groupRunKey = run.runKey;
            } else {
              if (!entry) {
                entry = {
                  groupChatId: target.groupChatId,
                  messageId: target.messageId,
                  actors: [],
                };
                entries.push(entry);
              }
              entry.actors.push({
                name: request.from,
                reactedAt: new Date().toISOString(),
                inboxMessageId: request.relayOfMessageId,
                groupRunKey: run.runKey,
              });
              visibleChange = true;
            }
            await save();
          }
          return {
            saved: true as const,
            acknowledged: true as const,
            teamName: request.teamName,
            groupChatId: target.groupChatId,
            messageId: target.messageId,
            relayOfMessageId: request.relayOfMessageId,
            from: request.from,
            groupRunKey: run.runKey,
          };
        });
      });
      if (visibleChange) ports.reactionChanged?.(request.teamName, result.messageId);
      return result;
    },
    async hasAcknowledgedInbound(target: GroupInboundAcknowledgementTarget): Promise<boolean> {
      try {
        validateTeam(target.teamName);
        if (
          !isGroupUuid(target.groupChatId) ||
          !isGroupPhysicalId(target.inboxMessageId) ||
          typeof target.memberName !== 'string' ||
          !target.memberName ||
          target.memberName.toLowerCase() === 'user' ||
          target.memberName.length > 200 ||
          typeof target.runId !== 'string' ||
          !target.runId ||
          target.runId.length > 500
        )
          return false;
        // Atomic snapshot read only: completion may already hold an inbox lock.
        const entries = await storage.readReactions(target.teamName);
        return (
          entries.flatMap((entry) =>
            entry.groupChatId === target.groupChatId
              ? entry.actors.filter(
                  (actor) =>
                    actor.name === target.memberName &&
                    actor.inboxMessageId === target.inboxMessageId &&
                    actor.groupRunKey === target.runId
                )
              : []
          ).length === 1
        );
      } catch {
        return false;
      }
    },
  };
}
