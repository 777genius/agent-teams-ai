import { ActivityItem } from './ActivityItem';

import type { InboxMessage } from '@shared/types';

interface ActivityTimelineProps {
  messages: InboxMessage[];
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
}

export const ActivityTimeline = ({
  messages,
  onCreateTaskFromMessage,
}: ActivityTimelineProps): React.JSX.Element => {
  if (messages.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
        <p>Нет сообщений</p>
        <p className="mt-1 text-[11px]">Отправьте сообщение участнику, чтобы увидеть активность.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {messages.slice(0, 200).map((message) => (
        <ActivityItem
          key={`${message.messageId ?? 'no-id'}-${message.timestamp}-${message.from}`}
          message={message}
          onCreateTask={onCreateTaskFromMessage}
        />
      ))}
    </div>
  );
};
