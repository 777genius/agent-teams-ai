import type { TeamProviderId } from '@shared/types';

export type VisibleDirectReplyProtocol = 'send_message' | 'agent_teams_message_send';

export function resolveVisibleDirectReplyProtocol(input: {
  providerId?: TeamProviderId;
  isLeadRecipient: boolean;
  replyRecipient: string;
}): VisibleDirectReplyProtocol {
  if (
    !input.isLeadRecipient &&
    input.replyRecipient.trim().toLowerCase() === 'user' &&
    input.providerId === 'codex'
  ) {
    return 'agent_teams_message_send';
  }
  return 'send_message';
}

export function assertAttachmentsSupported(input: {
  hasAttachments: boolean;
  isLeadRecipient: boolean;
  isOpenCodeRecipient: boolean;
  isTeamAlive: boolean;
}): void {
  if (!input.hasAttachments) return;
  const supportedLiveLead = input.isLeadRecipient && input.isTeamAlive;
  const supportedLiveOpenCodeRecipient =
    !input.isLeadRecipient && input.isOpenCodeRecipient && input.isTeamAlive;
  if (supportedLiveLead || supportedLiveOpenCodeRecipient) return;
  throw new Error(
    input.isOpenCodeRecipient
      ? 'Attachments for OpenCode teammates require the team to be online'
      : 'Attachments are supported for the online team lead and online OpenCode teammates only'
  );
}
