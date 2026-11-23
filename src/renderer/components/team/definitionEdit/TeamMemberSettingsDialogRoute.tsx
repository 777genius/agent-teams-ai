import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  applyCommittedLeadRuntime,
  isCanonicalSettingsLead,
  type MemberSettingsRelaunchDraft,
  refreshTeamMemberSettings,
  TeamMemberSettingsDialogBridge,
} from '@features/team-provisioning/renderer';
import { api } from '@renderer/api';

import { refreshAfterDefinitionEdit } from './definitionEditActions';
import { DefinitionLoadErrorDialog } from './DefinitionLoadErrorDialog';
import { loadDefinitionMembers } from './definitionMemberSettings';

import type { ResolvedTeamMember } from '@shared/types';

interface Props {
  /** The team whose screen is open (for a per-project team: the copy of the open project). */
  teamName: string;
  /** Set for a per-project team: its members are edited in the team definition. */
  logicalTeamName?: string;
  memberName: string;
  members: readonly ResolvedTeamMember[];
  isTeamAlive: boolean;
  isTeamProvisioning: boolean;
  projectPath?: string | null;
  onClose: () => void;
  onRelaunchRequired: (
    draft: MemberSettingsRelaunchDraft,
    definitionMembers?: ResolvedTeamMember[]
  ) => void;
}

/**
 * The member settings dialog of the team screen. An ordinary team edits the
 * member it shows. A per-project team edits the member in its definition (the
 * saved roster of the logical team, not the open project's copy); the main
 * process accepts that only while every project is stopped and refreshes the
 * stopped copies, so the dialog is the same and so is the write.
 */
export const TeamMemberSettingsDialogRoute = ({
  teamName,
  logicalTeamName,
  memberName,
  members,
  isTeamAlive,
  isTeamProvisioning,
  projectPath,
  onClose,
  onRelaunchRequired,
}: Readonly<Props>): React.JSX.Element | null =>
  logicalTeamName ? (
    <DefinitionMemberSettingsDialog
      logicalTeamName={logicalTeamName}
      visibleTeamName={teamName}
      memberName={memberName}
      leadName={members.find(isCanonicalSettingsLead)?.name}
      projectPath={projectPath}
      onClose={onClose}
      onRelaunchRequired={onRelaunchRequired}
    />
  ) : (
    <TeamMemberSettingsDialogBridge
      teamName={teamName}
      memberName={memberName}
      members={members}
      isTeamAlive={isTeamAlive}
      isTeamProvisioning={isTeamProvisioning}
      projectPath={projectPath}
      onClose={onClose}
      onRefresh={(settings) => refreshTeamMemberSettings(teamName, settings)}
      onRelaunchRequired={onRelaunchRequired}
    />
  );

const DefinitionMemberSettingsDialog = ({
  logicalTeamName,
  visibleTeamName,
  memberName,
  leadName,
  projectPath,
  onClose,
  onRelaunchRequired,
}: Readonly<
  Pick<Props, 'memberName' | 'projectPath' | 'onClose' | 'onRelaunchRequired'> & {
    logicalTeamName: string;
    visibleTeamName: string;
    leadName?: string;
  }
>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [members, setMembers] = useState<ResolvedTeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isTeamAlive, setIsTeamAlive] = useState(false);

  const load = useCallback(async (): Promise<ResolvedTeamMember[]> => {
    const next = await loadDefinitionMembers(logicalTeamName, memberName, leadName);
    if (next === 'team_missing') throw new Error(t('detail.editDefinition.notFound'));
    if (next === 'member_missing') throw new Error(t('detail.editDefinition.memberNotFound'));
    return next;
  }, [logicalTeamName, memberName, leadName, t]);

  useEffect(() => {
    let alive = true;
    void Promise.all([load(), api.teams.processAlive(logicalTeamName)]).then(
      ([next, running]) => {
        if (alive) {
          setMembers(next);
          setIsTeamAlive(running);
        }
      },
      (error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      alive = false;
    };
  }, [load, logicalTeamName]);

  if (loadError !== null)
    return <DefinitionLoadErrorDialog message={loadError} onClose={onClose} />;
  if (!members) return null;
  return (
    <TeamMemberSettingsDialogBridge
      teamName={logicalTeamName}
      memberName={memberName}
      members={members}
      isTeamAlive={isTeamAlive}
      projectDefinition
      isTeamProvisioning={false}
      projectPath={projectPath}
      onClose={onClose}
      onRefresh={async (committedLeadRuntime) => {
        // The launch dialog of a per-project team is keyed by the team, not by the copy.
        applyCommittedLeadRuntime(logicalTeamName, committedLeadRuntime);
        setMembers(await load());
        await refreshAfterDefinitionEdit(visibleTeamName);
      }}
      onRelaunchRequired={(draft) => onRelaunchRequired(draft, members)}
    />
  );
};
