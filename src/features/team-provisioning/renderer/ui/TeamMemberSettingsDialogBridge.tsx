import { useEffect, useRef } from 'react';

import { isLeadMember } from '@shared/utils/leadDetection';

import { EditTeamMemberDialog } from './EditTeamMemberDialog';

import type { ResolvedTeamMember } from '@shared/types';

interface TeamMemberSettingsDialogBridgeProps {
  teamName: string;
  memberName: string;
  members: readonly ResolvedTeamMember[];
  isTeamAlive: boolean;
  isTeamProvisioning: boolean;
  projectPath?: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onRelaunchRequired: () => void;
}

export const TeamMemberSettingsDialogBridge = ({
  teamName,
  memberName,
  members,
  isTeamAlive,
  isTeamProvisioning,
  projectPath,
  onClose,
  onRefresh,
  onRelaunchRequired,
}: TeamMemberSettingsDialogBridgeProps): React.JSX.Element | null => {
  const currentMember = members.find((candidate) => candidate.name === memberName);
  const targetAvailable = Boolean(
    currentMember && !currentMember.removedAt && !isLeadMember(currentMember)
  );
  const lastMemberRef = useRef<ResolvedTeamMember | null>(
    targetAvailable ? (currentMember ?? null) : null
  );
  useEffect(() => {
    if (targetAvailable && currentMember) lastMemberRef.current = currentMember;
  }, [currentMember, targetAvailable]);
  const member = targetAvailable ? currentMember : lastMemberRef.current;
  if (!member) return null;
  const lead = members.find((candidate) => isLeadMember(candidate));
  const providerIds = new Set(
    members
      .filter((candidate) => !candidate.removedAt)
      .map((candidate) => candidate.providerId ?? lead?.providerId)
      .filter(Boolean)
  );

  return (
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
      onClose={onClose}
      onRefresh={onRefresh}
      onRelaunchRequired={onRelaunchRequired}
    />
  );
};
