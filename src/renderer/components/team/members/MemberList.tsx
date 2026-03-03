import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import { MemberCard } from './MemberCard';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type { LeadActivityState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface MemberListProps {
  members: ResolvedTeamMember[];
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
  onOpenTask?: (task: TeamTaskWithKanban) => void;
}

export const MemberList = ({
  members,
  memberTaskCounts,
  taskMap,
  pendingRepliesByMember,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onOpenTask,
}: MemberListProps): React.JSX.Element => {
  const activeMembers = members
    .filter((m) => !m.removedAt)
    .sort((a, b) => {
      if (a.agentType === 'team-lead') return -1;
      if (b.agentType === 'team-lead') return 1;
      return 0;
    });
  const removedMembers = members.filter((m) => m.removedAt);
  const colorMap = buildMemberColorMap(members);

  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        Solo team — lead only
      </div>
    );
  }

  const renderCard = (member: ResolvedTeamMember, isRemoved: boolean): React.JSX.Element => {
    const currentTask =
      member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
    const awaitingReply = Boolean(pendingRepliesByMember?.[member.name]);
    return (
      <MemberCard
        key={member.name}
        member={member}
        memberColor={colorMap.get(member.name) ?? 'blue'}
        taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
        isTeamAlive={isTeamAlive}
        isTeamProvisioning={isTeamProvisioning}
        leadActivity={member.agentType === 'team-lead' ? leadActivity : undefined}
        currentTask={isRemoved ? null : currentTask}
        isAwaitingReply={isRemoved ? false : awaitingReply}
        isRemoved={isRemoved}
        onOpenTask={currentTask && !isRemoved ? () => onOpenTask?.(currentTask) : undefined}
        onClick={() => onMemberClick?.(member)}
        onSendMessage={() => onSendMessage?.(member)}
        onAssignTask={() => onAssignTask?.(member)}
      />
    );
  };

  return (
    <div className="flex flex-col">
      {activeMembers.map((member) => renderCard(member, false))}
      {removedMembers.length > 0 && (
        <>
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Removed ({removedMembers.length})
          </div>
          {removedMembers.map((member) => renderCard(member, true))}
        </>
      )}
    </div>
  );
};
