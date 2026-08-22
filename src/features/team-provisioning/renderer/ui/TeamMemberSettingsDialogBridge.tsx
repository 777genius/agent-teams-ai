import { lazy, Suspense, useEffect, useRef } from 'react';

import { isCanonicalSettingsLead } from '../utils/memberSettingsPresentation';

import type { TeamMemberSettingsApi } from '../../contracts';
import type { EffortLevel, ResolvedTeamMember } from '@shared/types';

const EditTeamMemberDialog = lazy(() =>
  import('./EditTeamMemberDialog').then((module) => ({ default: module.EditTeamMemberDialog }))
);

export interface TeamMemberSettingsDialogBridgeProps {
  teamName: string;
  memberName: string;
  members: readonly ResolvedTeamMember[];
  isTeamAlive: boolean;
  isTeamProvisioning: boolean;
  projectPath?: string | null;
  updateMemberSettings: TeamMemberSettingsApi['updateMemberSettings'];
  onClose: () => void;
  onRefresh: (settings?: {
    model: string | null;
    effort: EffortLevel | null;
  }) => Promise<void> | void;
  onRelaunchRequired: () => void;
}

export const TeamMemberSettingsDialogBridge = ({
  teamName,
  memberName,
  members,
  isTeamAlive,
  isTeamProvisioning,
  projectPath,
  updateMemberSettings,
  onClose,
  onRefresh,
  onRelaunchRequired,
}: TeamMemberSettingsDialogBridgeProps): React.JSX.Element | null => {
  const currentMember = members.find((candidate) => candidate.name === memberName);
  const targetAvailable = Boolean(currentMember && !currentMember.removedAt);
  const lastMemberRef = useRef<ResolvedTeamMember | null>(
    targetAvailable ? (currentMember ?? null) : null
  );
  useEffect(() => {
    if (targetAvailable && currentMember) lastMemberRef.current = currentMember;
  }, [currentMember, targetAvailable]);
  const member = targetAvailable ? currentMember : lastMemberRef.current;
  if (!member) return null;
  const lead = members.find((candidate) => isCanonicalSettingsLead(candidate));
  const providerIds = new Set(
    members
      .filter((candidate) => !candidate.removedAt)
      .map((candidate) => candidate.providerId ?? lead?.providerId)
      .filter(Boolean)
  );

  return (
    <Suspense fallback={null}>
      <EditTeamMemberDialog
        key={`${memberName.toLowerCase()}:${member.agentId ?? 'unassigned'}`}
        open
        teamName={teamName}
        member={member}
        isTeamAlive={isTeamAlive}
        isTeamProvisioning={isTeamProvisioning}
        isMixedTeam={providerIds.size > 1}
        leadProviderId={lead?.providerId}
        leadModel={lead?.model}
        leadEffort={lead?.effort}
        projectPath={projectPath}
        targetAvailable={targetAvailable}
        updateMemberSettings={updateMemberSettings}
        isLead={isCanonicalSettingsLead(member)}
        onClose={onClose}
        onRefresh={onRefresh}
        onRelaunchRequired={onRelaunchRequired}
      />
    </Suspense>
  );
};
