import { useCallback, useState } from 'react';

import {
  closeRetainedLegacyLaunch,
  type RetainedLegacyLaunchChoice,
} from '@features/agent-backend/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { showStoppedTeamLaunchHold, stoppedTeamLaunchSelection } from './stoppedTeamLaunch';
import { useRetainedLaunchOwner } from './useRetainedLaunchOwner';

import type { ChangeRuntimeLaunchState } from '../definitionEdit/changeRuntimeLaunch';
import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { ResolvedTeamMember } from '@shared/types';
interface State extends Omit<Partial<ChangeRuntimeLaunchState>, 'open' | 'mode'> {
  open: boolean;
  mode: TeamLaunchDialogMode;
  retainedLegacyLaunch?: RetainedLegacyLaunchChoice;
}
export function useStoppedTeamLaunchDialog(
  teamName: string,
  logicalTeamName?: string,
  retainedHistory = false
) {
  const [launchDialogState, setLaunchDialogState] = useState<State>({
    open: false,
    mode: 'launch',
  });
  const [launchTarget, setLaunchTarget] = useState<{
    teamName: string;
    members: ResolvedTeamMember[];
    cwd?: string;
  }>();
  const owner = useRetainedLaunchOwner(JSON.stringify([teamName, logicalTeamName, retainedHistory]));
  const openLaunchDialog = useCallback(
    (
      mode: TeamLaunchDialogMode,
      settings?: Omit<State, 'open' | 'mode' | 'retainedLegacyLaunch'>
    ) => {
      if (retainedHistory && logicalTeamName) {
        useStore.getState().openTeamTab(logicalTeamName);
        return;
      }
      const intent = owner.begin();
      if (logicalTeamName) {
        // Definition-owned project rosters retain their native physical runtime.
        owner.adopt(undefined);
        setLaunchTarget(undefined);
        setLaunchDialogState({ ...settings, open: true, mode: 'relaunch' });
        return;
      }
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
            setLaunchDialogState({ ...settings, open: true, mode: 'launch' });
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
              ...settings,
              open: true,
              mode: choice ? 'launch' : mode,
              retainedLegacyLaunch: choice,
            });
          }
        } catch (error) {
          void closeRetainedLegacyLaunch(choice);
          if (owner.current(intent)) showStoppedTeamLaunchHold(error);
        }
      })();
    },
    [owner, teamName, logicalTeamName, retainedHistory]
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
