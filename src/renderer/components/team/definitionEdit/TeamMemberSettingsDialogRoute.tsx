import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  applyCommittedLeadRuntime,
  isCanonicalSettingsLead,
  type MemberSettingsRelaunchDraft,
  memberSettingsTargetToMember,
  refreshTeamMemberSettings,
  TeamMemberSettingsDialogBridge,
} from '@features/team-provisioning/renderer';
import { api } from '@renderer/api';

import { refreshAfterDefinitionEdit } from './definitionEditActions';
import { buildDefinitionEditorInput } from './definitionEditorInput';
import { DefinitionLoadErrorDialog } from './DefinitionLoadErrorDialog';

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
  onRelaunchRequired: (draft: MemberSettingsRelaunchDraft) => void;
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

/** The saved roster of the definition, with the edited member exactly as main compares it. */
async function loadDefinitionMembers(
  logicalTeamName: string,
  memberName: string
): Promise<ResolvedTeamMember[] | 'team_missing' | 'member_missing'> {
  const [saved, target] = await Promise.all([
    api.teams.getSavedRequest(logicalTeamName),
    api.teams.getMemberSettingsTarget({ teamName: logicalTeamName, memberName }),
  ]);
  if (!saved) return 'team_missing';
  // The open project may still show a member that the definition no longer has.
  if (!target) return 'member_missing';
  const input = buildDefinitionEditorInput(saved, logicalTeamName);
  const edited = memberSettingsTargetToMember(target);
  const key = edited.name.toLowerCase();
  const others = input.currentMembers.filter((member) => member.name.toLowerCase() !== key);
  // The lead is edited as itself (its launch settings); otherwise it is the lead of the others.
  return isCanonicalSettingsLead(edited)
    ? [edited, ...others]
    : [input.leadMember, ...others, edited];
}

const DefinitionMemberSettingsDialog = ({
  logicalTeamName,
  visibleTeamName,
  memberName,
  projectPath,
  onClose,
  onRelaunchRequired,
}: Readonly<
  Pick<Props, 'memberName' | 'projectPath' | 'onClose' | 'onRelaunchRequired'> & {
    logicalTeamName: string;
    visibleTeamName: string;
  }
>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [members, setMembers] = useState<ResolvedTeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<ResolvedTeamMember[]> => {
    const next = await loadDefinitionMembers(logicalTeamName, memberName);
    if (next === 'team_missing') throw new Error(t('detail.editDefinition.notFound'));
    if (next === 'member_missing') throw new Error(t('detail.editDefinition.memberNotFound'));
    return next;
  }, [logicalTeamName, memberName, t]);

  useEffect(() => {
    let alive = true;
    void load().then(
      (next) => {
        if (alive) setMembers(next);
      },
      (error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      alive = false;
    };
  }, [load]);

  if (loadError !== null)
    return <DefinitionLoadErrorDialog message={loadError} onClose={onClose} />;
  if (!members) return null;
  return (
    <TeamMemberSettingsDialogBridge
      teamName={logicalTeamName}
      memberName={memberName}
      members={members}
      // The definition never runs; a running project makes main refuse the save.
      isTeamAlive={false}
      isTeamProvisioning={false}
      projectPath={projectPath}
      onClose={onClose}
      onRefresh={async (committedLeadRuntime) => {
        // The launch dialog of a per-project team is keyed by the team, not by the copy.
        applyCommittedLeadRuntime(logicalTeamName, committedLeadRuntime);
        setMembers(await load());
        await refreshAfterDefinitionEdit(visibleTeamName);
      }}
      onRelaunchRequired={onRelaunchRequired}
    />
  );
};
