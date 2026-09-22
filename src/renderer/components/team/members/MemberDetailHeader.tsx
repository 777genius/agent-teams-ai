import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { DialogDescription, DialogTitle } from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
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
import { Pencil } from 'lucide-react';

import { MemberPresenceDot } from './MemberPresenceDot';

import type {
  LeadActivityState,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  ResolvedTeamMember,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
} from '@shared/types';

interface MemberDetailHeaderProps {
  member: ResolvedTeamMember;
  runtimeSummary?: string;
  runtimeEntry?: TeamAgentRuntimeEntry;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnLivenessSource?: MemberSpawnLivenessSource;
  spawnRuntimeAlive?: boolean;
  spawnBootstrapConfirmed?: boolean;
  spawnBootstrapStalled?: boolean;
  spawnAgentToolAccepted?: boolean;
  spawnHardFailure?: boolean;
  spawnHardFailureReason?: string;
  spawnError?: string;
  spawnRuntimeDiagnostic?: string;
  spawnLivenessKind?: TeamAgentRuntimeEntry['livenessKind'];
  spawnRuntimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  spawnFirstSpawnAcceptedAt?: string;
  spawnUpdatedAt?: string;
  isLaunchSettling?: boolean;
  onEditMember?: () => void;
}

export const MemberDetailHeader = ({
  member,
  runtimeSummary,
  runtimeEntry,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  spawnStatus,
  spawnLaunchState,
  spawnLivenessSource,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
  spawnBootstrapStalled,
  spawnAgentToolAccepted,
  spawnHardFailure,
  spawnHardFailureReason,
  spawnError,
  spawnRuntimeDiagnostic,
  spawnLivenessKind,
  spawnRuntimeDiagnosticSeverity,
  spawnFirstSpawnAcceptedAt,
  spawnUpdatedAt,
  isLaunchSettling,
  onEditMember,
}: MemberDetailHeaderProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
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
    spawnBootstrapConfirmed,
    spawnBootstrapStalled,
    spawnAgentToolAccepted,
    spawnHardFailure,
    spawnHardFailureReason,
    spawnError,
    spawnRuntimeDiagnostic,
    spawnLivenessKind,
    spawnRuntimeDiagnosticSeverity,
    spawnFirstSpawnAcceptedAt,
    spawnUpdatedAt,
    runtimeEntry,
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
      : launchVisualState === 'starting_stale' ||
          launchVisualState === 'bootstrap_stalled' ||
          launchVisualState === 'runtime_pending' ||
          launchVisualState === 'permission_pending' ||
          launchVisualState === 'shell_only' ||
          launchVisualState === 'runtime_candidate' ||
          launchVisualState === 'registered_only' ||
          launchVisualState === 'stale_runtime'
        ? (launchStatusLabel ?? presenceLabel)
        : presenceLabel;

  const canEditMember = !member.removedAt && !!onEditMember;
  const statusBadge = (
    <Badge
      variant="secondary"
      className={`px-1.5 py-0.5 text-[10px] font-normal leading-none ${
        runtimeAdvisoryTone === 'error'
          ? 'bg-red-500/15 text-red-300'
          : 'text-[var(--color-text-muted)]'
      }`}
    >
      {badgeLabel}
    </Badge>
  );

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0">
        <img
          src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, 96)}
          alt={member.name}
          className="size-12 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
        <MemberPresenceDot className={`size-3 ${dotClass}`} label={badgeLabel} />
      </div>
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate" style={{ color: colors.text }}>
          {displayMemberName(member.name)}
        </DialogTitle>
        <DialogDescription asChild className="mt-1 flex items-center gap-2">
          <div>
            <>
              <span>{role || 'No role'}</span>
              {canEditMember ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                      disabled={isTeamProvisioning}
                      onClick={onEditMember}
                      aria-label={t('members.actions.editRole')}
                    >
                      <Pencil size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isTeamProvisioning
                      ? t('detail.tooltips.editUnavailableProvisioning')
                      : t('members.actions.editRole')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {runtimeAdvisoryTitle ? (
                <Tooltip>
                  <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                  <TooltipContent side="bottom">{runtimeAdvisoryTitle}</TooltipContent>
                </Tooltip>
              ) : (
                statusBadge
              )}
              {/* NOTE: lead context token display disabled — usage formula is inaccurate */}
            </>
            {runtimeSummary ? (
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">{runtimeSummary}</div>
            ) : null}
          </div>
        </DialogDescription>
      </div>
    </div>
  );
};
