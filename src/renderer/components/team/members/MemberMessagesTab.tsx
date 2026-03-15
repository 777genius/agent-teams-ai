import { useMemo } from 'react';

import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';

import { ActivityItem } from '../activity/ActivityItem';

import type { InboxMessage } from '@shared/types';

interface MemberMessagesTabProps {
  messages: InboxMessage[];
  teamName: string;
  onCreateTask?: (subject: string, description: string) => void;
}

const MAX_MESSAGES = 100;

export const MemberMessagesTab = ({
  messages,
  teamName,
  onCreateTask,
}: MemberMessagesTabProps): React.JSX.Element => {
  const displayMessages = useMemo(
    () =>
      filterTeamMessages(messages, {
        timeWindow: null,
        filter: { from: new Set(), to: new Set(), showNoise: true },
        searchQuery: '',
      }).slice(0, MAX_MESSAGES),
    [messages]
  );

  if (displayMessages.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
        No messages with this member
      </div>
    );
  }

  return (
    <div className="max-h-[320px] space-y-2 overflow-y-auto">
      {displayMessages.map((msg, idx) => (
        <ActivityItem
          key={msg.messageId ?? idx}
          message={msg}
          teamName={teamName}
          onCreateTask={onCreateTask}
        />
      ))}
    </div>
  );
};
