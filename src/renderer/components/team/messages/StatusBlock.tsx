import { useEffect, useMemo, useState } from 'react';

import { computePendingCrossTeamReplies } from '@renderer/utils/crossTeamPendingReplies';
import { ChevronRight } from 'lucide-react';

import { ActiveTasksBlock } from '../activity/ActiveTasksBlock';
import { PendingRepliesBlock } from '../activity/PendingRepliesBlock';

import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface StatusBlockProps {
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  messages: InboxMessage[];
  pendingRepliesByMember: Record<string, number>;
  /** Where the Messages panel is rendered — 'sidebar' hides "In progress" (already visible in MemberList). */
  position?: 'sidebar' | 'inline';
  /** Overlay keeps the toggle hovering over the previous section, flow keeps it in normal layout. */
  layout?: 'overlay' | 'flow';
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

/**
 * Self-contained status section that owns its own 1-second timer for
 * cross-team pending reply TTL tracking. Isolates the timer-driven
 * re-renders from the rest of MessagesPanel / ActivityTimeline so that
 * text selection in messages is not disrupted.
 */
export const StatusBlock = ({
  members,
  tasks,
  messages,
  pendingRepliesByMember,
  position,
  layout = 'overlay',
  onMemberClick,
  onTaskClick,
}: StatusBlockProps): React.JSX.Element | null => {
  const [collapsed, setCollapsed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const pendingCrossTeamReplies = useMemo(
    () => computePendingCrossTeamReplies(messages, nowMs),
    [messages, nowMs]
  );
  const hasPendingReplies = useMemo(() => {
    const hasMemberPendingReplies = Object.keys(pendingRepliesByMember).some((name) =>
      members.some((m) => m.name === name)
    );
    return hasMemberPendingReplies || pendingCrossTeamReplies.length > 0;
  }, [members, pendingRepliesByMember, pendingCrossTeamReplies.length]);
  const hasActiveTasks = useMemo(() => {
    const tMap = new Map(tasks.map((t) => [t.id, t]));
    return members.some((m) => {
      if (!m.currentTaskId) return false;
      const task = tMap.get(m.currentTaskId);
      if (task && (task.reviewState === 'approved' || task.status === 'completed')) return false;
      return true;
    });
  }, [members, tasks]);

  /** Whether the Status block has any visible items. */
  const hasItems = useMemo(() => {
    if (hasPendingReplies) return true;
    return hasActiveTasks;
  }, [hasActiveTasks, hasPendingReplies]);

  // Only run the 1-second timer when the block actually has content to show.
  useEffect(() => {
    if (!hasItems) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasItems]);

  if (!hasItems) return null;

  const toggleButton = (
    <button
      type="button"
      className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
      onClick={() => setCollapsed((prev) => !prev)}
      aria-label={collapsed ? 'Expand status' : 'Collapse status'}
    >
      <ChevronRight
        size={12}
        className={`shrink-0 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
      />
      Status
    </button>
  );
  const flowInlineToggle = layout === 'flow' && !collapsed ? toggleButton : null;

  return (
    <>
      {layout === 'overlay' ? (
        <div className="relative h-0">
          <div className="absolute -top-[19px] right-0 z-10">{toggleButton}</div>
        </div>
      ) : collapsed ? (
        <div className="mb-2 flex justify-end">{toggleButton}</div>
      ) : null}
      {!collapsed && (
        <div className={layout === 'overlay' ? 'mt-5' : ''}>
          {hasPendingReplies ? (
            <PendingRepliesBlock
              members={members}
              pendingRepliesByMember={pendingRepliesByMember}
              pendingCrossTeamReplies={pendingCrossTeamReplies}
              headerRight={flowInlineToggle}
              onMemberClick={onMemberClick}
            />
          ) : null}
          <ActiveTasksBlock
            members={members}
            tasks={tasks}
            defaultCollapsed={position === 'sidebar'}
            headerRight={!hasPendingReplies ? flowInlineToggle : undefined}
            onMemberClick={onMemberClick}
            onTaskClick={onTaskClick}
          />
        </div>
      )}
    </>
  );
};
