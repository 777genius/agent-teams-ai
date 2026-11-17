import { useCallback, useState } from 'react';

import {
  closeRetainedLegacyLaunch,
  type RetainedLegacyLaunchChoice,
} from '@features/agent-backend/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { showStoppedTeamLaunchHold, stoppedTeamLaunchSelection } from './stoppedTeamLaunch';
import { useRetainedLaunchOwner } from './useRetainedLaunchOwner';

import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ResolvedTeamMember } from '@shared/types';
interface State {
  open: boolean;
  mode: TeamLaunchDialogMode;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers?: ResolvedTeamMember[];
  retainedLegacyLaunch?: RetainedLegacyLaunchChoice;
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
  const owner = useRetainedLaunchOwner(teamName);
  const openLaunchDialog = useCallback(
    (
      mode: TeamLaunchDialogMode,
      settings?: Pick<State, 'memberSettingsDraft' | 'baselineMembers'>
    ) => {
      const intent = owner.begin();
      let choice: RetainedLegacyLaunchChoice | undefined;
      void (async () => {
        try {
          const state = useStore.getState();
          const selected = state.selectedTeamData;
          const draft =
            state.selectedTeamName === teamName && state.selectedTeamError === 'TEAM_DRAFT';
          let original: Awaited<ReturnType<typeof api.teams.getData>> | undefined;
          const target = await stoppedTeamLaunchSelection(
            teamName,
            selected?.teamName === teamName ? selected.isAlive : draft ? false : undefined,
            (selectedChoice) => {
              choice = selectedChoice;
            },
            intent.signal,
            {
              mode,
              ...settings,
              onOriginalData: (data) => {
                original = data;
              },
            }
          );
          if (!owner.current(intent)) {
            void closeRetainedLegacyLaunch(choice);
            return;
          }
          if (target !== teamName) {
            const data = await api.teams.getData(target, { includeMemberBranches: false });
            if (!owner.current(intent)) {
              void closeRetainedLegacyLaunch(choice);
              return;
            }
            owner.adopt(choice);
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
            setLaunchDialogState({ open: true, mode: 'launch', ...settings });
          } else {
            owner.adopt(choice);
            setLaunchTarget(
              original
                ? {
                    teamName,
                    cwd: original.config.projectPath,
                    members: original.members.map((member) => ({
                      ...member,
                      status: member.currentTaskId ? 'active' : 'idle',
                      messageCount: 0,
                      lastActiveAt: null,
                    })),
                  }
                : undefined
            );
            setLaunchDialogState({
              open: true,
              mode: choice ? 'launch' : mode,
              ...settings,
              retainedLegacyLaunch: choice,
            });
          }
        } catch (error) {
          void closeRetainedLegacyLaunch(choice);
          if (owner.current(intent)) showStoppedTeamLaunchHold(error);
        }
      })();
    },
    [owner, teamName]
  );
  const closeLaunchDialog = useCallback(() => {
    owner.close();
    setLaunchDialogState((prev) => ({ ...prev, open: false, retainedLegacyLaunch: undefined }));
    setLaunchTarget(undefined);
  }, [owner]);
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
