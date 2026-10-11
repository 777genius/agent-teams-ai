import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';

import { DEFAULT_TEAM_GROUP_CHAT_ID } from '../../contracts';
import { GroupChatError, isGroupPhysicalId, isGroupUuid } from '../../core/domain/groupChat';
import { admitGroupCreationOriginal } from '../../core/domain/groupCreation';
import { safeGroupTeamPath } from '../infrastructure/GroupChatStorage';

import type {
  AgentGroupChatCreateRequest,
  GroupChatCreateRequest,
  TeamGroupChatDTO,
} from '../../contracts';
import type { AgentGroupCreation, GroupChat } from '../../core/domain/groupChat';
import type { TeamGroupChatsPorts } from '../composition/createTeamGroupChatsFeature';
import type { GroupChatStorage } from '../infrastructure/GroupChatStorage';

function validText(value: unknown, label: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new GroupChatError('invalid-input', `Invalid ${label}`);
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

export function createGroupCreation(
  ports: TeamGroupChatsPorts,
  storage: GroupChatStorage,
  project: (
    teamName: string,
    group: GroupChat,
    roster: string[],
    from?: string
  ) => Promise<TeamGroupChatDTO>
) {
  async function persist(request: GroupChatCreateRequest, agent?: AgentGroupChatCreateRequest) {
    validText(request.teamName, 'team name');
    if (!isGroupUuid(request.id)) throw new GroupChatError('invalid-input', 'Invalid group UUID');
    if (request.id === DEFAULT_TEAM_GROUP_CHAT_ID)
      throw new GroupChatError('reserved-group', 'The standard group destination is reserved');
    validText(request.name, 'chat name', 100);
    names(request.selectedMemberNames);
    names(request.excludedMemberNames);
    if (
      typeof request.autoIncludeNewMembers !== 'boolean' ||
      request.selectedMemberNames.some((name) => request.excludedMemberNames.includes(name))
    )
      throw new GroupChatError('invalid-input', 'Member selection overlaps');
    const payload = {
      name: request.name.trim(),
      selectedMemberNames: [...request.selectedMemberNames].sort(),
      autoIncludeNewMembers: request.autoIncludeNewMembers,
    };
    const saved = await ports.configurationOperation(request.teamName, () =>
      storage.withRegistry(request.teamName, async (groups, save) => {
        const roster = await ports.roster(request.teamName);
        if (agent && (agent.from.toLowerCase() === 'user' || !roster.includes(agent.from)))
          throw new GroupChatError('invalid-members', 'Creator must be a current configured agent');
        const existing =
          (agent
            ? groups.find((group) => group.agentCreation?.sourceMessageId === agent.sourceMessageId)
            : undefined) ?? groups.find((group) => group.id === request.id);
        if (existing) {
          if (!agent) return structuredClone(existing); // Preserve human first-ID-wins.
          const metadata = existing.agentCreation;
          if (
            !metadata ||
            metadata.sourceMessageId !== agent.sourceMessageId ||
            !isDeepStrictEqual(metadata.payload, payload)
          )
            throw new GroupChatError(
              'creation-conflict',
              'Original request already has another creation payload'
            );
          if (!metadata.recipientNames.includes(agent.from))
            throw new GroupChatError(
              'request-not-addressed',
              'Accepted original did not address this actor'
            );
          return structuredClone(existing);
        }
        if (
          request.selectedMemberNames.length < 2 ||
          request.selectedMemberNames.some((name) => name === 'user' || !roster.includes(name))
        )
          throw new GroupChatError('invalid-members', 'Select at least two current agents');
        let agentCreation: AgentGroupCreation | undefined;
        if (agent) {
          const original = await storage.readCreationOriginal(
            request.teamName,
            agent.from,
            agent.sourceMessageId
          );
          const recipients = admitGroupCreationOriginal(
            original,
            agent,
            groups,
            roster,
            (await ports.leadName?.(request.teamName)) ?? null
          );
          agentCreation = {
            sourceMessageId: agent.sourceMessageId,
            recipientNames: recipients,
            payload,
          };
        }
        const group: GroupChat = {
          id: request.id,
          name: payload.name,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          membership: request.autoIncludeNewMembers
            ? {
                kind: 'auto',
                excludedMemberNames: agent
                  ? roster.filter((name) => !request.selectedMemberNames.includes(name))
                  : [...request.excludedMemberNames],
              }
            : { kind: 'fixed', memberNames: [...request.selectedMemberNames] },
          ...(agentCreation ? { agentCreation } : {}),
        };
        groups.push(group);
        await save();
        ports.changed?.(request.teamName);
        return structuredClone(group);
      })
    );
    return project(request.teamName, saved, await ports.roster(request.teamName), agent?.from);
  }
  return {
    create: (request: GroupChatCreateRequest) => persist(request),
    async createFromAgent(request: AgentGroupChatCreateRequest) {
      if (
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some(
          (key) =>
            ![
              'teamName',
              'from',
              'sourceMessageId',
              'name',
              'selectedMemberNames',
              'autoIncludeNewMembers',
            ].includes(key)
        )
      )
        throw new GroupChatError('invalid-input', 'Unexpected agent creation field');
      validText(request.teamName, 'team name');
      validText(request.from, 'creator');
      if (
        request.autoIncludeNewMembers !== undefined &&
        typeof request.autoIncludeNewMembers !== 'boolean'
      )
        throw new GroupChatError('invalid-input', 'Invalid auto membership policy');
      if (request.from.trim() !== request.from || !isGroupPhysicalId(request.sourceMessageId))
        throw new GroupChatError('invalid-input', 'Invalid actor or original identity');
      const root = await safeGroupTeamPath(request.teamName);
      const hash = createHash('sha256')
        .update(
          JSON.stringify([
            'agent-group-creation-v1',
            root,
            request.teamName,
            request.sourceMessageId,
          ])
        )
        .digest('hex');
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return persist(
        {
          ...request,
          id,
          excludedMemberNames: [],
          autoIncludeNewMembers: request.autoIncludeNewMembers ?? true,
        },
        request
      );
    },
  };
}
