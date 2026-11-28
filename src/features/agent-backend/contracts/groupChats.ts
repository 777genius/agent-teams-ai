import type {
  GroupChatCreateRequest,
  GroupChatSendRequest,
  GroupMessageReactionDTO,
  GroupMessageReactionTarget,
  TeamGroupChatDTO,
} from '@agent-teams/legacy-agent-host/group-chats/contracts';
import type {
  GroupCatalogPage,
  GroupCommandView,
} from '@agent-teams/legacy-agent-host/group-chats/public-values';
export interface BackendGroupPayloads {
  'group.list': { cursor?: string };
  'group.create': Omit<GroupChatCreateRequest, 'teamName'>;
  'group.archive': { groupChatId: string; archived: boolean };
  'group.send': Omit<GroupChatSendRequest, 'teamName'>;
  'group.reaction.read': Omit<GroupMessageReactionTarget, 'teamName'>;
  'group.reaction.set': Omit<GroupMessageReactionTarget, 'teamName'> & { active: boolean };
  'group.lookup': Record<string, never>;
}
export type BackendGroupValue =
  | TeamGroupChatDTO[]
  | GroupCatalogPage
  | GroupMessageReactionDTO
  | GroupCommandView;
