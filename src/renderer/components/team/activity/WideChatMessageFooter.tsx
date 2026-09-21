import { memo } from 'react';

import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';

import { ActivityMessageHoverToolbar } from './ActivityMessageHoverToolbar';

interface WideChatMessageFooterProps {
  timestamp: string;
  copyText: string;
  canRevise: boolean;
  onRevise?: () => void;
  onReply?: () => void;
  onCreateTask?: () => void;
}

export const WideChatMessageFooter = memo(function WideChatMessageFooter({
  timestamp,
  copyText,
  canRevise,
  onRevise,
  onReply,
  onCreateTask,
}: WideChatMessageFooterProps): React.JSX.Element {
  return (
    <div data-wide-chat-message-footer="true" className="wide-chat-message-footer">
      <span data-wide-chat-timestamp="true" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
      <ActivityMessageHoverToolbar
        copyText={copyText}
        canRevise={canRevise}
        onRevise={onRevise}
        onReply={onReply}
        onCreateTask={onCreateTask}
        orientation="horizontal"
      />
    </div>
  );
});
