import { type CSSProperties, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { createWorkspaceWebSocketTransport } from '@terminal-platform/workspace-adapter-websocket';
import { createWorkspaceKernel, type WorkspaceKernel } from '@terminal-platform/workspace-core';
import { AlertTriangle, Loader2, RefreshCw, Square, Terminal } from 'lucide-react';

import { readStoredTerminalCommandHistory as readStoredCommandHistory } from '../adapters/terminalCommandHistoryStorage';
import {
  readStoredTerminalBooleanPreference,
  readStoredTerminalPreference,
} from '../adapters/terminalWorkspacePreferencesStorage';
import { TERMINAL_COMMAND_HISTORY_LIMIT as COMMAND_HISTORY_LIMIT } from '../model/terminalCommandRuns';

import { TerminalButtonTooltip } from './TerminalButtonTooltip';
import { TerminalWorkspaceKernelView } from './TerminalWorkspaceKernelView';

import type {
  TerminalWorkspaceBootstrap,
  TerminalWorkspaceBootstrapRequest,
} from '../../contracts';

export { normalizeTerminalCommandRunEventDetail } from '../adapters/terminalCommandRunEvents';
export {
  resolveTerminalLocalAutocompleteSuggestion,
  type TerminalLocalAutocompleteCandidate,
  type TerminalLocalAutocompleteOptions,
} from '../model/terminalCommandAutocomplete';
export {
  closeSupersededTerminalCommandRuns,
  inferTerminalCommandCompletion,
  inferTerminalCommandOutputStatus,
  settleTerminalCommandRuns,
  type TerminalCommandRunPresentation,
  upsertTerminalCommandRun,
} from '../model/terminalCommandRuns';
export {
  formatTerminalPromptLabel,
  formatWorkingDirectory,
} from '../model/terminalPathPresentation';

export interface TerminalWorkspacePanelProps {
  teamName: string;
  teamDisplayName?: string | null;
  projectPath?: string | null;
  gitBranch?: string | null;
  isTeamAlive?: boolean;
  className?: string;
  surface?: 'card' | 'sheet';
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  terminalHeightClassName?: string;
  terminalHeightStyle?: CSSProperties;
  tabsPortalElement?: HTMLElement | null;
  getBootstrap: (request: TerminalWorkspaceBootstrapRequest) => Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime: (teamName: string) => Promise<void>;
}

export const TerminalWorkspacePanel = ({
  teamName,
  teamDisplayName,
  projectPath,
  gitBranch,
  isTeamAlive,
  className,
  surface = 'card',
  settingsOpen = false,
  onSettingsOpenChange,
  terminalHeightClassName,
  terminalHeightStyle,
  tabsPortalElement,
  getBootstrap,
  stopTeamRuntime,
}: TerminalWorkspacePanelProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [bootstrap, setBootstrap] = useState<TerminalWorkspaceBootstrap | null>(null);
  const [kernel, setKernel] = useState<WorkspaceKernel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void getBootstrap({ teamName, teamDisplayName, projectPath })
      .then((nextBootstrap) => {
        if (!cancelled) {
          setBootstrap(nextBootstrap);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setBootstrap(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getBootstrap, projectPath, reloadKey, teamDisplayName, teamName]);

  useEffect(() => {
    if (!bootstrap) {
      setKernel((current) => {
        if (current) void current.dispose();
        return null;
      });
      return;
    }

    const nextKernel = createWorkspaceKernel({
      transport: createWorkspaceWebSocketTransport({
        controlUrl: bootstrap.controlPlaneUrl,
        streamUrl: bootstrap.sessionStreamUrl,
      }),
      initialThemeId: readStoredTerminalPreference(teamName, 'theme'),
      initialTerminalFontScale: readStoredTerminalPreference(teamName, 'font-scale'),
      initialTerminalLineWrap: readStoredTerminalBooleanPreference(teamName, 'line-wrap'),
      initialCommandHistoryEntries: readStoredCommandHistory(teamName),
      commandHistoryLimit: COMMAND_HISTORY_LIMIT,
    });

    setKernel(nextKernel);

    return () => {
      setKernel((current) => (current === nextKernel ? null : current));
      void nextKernel.dispose();
    };
  }, [bootstrap, teamName]);

  const handleStop = async (): Promise<void> => {
    await stopTeamRuntime(teamName);
    setBootstrap(null);
    setKernel(null);
    setReloadKey((value) => value + 1);
  };

  const isSheetSurface = surface === 'sheet';

  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden',
        isSheetSurface
          ? 'flex h-full min-h-0 flex-col rounded-none border-0 bg-transparent'
          : 'rounded-md border border-border bg-surface',
        className
      )}
      data-terminal-surface={surface}
    >
      {!isSheetSurface && (
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border bg-surface-raised px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bg-background flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary">
              <Terminal size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium text-text">
                  {t('terminalWorkspace.teamTerminalTitle', {
                    team: teamDisplayName || teamName,
                  })}
                </p>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    isTeamAlive
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-sky-500/15 text-sky-300'
                  )}
                >
                  <span className="size-1.5 rounded-full bg-current" />
                  {isTeamAlive
                    ? t('terminalWorkspace.teamRuntimeBadge')
                    : t('terminalWorkspace.localShellBadge')}
                </span>
              </div>
              <p className="truncate text-[11px] text-text-muted">
                {projectPath || t('terminalWorkspace.shellDefaultDirectory')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <TerminalButtonTooltip label={t('terminalWorkspace.reloadTerminalWorkspace')}>
              <button
                type="button"
                className="hover:bg-background inline-flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:text-text"
                aria-label={t('terminalWorkspace.reloadTerminalWorkspace')}
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </button>
            </TerminalButtonTooltip>
            <TerminalButtonTooltip label={t('terminalWorkspace.stopTerminalRuntime')}>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                aria-label={t('terminalWorkspace.stopTerminalRuntime')}
                onClick={() => void handleStop()}
              >
                <Square size={13} />
              </button>
            </TerminalButtonTooltip>
          </div>
        </div>
      )}

      <div
        className={cn(
          'min-w-0',
          isSheetSurface
            ? 'flex min-h-0 flex-1 flex-col bg-transparent p-0'
            : 'min-h-[34rem] bg-[#07090d] p-2'
        )}
      >
        {loading ? (
          <TerminalWorkspaceStatus
            icon={<Loader2 size={16} className="animate-spin" />}
            title={t('terminalWorkspace.startingRuntimeTitle')}
            detail={t('terminalWorkspace.startingRuntimeDetail')}
          />
        ) : error ? (
          <TerminalWorkspaceStatus
            icon={<AlertTriangle size={16} />}
            title={t('terminalWorkspace.runtimeUnavailableTitle')}
            detail={error}
            tone="danger"
          />
        ) : kernel ? (
          <TerminalWorkspaceKernelView
            kernel={kernel}
            teamName={teamName}
            projectPath={projectPath}
            gitBranch={gitBranch}
            settingsOpen={settingsOpen}
            surface={surface}
            terminalHeightClassName={terminalHeightClassName}
            terminalHeightStyle={terminalHeightStyle}
            tabsPortalElement={tabsPortalElement}
            onSettingsOpenChange={onSettingsOpenChange}
            onReload={() => setReloadKey((value) => value + 1)}
            onStopRuntime={handleStop}
          />
        ) : (
          <TerminalWorkspaceStatus
            icon={<AlertTriangle size={16} />}
            title={t('terminalWorkspace.runtimeDisconnectedTitle')}
            detail={t('terminalWorkspace.runtimeDisconnectedDetail')}
          />
        )}
      </div>
    </div>
  );
};

const TerminalWorkspaceStatus = ({
  icon,
  title,
  detail,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone?: 'neutral' | 'danger';
}): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex min-h-[30rem] items-center justify-center rounded border border-dashed p-6 text-center',
        tone === 'danger'
          ? 'border-red-500/30 bg-red-500/5 text-red-300'
          : 'border-white/10 bg-white/[0.03] text-text-secondary'
      )}
    >
      <div className="max-w-lg">
        <div className="border-current/20 mx-auto mb-3 flex size-9 items-center justify-center rounded-md border bg-black/20">
          {icon}
        </div>
        <p className="text-sm font-medium text-current">{title}</p>
        <p className="mt-1 text-xs leading-5 text-text-muted">{detail}</p>
      </div>
    </div>
  );
};
