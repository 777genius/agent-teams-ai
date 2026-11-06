import { useCallback, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { showStoppedTeamLaunchHold, stoppedTeamLaunchSelection } from './stoppedTeamLaunch';

import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ResolvedTeamMember } from '@shared/types';
interface State {
  open: boolean;
  mode: TeamLaunchDialogMode;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers?: ResolvedTeamMember[];
}
export function useStoppedTeamLaunchDialog(teamName: string) {
  const [launchDialogState, setLaunchDialogState] = useState<State>({
    open: false,
    mode: 'launch',
  });
  const [launchTarget, setLaunchTarget] = useState<{
    teamName: string;
    members: ResolvedTeamMember[];
    cwd?: string;
  }>();
  const original = useRef(teamName);
  original.current = teamName;
  const openLaunchDialog = useCallback(
    (mode: TeamLaunchDialogMode) => {
      void (async () => {
        try {
          const state = useStore.getState();
          const selected = state.selectedTeamData;
          const draft =
            state.selectedTeamName === teamName && state.selectedTeamError === 'TEAM_DRAFT';
          const target = await stoppedTeamLaunchSelection(
            teamName,
            selected?.teamName === teamName ? selected.isAlive : draft ? false : undefined
          );
          if (original.current !== teamName) return;
          if (target !== teamName) {
            const data = await api.teams.getData(target, { includeMemberBranches: false });
            if (original.current !== teamName) return;
            setLaunchTarget({
              teamName: target,
              members: data.members.map((member) => ({
                ...member,
                status: member.currentTaskId ? 'active' : 'idle',
                messageCount: 0,
                lastActiveAt: null,
              })),
              cwd: data.config.projectPath,
            });
            void useStore.getState().fetchTeams();
            setLaunchDialogState({ open: true, mode: 'launch' });
          } else {
            setLaunchTarget(undefined);
            setLaunchDialogState({ open: true, mode });
          }
        } catch (error) {
          showStoppedTeamLaunchHold(error);
        }
      })();
    },
    [teamName]
  );
  const closeLaunchDialog = useCallback(() => {
    setLaunchDialogState((prev) => ({ ...prev, open: false }));
    setLaunchTarget(undefined);
  }, []);
  const handleRestartTeam = useCallback(() => openLaunchDialog('relaunch'), [openLaunchDialog]);
  return {
    launchDialogState,
    setLaunchDialogState,
    launchTarget,
    openLaunchDialog,
    closeLaunchDialog,
    handleRestartTeam,
  };
}
