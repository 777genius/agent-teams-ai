import {
  GroupMessageReaction,
  isCanonicalGroupReactionMessage,
} from '@features/team-group-chats/renderer';
import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';

import type { InboxMessage } from '@shared/types';

/** Shared footer for canonical group projections; attachments retain their collapse behavior. */
export const ActivityMessageFooter = ({
  teamName,
  message,
  expanded,
}: {
  teamName: string;
  message: InboxMessage;
  expanded: boolean;
}) => {
  const canonical = isCanonicalGroupReactionMessage(message);
  const showAttachments = expanded && !!message.attachments?.length && !!message.messageId;
  if (!canonical && !showAttachments) return null;
  return (
    <div
      className="px-2.5 pb-2.5"
      data-activity-message-footer={showAttachments ? 'attachments' : 'reaction'}
    >
      {showAttachments ? (
        <AttachmentDisplay
          teamName={teamName}
          messageId={message.messageId!}
          attachments={message.attachments!}
        />
      ) : null}
      {canonical ? (
        <GroupMessageReaction
          target={{
            teamName,
            groupChatId: message.groupChatId!,
            messageId: message.messageId!,
          }}
        />
      ) : null}
    </div>
  );
};
