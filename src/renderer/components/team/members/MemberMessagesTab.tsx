import { useCallback, useEffect, useMemo, useState } from 'react';

import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  buildMessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { Button } from '@renderer/components/ui/button';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { selectMemberMessagesForTeamMember } from '@renderer/store/slices/teamSlice';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { useShallow } from 'zustand/react/shallow';

import { buildMemberActivityEntries } from './memberActivityEntries';

import type { MemberActivityFilter } from './memberDetailTypes';
import type { TimelineItem } from '@renderer/components/team/activity/LeadThoughtsGroup';
import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface MemberMessagesTabProps {
  teamName: string;
  memberName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  initialFilter?: MemberActivityFilter;
  onCreateTask?: (subject: string, description: string) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

const MAX_MESSAGES = 100;
const FILTER_OPTIONS: readonly { value: MemberActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'comments', label: 'Comments' },
];

export const MemberMessagesTab = ({
  teamName,
  memberName,
  members,
  tasks,
  initialFilter = 'all',
  onCreateTask,
  onTaskClick,
}: MemberMessagesTabProps): React.JSX.Element => {
  const [activityFilter, setActivityFilter] = useState<MemberActivityFilter>(initialFilter);
  const [expandedItem, setExpandedItem] = useState<TimelineItem | null>(null);
  const { messages, messagesState, loadOlderTeamMessages } = useStore(
    useShallow((s) => ({
      messages: selectMemberMessagesForTeamMember(s, teamName, memberName),
      messagesState: teamName ? s.teamMessagesByName[teamName] : undefined,
      loadOlderTeamMessages: s.loadOlderTeamMessages,
    }))
  );
  const { readSet } = useTeamMessagesRead(teamName);
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const messageContext = useMemo(() => buildMessageContext(members), [members]);

  useEffect(() => {
    setActivityFilter(initialFilter);
  }, [initialFilter, memberName, teamName]);

  const loadOlderMessages = useCallback(async () => {
    if (!messagesState?.hasMore || messagesState.loadingHead || messagesState.loadingOlder) {
      return;
    }
    await loadOlderTeamMessages(teamName);
  }, [loadOlderTeamMessages, messagesState, teamName]);

  const loading = (messagesState?.loadingHead ?? false) || (messagesState?.loadingOlder ?? false);
  const loadingOlderMessages = messagesState?.loadingOlder ?? false;
  const hasMore = messagesState?.hasMore ?? false;

  const activityEntries = useMemo(() => {
    return buildMemberActivityEntries({
      teamName,
      memberName,
      members,
      tasks,
      messages,
    });
  }, [memberName, members, messages, tasks, teamName]);
  const visibleActivityEntries = useMemo(
    () => activityEntries.slice(0, MAX_MESSAGES),
    [activityEntries]
  );

  const displayEntries = useMemo(() => {
    switch (activityFilter) {
      case 'messages':
        return visibleActivityEntries.filter(
          (entry) => entry.message.messageKind !== 'task_comment_notification'
        );
      case 'comments':
        return visibleActivityEntries.filter(
          (entry) => entry.message.messageKind === 'task_comment_notification'
        );
      default:
        return visibleActivityEntries;
    }
  }, [activityFilter, visibleActivityEntries]);

  const expandedItemsByKey = useMemo(() => {
    const items = new Map<string, TimelineItem>();
    for (const entry of displayEntries) {
      items.set(toMessageKey(entry.message), { type: 'message', message: entry.message });
    }
    return items;
  }, [displayEntries]);

  const handleExpandItem = useCallback(
    (key: string) => {
      const next = expandedItemsByKey.get(key);
      if (next) {
        setExpandedItem(next);
      }
    },
    [expandedItemsByKey]
  );

  const handleTaskIdClick = useCallback(
    (taskId: string) => {
      const task = taskMap.get(taskId) ?? tasks.find((candidate) => candidate.displayId === taskId);
      if (task) {
        onTaskClick?.(task);
      }
    },
    [onTaskClick, taskMap, tasks]
  );

  const initialPageLoading = loading && activityEntries.length === 0;
  const emptyStateText = initialPageLoading
    ? 'Loading activity...'
    : activityFilter === 'comments'
      ? 'No comments for this member'
      : activityFilter === 'messages'
        ? hasMore
          ? 'No loaded messages for this member yet'
          : 'No messages with this member'
        : hasMore
          ? 'No loaded activity for this member yet'
          : 'No activity with this member';
  const canLoadOlderMessages = hasMore && activityFilter !== 'comments';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_OPTIONS.map((option) => {
          const isActive = activityFilter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={[
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'border-[var(--color-border-emphasis)] bg-[var(--color-surface-overlay)] text-[var(--color-text)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              ].join(' ')}
              onClick={() => setActivityFilter(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="max-h-[320px] space-y-2 overflow-y-auto">
        {displayEntries.length > 0 ? (
          displayEntries.map((entry, index) => {
            const messageKey = toMessageKey(entry.message);
            const renderProps = resolveMessageRenderProps(entry.message, messageContext);
            const timelineItem: TimelineItem = { type: 'message', message: entry.message };
            const isUnread = !entry.message.read && !readSet.has(messageKey);

            return (
              <div
                key={entry.graphItem.id}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={() => setExpandedItem(timelineItem)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setExpandedItem(timelineItem);
                  }
                }}
              >
                <ActivityItem
                  message={entry.message}
                  teamName={teamName}
                  compactHeader
                  collapseMode="managed"
                  isCollapsed
                  canToggleCollapse={false}
                  isUnread={isUnread}
                  expandItemKey={messageKey}
                  onExpand={handleExpandItem}
                  onCreateTask={onCreateTask}
                  onTaskIdClick={handleTaskIdClick}
                  memberRole={renderProps.memberRole}
                  memberColor={renderProps.memberColor}
                  recipientColor={renderProps.recipientColor}
                  memberColorMap={messageContext.colorMap}
                  localMemberNames={messageContext.localMemberNames}
                  zebraShade={index % 2 === 1}
                />
              </div>
            );
          })
        ) : (
          <div className="rounded-md border border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
            {emptyStateText}
          </div>
        )}

        {canLoadOlderMessages && (
          <div className="flex justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              aria-busy={loadingOlderMessages}
              disabled={loadingOlderMessages}
              onClick={() => void loadOlderMessages()}
            >
              Load older messages
            </Button>
          </div>
        )}
      </div>

      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExpandedItem(null);
          }
        }}
        teamName={teamName}
        members={members}
        onTaskIdClick={handleTaskIdClick}
        onCreateTaskFromMessage={onCreateTask}
      />
    </div>
  );
};
