import { useMemo, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { DialogDescription, DialogTitle } from '@renderer/components/ui/dialog';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberLaunchPresentation,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';
import { Pencil } from 'lucide-react';

import { MemberRoleEditor } from './MemberRoleEditor';

import type {
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  ResolvedTeamMember,
} from '@shared/types';

interface MemberDetailHeaderProps {
  member: ResolvedTeamMember;
  runtimeSummary?: string;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnLivenessSource?: MemberSpawnLivenessSource;
  spawnRuntimeAlive?: boolean;
  isLaunchSettling?: boolean;
  onUpdateRole?: (newRole: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
}

export const MemberDetailHeader = ({
  member,
  runtimeSummary,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  spawnStatus,
  spawnLaunchState,
  spawnLivenessSource,
  spawnRuntimeAlive,
  isLaunchSettling,
  onUpdateRole,
  updatingRole,
}: MemberDetailHeaderProps): React.JSX.Element => {
  const [editing, setEditing] = useState(false);
  const selectedTeamName = useStore((s) => s.selectedTeamName);
  const teamMembers = useStore((s) =>
    selectedTeamName ? selectResolvedMembersForTeamName(s, selectedTeamName) : []
  );
  const avatarMap = useMemo(() => buildMemberAvatarMap(teamMembers), [teamMembers]);

  // NOTE: lead context display disabled — usage formula is inaccurate
  // const teamName = useStore((s) => s.selectedTeamName);
  // const leadContext = useStore((s) =>
  //   member.agentType === 'team-lead' && teamName ? s.leadContextByTeam[teamName] : undefined
  // );

  const colors = getTeamColorSet(member.color ?? '');
  const role = member.role || formatAgentRole(member.agentType);
  const launchPresentation = buildMemberLaunchPresentation({
    member,
    spawnStatus,
    spawnLaunchState,
    spawnLivenessSource,
    spawnRuntimeAlive,
    runtimeAdvisory: member.runtimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity,
  });
  const presenceLabel = launchPresentation.presenceLabel;
  const launchVisualState = launchPresentation.launchVisualState;
  const launchStatusLabel = launchPresentation.launchStatusLabel;
  const dotClass = launchPresentation.dotClass;
  const runtimeAdvisoryLabel = launchPresentation.runtimeAdvisoryLabel;
  const runtimeAdvisoryTitle = launchPresentation.runtimeAdvisoryTitle;
  const runtimeAdvisoryTone = launchPresentation.runtimeAdvisoryTone;
  const badgeLabel =
    runtimeAdvisoryTone === 'error' && runtimeAdvisoryLabel
      ? runtimeAdvisoryLabel
      : launchVisualState === 'runtime_pending' || launchVisualState === 'permission_pending'
        ? (launchStatusLabel ?? presenceLabel)
        : presenceLabel;

  const canEditRole =
    !isLeadMember(member) && !member.removedAt && !isTeamProvisioning && !!onUpdateRole;

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0">
        <img
          src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, 96)}
          alt={member.name}
          className="size-12 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
          aria-label={badgeLabel}
        />
      </div>
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate" style={{ color: colors.text }}>
          {displayMemberName(member.name)}
        </DialogTitle>
        <DialogDescription asChild className="mt-1 flex items-center gap-2">
          <div>
            {editing ? (
              <MemberRoleEditor
                currentRole={member.role}
                saving={updatingRole}
                onSave={async (newRole) => {
                  try {
                    await onUpdateRole?.(newRole);
                    setEditing(false);
                  } catch {
                    // stay in editing mode so user can retry
                  }
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <span>{role || 'No role'}</span>
                {canEditRole && (
                  <button
                    type="button"
                    className="inline-flex items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                    onClick={() => setEditing(true)}
                    aria-label="Edit role"
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </>
            )}
            {!editing && (
              <>
                <Badge
                  variant="secondary"
                  className={`px-1.5 py-0.5 text-[10px] font-normal leading-none ${
                    runtimeAdvisoryTone === 'error'
                      ? 'bg-red-500/15 text-red-300'
                      : 'text-[var(--color-text-muted)]'
                  }`}
                  title={runtimeAdvisoryTitle}
                >
                  {badgeLabel}
                </Badge>
                {/* NOTE: lead context token display disabled — usage formula is inaccurate */}
              </>
            )}
            {!editing && runtimeSummary ? (
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">{runtimeSummary}</div>
            ) : null}
          </div>
        </DialogDescription>
      </div>
    </div>
  );
};
