import { readNativeInboxAttachmentCapability } from '@features/member-work-sync/main';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isProcessAlive } from '@main/utils/processHealth';

import {
  admitNativeTeammateAttachmentMessage,
  isNativeAttachmentRecipient,
} from '../../application/nativeTeammateAttachmentAdmission';

import type {
  NativeTeammateAttachmentAdmissionDependencies,
  NativeTeammateAttachmentAdmissionInput,
} from '../../application/nativeTeammateAttachmentAdmission';
import type { SendMessageRequest, SendMessageResult, TeamProviderId } from '@shared/types';

type NativeTeammateAttachmentIpcInput = Omit<NativeTeammateAttachmentAdmissionInput, 'request'> &
  Pick<SendMessageRequest, 'text' | 'summary' | 'from' | 'actionMode' | 'taskRefs'>;

type NativeTeammateAttachmentIpcDependencies = Pick<
  NativeTeammateAttachmentAdmissionDependencies,
  'readRuntimeSnapshot' | 'attachmentStore' | 'runWithLiveRosterMutation'
>;

const nativeAttachmentInboxWriter = new TeamInboxWriter();

export function admitNativeTeammateAttachmentIpcMessage(
  input: NativeTeammateAttachmentIpcInput,
  dependencies: NativeTeammateAttachmentIpcDependencies
): Promise<SendMessageResult> {
  return admitNativeTeammateAttachmentMessage(
    {
      teamName: input.teamName,
      memberName: input.memberName,
      providerId: input.providerId,
      messageId: input.messageId,
      request: {
        member: input.memberName,
        text: input.text,
        summary: input.summary,
        from: input.from,
        actionMode: input.actionMode,
        source: 'user_sent',
        taskRefs: input.taskRefs,
      },
      attachments: input.attachments,
    },
    {
      teamsBasePath: getTeamsBasePath(),
      readCapability: readNativeInboxAttachmentCapability,
      readRuntimeSnapshot: dependencies.readRuntimeSnapshot,
      attachmentStore: dependencies.attachmentStore,
      writeInbox: (teamName, request, options) =>
        nativeAttachmentInboxWriter.sendNativeAttachmentMessage(teamName, request, options),
      runWithLiveRosterMutation: dependencies.runWithLiveRosterMutation,
      isProcessAlive,
    }
  );
}

export function assertAttachmentRecipientOnline(input: {
  isLeadRecipient: boolean;
  isAlive: boolean;
  isOpenCodeRecipient: boolean;
  providerId?: TeamProviderId;
}): void {
  const { isLeadRecipient, isAlive, isOpenCodeRecipient, providerId: recipientProviderId } = input;
  const supportedLiveLead = isLeadRecipient && isAlive;
  const supportedLiveOpenCodeRecipient = !isLeadRecipient && isOpenCodeRecipient && isAlive;
  const nativeRecipient = isNativeAttachmentRecipient({
    isLeadRecipient,
    providerId: recipientProviderId,
  });
  if (!supportedLiveLead && !supportedLiveOpenCodeRecipient && (!nativeRecipient || !isAlive)) {
    throw new Error(
      nativeRecipient
        ? 'Native teammate attachments require the teammate to be online on a current runtime'
        : isOpenCodeRecipient
          ? 'Attachments for OpenCode teammates require the team to be online'
          : 'Attachments are supported for the online team lead and online OpenCode teammates only'
    );
  }
}
