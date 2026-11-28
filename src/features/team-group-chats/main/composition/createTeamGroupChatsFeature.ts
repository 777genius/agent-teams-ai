import { createTeamGroupChatsFeature as createSharedFeature } from '@agent-teams/legacy-agent-host/group-chats/application';

import { GroupChatStorage } from '../infrastructure/GroupChatStorage';

import type { TeamGroupChatsPorts } from '@agent-teams/legacy-agent-host/group-chats/application';
export type {
  GroupChatRun,
  TeamGroupChatsFeature,
  TeamGroupChatsPorts,
} from '@agent-teams/legacy-agent-host/group-chats/application';
/** Legacy desktop adapter; application and policy remain portable and authoritative. */
export function createTeamGroupChatsFeature(
  ports: TeamGroupChatsPorts,
  storage = new GroupChatStorage()
) {
  return createSharedFeature(ports, storage);
}
