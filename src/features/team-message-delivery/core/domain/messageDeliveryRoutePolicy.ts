export type AttachmentSupportFailure = 'runtime-recipient-offline' | 'unsupported-recipient';

export function getAttachmentSupportFailure(input: {
  hasAttachments: boolean;
  isLeadRecipient: boolean;
  isRuntimeRecipient: boolean;
  isTeamAlive: boolean;
}): AttachmentSupportFailure | null {
  if (!input.hasAttachments) return null;
  const supportedLiveLead = input.isLeadRecipient && input.isTeamAlive;
  const supportedLiveRuntimeRecipient =
    !input.isLeadRecipient && input.isRuntimeRecipient && input.isTeamAlive;
  if (supportedLiveLead || supportedLiveRuntimeRecipient) return null;
  return input.isRuntimeRecipient ? 'runtime-recipient-offline' : 'unsupported-recipient';
}
