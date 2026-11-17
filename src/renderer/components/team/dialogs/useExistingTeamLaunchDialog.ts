import { useCallback, useState } from 'react';

import { closeRetainedLegacyLaunch } from '@features/agent-backend/renderer';

import { loadExistingTeamLaunchDialog } from './stoppedTeamLaunch';
import { useRetainedLaunchOwner } from './useRetainedLaunchOwner';

import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { RetainedLegacyLaunchChoice } from '@features/agent-backend/renderer';
import type { ResolvedTeamMember } from '@shared/types';
import type { MouseEvent } from 'react';

export function useExistingTeamLaunchDialog(fetchTeams: () => Promise<void>) {
  const owner = useRetainedLaunchOwner();
  const [launchDialogOpen, setOpen] = useState(false);
  const [launchDialogMode, setMode] = useState<TeamLaunchDialogMode>('launch');
  const [launchDialogTeamName, setTeam] = useState('');
  const [launchDialogMembers, setMembers] = useState<ResolvedTeamMember[]>([]);
  const [launchDialogDefaultPath, setPath] = useState<string | undefined>();
  const [retainedLegacyLaunch, setChoice] = useState<RetainedLegacyLaunchChoice>();
  const setLaunchDialogOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        owner.close();
        setChoice(undefined);
      }
      setOpen(open);
    },
    [owner]
  );
  const handleLaunchTeam = useCallback(
    async (
      teamName: string,
      projectPath: string | undefined,
      mode: TeamLaunchDialogMode,
      event: MouseEvent
    ) => {
      event.stopPropagation();
      if (!projectPath) return;
      const intent = owner.begin();
      const target = await loadExistingTeamLaunchDialog(teamName, projectPath, mode, intent.signal);
      const choice =
        target && 'retainedLegacyLaunch' in target ? target.retainedLegacyLaunch : undefined;
      if (!owner.current(intent)) {
        void closeRetainedLegacyLaunch(choice);
        return;
      }
      if (!target) return;
      owner.adopt(choice);
      if (target.teamName !== teamName) void fetchTeams();
      setMode(target.mode);
      setTeam(target.teamName);
      setMembers(target.members);
      setPath(target.projectPath);
      setChoice(choice);
      setOpen(true);
    },
    [fetchTeams, owner]
  );
  return {
    launchDialogOpen,
    setLaunchDialogOpen,
    launchDialogMode,
    launchDialogTeamName,
    launchDialogMembers,
    launchDialogDefaultPath,
    retainedLegacyLaunch,
    handleLaunchTeam,
  };
}
