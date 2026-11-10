import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { PanelBottomOpen, Terminal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TerminalWorkspaceBottomSheetAdapter } from './TerminalWorkspaceBottomSheetAdapter';

export interface TerminalWorkspaceFloatingLauncherProps {
  teamName: string;
  bottomOffset?: number;
  className?: string;
  buttonTestId?: string;
  enabled?: boolean;
  rightOffset?: number;
}

export const TerminalWorkspaceFloatingLauncher = ({
  teamName,
  bottomOffset = 18,
  className,
  buttonTestId = 'open-terminal-floating-button',
  enabled = true,
  rightOffset = 18,
}: TerminalWorkspaceFloatingLauncherProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [mountPoint, setMountPoint] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const {
    gitBranch,
    isTeamAlive,
    messagesPanelMode,
    projectPath,
    setMessagesPanelMode,
    teamDisplayName,
  } = useStore(
    useShallow((state) => {
      const teamData = selectTeamDataForName(state, teamName);
      const nextProjectPath = teamData?.config.projectPath ?? null;
      const normalizedProjectPath = nextProjectPath ? normalizePath(nextProjectPath) : null;

      return {
        gitBranch: normalizedProjectPath
          ? (state.branchByPath[normalizedProjectPath] ?? null)
          : null,
        isTeamAlive: teamData?.isAlive,
        messagesPanelMode: state.messagesPanelMode,
        projectPath: nextProjectPath,
        setMessagesPanelMode: state.setMessagesPanelMode,
        teamDisplayName:
          teamData?.config.name ?? state.teamByName[teamName]?.displayName ?? teamName,
      };
    })
  );
  const branchSyncPaths = useMemo(
    () => (enabled && projectPath ? [projectPath] : []),
    [enabled, projectPath]
  );
  const title = t('terminalWorkspace.openTeamTerminal', {
    team: teamDisplayName || teamName,
  });

  useBranchSync(branchSyncPaths, { live: true });

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
    }
  }, [enabled]);

  const openTerminal = useCallback((): void => {
    if (messagesPanelMode === 'bottom-sheet') {
      setMessagesPanelMode('inline');
    }
    setOpen(true);
  }, [messagesPanelMode, setMessagesPanelMode]);

  if (!teamName || !enabled) {
    return null;
  }

  return (
    <>
      <div
        ref={setMountPoint}
        className="pointer-events-none fixed inset-0 z-[34]"
        aria-hidden="true"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              'absolute z-[33] size-11 rounded-full border border-sky-300/30 bg-[#08111a]/70 text-sky-100 opacity-75 shadow-[0_16px_42px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-colors hover:border-sky-300/50 hover:bg-[#0d1a26]/75 hover:text-white hover:opacity-90',
              open && 'bg-sky-400/18 border-sky-300/60 text-white opacity-85',
              className
            )}
            style={{ bottom: Math.max(10, bottomOffset), right: Math.max(10, rightOffset) }}
            aria-label={title}
            aria-pressed={open}
            data-testid={buttonTestId}
            onClick={openTerminal}
          >
            {open ? <PanelBottomOpen size={19} /> : <Terminal size={19} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {open ? t('terminalWorkspace.terminalSheetOpen') : t('terminalWorkspace.openTerminal')}
        </TooltipContent>
      </Tooltip>
      <TerminalWorkspaceBottomSheetAdapter
        open={open}
        mountPoint={mountPoint}
        teamName={teamName}
        teamDisplayName={teamDisplayName}
        projectPath={projectPath}
        gitBranch={gitBranch}
        isTeamAlive={isTeamAlive}
        onOpenChange={setOpen}
      />
    </>
  );
};
