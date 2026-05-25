import { lazy, Suspense, useCallback, useState } from 'react';

import {
  getTeamPendingRepliesState,
  setTeamPendingRepliesState,
} from '@renderer/components/team/sidebar/teamSidebarUiState';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { shouldClearPendingReplyForOpenCodeRuntimeDelivery } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { useShallow } from 'zustand/react/shallow';

const SendMessageDialog = lazy(() =>
  import('@renderer/components/team/dialogs/SendMessageDialog').then((m) => ({
    default: m.SendMessageDialog,
  }))
);

interface UseGraphSendMessageDialogResult {
  dialog: React.ReactNode;
  openSendMessage: (memberName?: string) => void;
}

function writePendingReply(teamName: string, memberName: string, sentAtMs: number): void {
  setTeamPendingRepliesState(teamName, {
    ...getTeamPendingRepliesState(teamName),
    [memberName]: sentAtMs,
  });
}

function clearPendingReply(teamName: string, memberName: string, sentAtMs: number): void {
  const previous = getTeamPendingRepliesState(teamName);
  if (previous[memberName] !== sentAtMs) return;
  const next = { ...previous };
  delete next[memberName];
  setTeamPendingRepliesState(teamName, next);
}

export function useGraphSendMessageDialog(teamName: string): UseGraphSendMessageDialogResult {
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendDialogRecipient, setSendDialogRecipient] = useState<string | undefined>(undefined);
  const {
    activeMembers,
    isTeamAlive,
    lastSendMessageResult,
    sendDebugDetails,
    sendError,
    sendTeamMessage,
    sendWarning,
    sending,
  } = useStore(
    useShallow((state) => {
      const teamData = selectTeamDataForName(state, teamName);
      return {
        activeMembers: selectResolvedMembersForTeamName(state, teamName).filter(
          (member) => !member.removedAt
        ),
        isTeamAlive: teamData?.isAlive,
        lastSendMessageResult: state.lastSendMessageResult,
        sendDebugDetails: state.sendMessageDebugDetails,
        sendError: state.sendMessageError,
        sendTeamMessage: state.sendTeamMessage,
        sendWarning: state.sendMessageWarning,
        sending: state.sendingMessage,
      };
    })
  );

  const openSendMessage = useCallback((memberName?: string): void => {
    setSendDialogRecipient(memberName);
    setSendDialogOpen(true);
  }, []);

  const closeSendMessage = useCallback((): void => {
    setSendDialogOpen(false);
    setSendDialogRecipient(undefined);
  }, []);

  return {
    openSendMessage,
    dialog: sendDialogOpen ? (
      <Suspense fallback={null}>
        <SendMessageDialog
          open={sendDialogOpen}
          teamName={teamName}
          members={activeMembers}
          defaultRecipient={sendDialogRecipient}
          isTeamAlive={isTeamAlive}
          sending={sending}
          sendError={sendError}
          sendWarning={sendWarning}
          sendDebugDetails={sendDebugDetails}
          lastResult={lastSendMessageResult}
          onSend={async (member, text, summary, attachments, actionMode, taskRefs) => {
            const sentAtMs = Date.now();
            writePendingReply(teamName, member, sentAtMs);
            try {
              const result = await sendTeamMessage(teamName, {
                member,
                text,
                summary,
                attachments,
                actionMode,
                taskRefs,
              });
              if (shouldClearPendingReplyForOpenCodeRuntimeDelivery(result?.runtimeDelivery)) {
                clearPendingReply(teamName, member, sentAtMs);
              }
              return result;
            } catch (error) {
              clearPendingReply(teamName, member, sentAtMs);
              throw error;
            }
          }}
          onClose={closeSendMessage}
        />
      </Suspense>
    ) : null,
  };
}
