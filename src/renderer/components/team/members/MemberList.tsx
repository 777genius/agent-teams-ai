import { getMemberColor } from '@shared/constants/memberColors';

import { MemberCard } from './MemberCard';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface MemberListProps {
  members: ResolvedTeamMember[];
  memberTaskCounts?: Map<string, TaskStatusCounts>;
  taskMap?: Map<string, TeamTaskWithKanban>;
  pendingRepliesByMember?: Record<string, number>;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
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
  onMemberClick,
  onSendMessage,
  onAssignTask,
  onOpenTask,
}: MemberListProps): React.JSX.Element => {
  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        No members found
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {members.map((member, index) => {
        const currentTask =
          member.currentTaskId && taskMap ? (taskMap.get(member.currentTaskId) ?? null) : null;
        const awaitingReply = Boolean(pendingRepliesByMember?.[member.name]);
        return (
          <MemberCard
            key={member.name}
            member={member}
            memberColor={member.color ?? getMemberColor(index)}
            taskCounts={memberTaskCounts?.get(member.name.toLowerCase())}
            isTeamAlive={isTeamAlive}
            isTeamProvisioning={isTeamProvisioning}
            currentTask={currentTask}
            isAwaitingReply={awaitingReply}
            onOpenTask={currentTask ? () => onOpenTask?.(currentTask) : undefined}
            onClick={() => onMemberClick?.(member)}
            onSendMessage={() => onSendMessage?.(member)}
            onAssignTask={() => onAssignTask?.(member)}
          />
        );
      })}
    </div>
  );
};
