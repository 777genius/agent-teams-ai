import { Badge } from '@renderer/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, getMemberDotClass, getPresenceLabel } from '@renderer/utils/memberHelpers';
import { GitBranch, Loader2, MessageSquare, Plus } from 'lucide-react';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type { LeadActivityState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  memberColor: string;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  currentTask?: TeamTaskWithKanban | null;
  isAwaitingReply?: boolean;
  isRemoved?: boolean;
  onOpenTask?: () => void;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
}

export const MemberCard = ({
  member,
  memberColor,
  taskCounts,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  currentTask,
  isAwaitingReply,
  isRemoved,
  onOpenTask,
  onClick,
  onSendMessage,
  onAssignTask,
}: MemberCardProps): React.JSX.Element => {
  // NOTE: lead context display disabled — usage formula is inaccurate
  // const teamName = useStore((s) => s.selectedTeamName);
  // const leadContext = useStore((s) =>
  //   member.agentType === 'team-lead' && teamName ? s.leadContextByTeam[teamName] : undefined
  // );
  const dotClass = getMemberDotClass(member, isTeamAlive, isTeamProvisioning, leadActivity);
  const presenceLabel = getPresenceLabel(member, isTeamAlive, isTeamProvisioning, leadActivity);
  const colors = getTeamColorSet(memberColor);
  const pending = taskCounts?.pending ?? 0;
  const inProgress = taskCounts?.inProgress ?? 0;
  const completed = taskCounts?.completed ?? 0;
  const totalTasks = pending + inProgress + completed;
  const progressPercent = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;

  return (
    <div className={isRemoved ? 'rounded opacity-50' : 'rounded'}>
      <div
        className="group relative cursor-pointer rounded px-2 py-1.5"
        style={{
          borderLeft: `3px solid ${colors.border}`,
          backgroundColor: colors.badge,
        }}
        title={member.currentTaskId ? `Current task: ${member.currentTaskId}` : undefined}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        <div className="pointer-events-none absolute inset-0 rounded transition-colors group-hover:bg-white/5" />
        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0">
            <img
              src={agentAvatarUrl(member.name)}
              alt={member.name}
              className="size-7 rounded-full bg-[var(--color-surface-raised)]"
              loading="lazy"
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
              aria-label={presenceLabel}
            />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm">
            <span className="shrink-0 font-medium text-[var(--color-text)]">{member.name}</span>
            {member.gitBranch ? (
              <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--color-text-muted)]">
                <GitBranch size={10} />
                {member.gitBranch}
              </span>
            ) : null}
            {currentTask ? (
              <>
                <Loader2
                  className="size-3 shrink-0 animate-spin"
                  style={{ color: colors.border }}
                />
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  working on
                </span>
                <button
                  type="button"
                  className="min-w-0 shrink truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                  style={{ border: `1px solid ${colors.border}40` }}
                  title="Open task"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask?.();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenTask?.();
                    }
                  }}
                >
                  #{currentTask.id} {currentTask.subject.slice(0, 36)}
                  {currentTask.subject.length > 36 ? '…' : ''}
                </button>
              </>
            ) : null}
            {!currentTask && isAwaitingReply ? (
              <>
                <Loader2
                  className="size-3 shrink-0 animate-spin"
                  style={{ color: colors.border }}
                />
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  awaiting reply
                </span>
              </>
            ) : null}
          </div>
          {(() => {
            const roleLabel = formatAgentRole(member.role) ?? formatAgentRole(member.agentType);
            return roleLabel ? (
              <span className="hidden shrink-0 text-xs text-[var(--color-text-muted)] sm:inline">
                {roleLabel}
              </span>
            ) : null;
          })()}
          {presenceLabel === 'connecting' && !isRemoved ? (
            <Loader2
              className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]"
              aria-label="connecting"
            />
          ) : (
            <Badge
              variant="secondary"
              className={`shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none ${isRemoved ? 'bg-zinc-600 text-zinc-300' : 'text-[var(--color-text-muted)]'}`}
              title={
                isRemoved
                  ? 'This member has been removed'
                  : member.currentTaskId
                    ? `Current task: ${member.currentTaskId}`
                    : undefined
              }
            >
              {isRemoved ? 'removed' : presenceLabel}
            </Badge>
          )}
          <div
            className="shrink-0"
            title={totalTasks > 0 ? `${completed}/${totalTasks} completed` : undefined}
          >
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none"
            >
              {member.taskCount} {member.taskCount === 1 ? 'task' : 'tasks'}
            </Badge>
            {totalTasks > 0 && (
              <div className="mx-0.5 mt-0.5 h-[2px] rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
            {/* NOTE: lead context bar disabled — usage formula is inaccurate */}
          </div>
          {!isRemoved && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSendMessage?.();
                    }}
                  >
                    <MessageSquare size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Send message</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssignTask?.();
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Assign task</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
