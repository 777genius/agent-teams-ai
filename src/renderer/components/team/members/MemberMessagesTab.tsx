import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  buildMessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { Button } from '@renderer/components/ui/button';
import { buildInlineActivityEntries } from '@renderer/features/agent-graph/utils/buildInlineActivityEntries';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { MemberActivityFilter } from './memberDetailTypes';
import type { TimelineItem } from '@renderer/components/team/activity/LeadThoughtsGroup';
import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface MemberMessagesTabProps {
  messages: InboxMessage[];
  teamName: string;
  memberName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  initialFilter?: MemberActivityFilter;
  onCreateTask?: (subject: string, description: string) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

const MAX_MESSAGES = 100;
const MEMBER_MESSAGES_PAGE_SIZE = 50;
const FILTER_OPTIONS: readonly { value: MemberActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'comments', label: 'Comments' },
];

export const MemberMessagesTab = ({
  messages,
  teamName,
  memberName,
  members,
  tasks,
  initialFilter = 'all',
  onCreateTask,
  onTaskClick,
}: MemberMessagesTabProps): React.JSX.Element => {
  const [pagedMessages, setPagedMessages] = useState<InboxMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activityFilter, setActivityFilter] = useState<MemberActivityFilter>(initialFilter);
  const [expandedItem, setExpandedItem] = useState<TimelineItem | null>(null);
  const { readSet } = useTeamMessagesRead(teamName);
  const leadId = `lead:${teamName}`;
  const leadName = useMemo(
    () => members.find((candidate) => isLeadMember(candidate))?.name ?? `${teamName}-lead`,
    [members, teamName]
  );
  const ownerNodeId = memberName === leadName ? leadId : `member:${teamName}:${memberName}`;
  const ownerNodeIds = useMemo(() => new Set([leadId, ownerNodeId]), [leadId, ownerNodeId]);
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const messageContext = useMemo(() => buildMessageContext(members), [members]);

  useEffect(() => {
    setActivityFilter(initialFilter);
  }, [initialFilter, memberName, teamName]);

  useEffect(() => {
    let cancelled = false;
    setPagedMessages([]);
    setNextCursor(null);
    setHasMore(false);
    setLoading(true);

    void (async () => {
      try {
        const page = await api.teams.getMessagesPage(teamName, {
          limit: MEMBER_MESSAGES_PAGE_SIZE,
        });
        if (cancelled) return;
        const memberPageMessages = page.messages.filter(
          (message) => message.from === memberName || message.to === memberName
        );
        setPagedMessages(memberPageMessages);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        if (!cancelled) {
          setPagedMessages([]);
          setNextCursor(null);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamName, memberName]);

  const loadOlderMessages = useCallback(async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await api.teams.getMessagesPage(teamName, {
        beforeTimestamp: nextCursor,
        limit: MEMBER_MESSAGES_PAGE_SIZE,
      });
      const memberPageMessages = page.messages.filter(
        (message) => message.from === memberName || message.to === memberName
      );
      setPagedMessages((prev) => mergeTeamMessages(prev, memberPageMessages));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [teamName, memberName, nextCursor, loading]);

  const effectiveMessages = useMemo(
    () => mergeTeamMessages(messages, pagedMessages),
    [messages, pagedMessages]
  );

  const filteredMessages = useMemo(
    () =>
      filterTeamMessages(effectiveMessages, {
        timeWindow: null,
        filter: { from: new Set(), to: new Set(), showNoise: true },
        searchQuery: '',
      }),
    [effectiveMessages]
  );

  const activityEntries = useMemo(() => {
    const entriesByOwner = buildInlineActivityEntries({
      data: {
        members,
        tasks,
        messages: filteredMessages,
      },
      teamName,
      leadId,
      leadName,
      ownerNodeIds,
    });
    return (entriesByOwner.get(ownerNodeId) ?? []).slice(0, MAX_MESSAGES);
  }, [filteredMessages, leadId, leadName, members, ownerNodeId, ownerNodeIds, tasks, teamName]);

  const displayEntries = useMemo(() => {
    switch (activityFilter) {
      case 'messages':
        return activityEntries.filter(
          (entry) => entry.message.messageKind !== 'task_comment_notification'
        );
      case 'comments':
        return activityEntries.filter(
          (entry) => entry.message.messageKind === 'task_comment_notification'
        );
      default:
        return activityEntries;
    }
  }, [activityEntries, activityFilter]);

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

  const emptyStateText = loading
    ? 'Loading activity...'
    : activityFilter === 'comments'
      ? 'No comments for this member'
      : activityFilter === 'messages'
        ? hasMore
          ? 'No loaded messages for this member yet'
          : 'No messages with this member'
        : 'No activity with this member';

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

        {hasMore && activityFilter !== 'comments' && (
          <div className="flex justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              disabled={loading}
              onClick={() => void loadOlderMessages()}
            >
              {loading ? 'Loading...' : 'Load older messages'}
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
