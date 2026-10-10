import type { TeamGroupChatsFeature } from '@features/team-group-chats/main';

export type ProvisioningGroupChatCallbacks = Pick<TeamGroupChatsFeature,
  'send' | 'claimGroupLeadInboxHandoffs' | 'readGroupCatalogPrompt'>;

/** Focused callbacks are supplied by the outer composition root. */
export function createProvisioningGroupChatPorts(source?: ProvisioningGroupChatCallbacks) {
  const required = () => {
    if (!source) throw new Error('Group chat messaging is unavailable');
    return source;
  };
  const sendReply = (input: Parameters<TeamGroupChatsFeature['send']>[0] & { from: string }) => required().send(input, input.from);
  return {
    leadRelay: {
      claimGroupLeadInboxHandoffs: <T extends Parameters<TeamGroupChatsFeature['claimGroupLeadInboxHandoffs']>[2][number]>(teamName: string, memberName: string, batch: T[]) => required().claimGroupLeadInboxHandoffs(teamName, memberName, batch),
      readGroupCatalogPrompt: (teamName: string, memberName: string) => required().readGroupCatalogPrompt(teamName, memberName),
      sendGroupReply: sendReply,
    },
    sendReply,
  };
}
