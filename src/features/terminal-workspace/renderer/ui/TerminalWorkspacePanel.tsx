import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppTranslation } from '@features/localization/renderer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { terminalPlatformThemeManifests } from '@terminal-platform/design-tokens';
import { createWorkspaceWebSocketTransport } from '@terminal-platform/workspace-adapter-websocket';
import {
  createWorkspaceKernel,
  terminalPlatformTerminalFontScales,
  type WorkspaceKernel,
} from '@terminal-platform/workspace-core';
import {
  resolveTerminalTopologyControlState,
  TerminalCommandDock,
  type TerminalCommandPresentationMetadata,
  TerminalScreen,
  TerminalWorkspace,
  useWorkspaceSnapshot,
} from '@terminal-platform/workspace-react';
import {
  AlertTriangle,
  Check,
  Folder,
  GitBranch,
  Github,
  Loader2,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  X,
} from 'lucide-react';

import type {
  TerminalWorkspaceBootstrap,
  TerminalWorkspaceBootstrapRequest,
} from '../../contracts';

export interface TerminalWorkspacePanelProps {
  teamName: string;
  teamDisplayName?: string | null;
  projectPath?: string | null;
  gitBranch?: string | null;
  isTeamAlive?: boolean;
  className?: string;
  surface?: 'card' | 'sheet';
  settingsOpen?: boolean;
  terminalHeightClassName?: string;
  terminalHeightStyle?: React.CSSProperties;
  tabsPortalElement?: HTMLElement | null;
  getBootstrap: (request: TerminalWorkspaceBootstrapRequest) => Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime: (teamName: string) => Promise<void>;
}

const COMMAND_HISTORY_LIMIT = 80;
const COMMAND_RUNS_STORAGE_LIMIT = COMMAND_HISTORY_LIMIT * 4;
const PREWARMED_TERMINAL_TAB_TITLE = '__tp_prewarmed_shell__';
const TERMINAL_TAB_PREFERENCES_VERSION = 1;
const TERMINAL_PLATFORM_GITHUB_URL = 'https://github.com/777genius/terminal-platform';
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  'gu'
);
type TerminalWorkspaceSnapshot = ReturnType<WorkspaceKernel['getSnapshot']>;
type TerminalMuxCommand = Parameters<WorkspaceKernel['commands']['dispatchMuxCommand']>[1];
type TerminalScreenElementHandle = ComponentRef<typeof TerminalScreen> & {
  followOutput?: boolean;
  requestUpdate?: () => void;
  scrollToLatestOutput?: () => void;
};
type TerminalCommandDockElementHandle = ComponentRef<typeof TerminalCommandDock>;
type TerminalMuxTab = NonNullable<
  TerminalWorkspaceSnapshot['attachedSession']
>['topology']['tabs'][number];
type TerminalMuxPaneTreeNode = TerminalMuxTab['root'];
type TerminalTabColorId = (typeof TERMINAL_TAB_COLOR_OPTIONS)[number]['id'];

interface TerminalTabColorOption {
  id: string;
  label: string;
  accent: string;
  border: string;
  background: string;
  hoverBackground: string;
}

interface TerminalTabPreferences {
  version: number;
  order: string[];
  colors: Record<string, TerminalTabColorId>;
}

export interface TerminalCommandRunPresentation extends TerminalCommandPresentationMetadata {
  clientEventId: string;
  paneId: string;
  sessionId: string;
  startedAtMs: number;
  status: NonNullable<TerminalCommandPresentationMetadata['status']>;
}

const TERMINAL_TAB_COLOR_OPTIONS = [
  {
    id: 'slate',
    label: 'Slate',
    accent: '#94a3b8',
    border: 'rgba(148, 163, 184, 0.56)',
    background: 'rgba(148, 163, 184, 0.14)',
    hoverBackground: 'rgba(148, 163, 184, 0.18)',
  },
  {
    id: 'sky',
    label: 'Sky',
    accent: '#38bdf8',
    border: 'rgba(56, 189, 248, 0.58)',
    background: 'rgba(56, 189, 248, 0.15)',
    hoverBackground: 'rgba(56, 189, 248, 0.2)',
  },
  {
    id: 'blue',
    label: 'Blue',
    accent: '#60a5fa',
    border: 'rgba(96, 165, 250, 0.58)',
    background: 'rgba(96, 165, 250, 0.15)',
    hoverBackground: 'rgba(96, 165, 250, 0.2)',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    accent: '#22d3ee',
    border: 'rgba(34, 211, 238, 0.58)',
    background: 'rgba(34, 211, 238, 0.14)',
    hoverBackground: 'rgba(34, 211, 238, 0.19)',
  },
  {
    id: 'teal',
    label: 'Teal',
    accent: '#2dd4bf',
    border: 'rgba(45, 212, 191, 0.56)',
    background: 'rgba(45, 212, 191, 0.14)',
    hoverBackground: 'rgba(45, 212, 191, 0.19)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    accent: '#34d399',
    border: 'rgba(52, 211, 153, 0.56)',
    background: 'rgba(52, 211, 153, 0.14)',
    hoverBackground: 'rgba(52, 211, 153, 0.19)',
  },
  {
    id: 'lime',
    label: 'Lime',
    accent: '#a3e635',
    border: 'rgba(163, 230, 53, 0.52)',
    background: 'rgba(163, 230, 53, 0.12)',
    hoverBackground: 'rgba(163, 230, 53, 0.17)',
  },
  {
    id: 'amber',
    label: 'Amber',
    accent: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.54)',
    background: 'rgba(251, 191, 36, 0.13)',
    hoverBackground: 'rgba(251, 191, 36, 0.18)',
  },
  {
    id: 'orange',
    label: 'Orange',
    accent: '#fb923c',
    border: 'rgba(251, 146, 60, 0.54)',
    background: 'rgba(251, 146, 60, 0.13)',
    hoverBackground: 'rgba(251, 146, 60, 0.18)',
  },
  {
    id: 'rose',
    label: 'Rose',
    accent: '#fb7185',
    border: 'rgba(251, 113, 133, 0.56)',
    background: 'rgba(251, 113, 133, 0.14)',
    hoverBackground: 'rgba(251, 113, 133, 0.19)',
  },
  {
    id: 'violet',
    label: 'Violet',
    accent: '#a78bfa',
    border: 'rgba(167, 139, 250, 0.56)',
    background: 'rgba(167, 139, 250, 0.14)',
    hoverBackground: 'rgba(167, 139, 250, 0.19)',
  },
] as const satisfies readonly TerminalTabColorOption[];

function TerminalButtonTooltip({
  children,
  label,
  side = 'top',
}: Readonly<{
  children: React.ReactElement;
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
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
  terminalHeightClassName,
  terminalHeightStyle,
  tabsPortalElement,
  getBootstrap,
  stopTeamRuntime,
}: TerminalWorkspacePanelProps): React.JSX.Element => {
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
      initialThemeId: readStoredValue(storageKey(teamName, 'theme')),
      initialTerminalFontScale: readStoredValue(storageKey(teamName, 'font-scale')),
      initialTerminalLineWrap: readStoredBoolean(storageKey(teamName, 'line-wrap')),
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
                  {teamDisplayName || teamName} terminal
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
                  {isTeamAlive ? 'team runtime' : 'local shell'}
                </span>
              </div>
              <p className="truncate text-[11px] text-text-muted">
                {projectPath || 'Default shell working directory'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <TerminalButtonTooltip label="Reload terminal workspace">
              <button
                type="button"
                className="hover:bg-background inline-flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:text-text"
                aria-label="Reload terminal workspace"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </button>
            </TerminalButtonTooltip>
            <TerminalButtonTooltip label="Stop terminal runtime">
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                aria-label="Stop terminal runtime"
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
            title="Starting terminal runtime"
            detail="Preparing the team workspace and restoring persisted terminal state."
          />
        ) : error ? (
          <TerminalWorkspaceStatus
            icon={<AlertTriangle size={16} />}
            title="Terminal runtime is unavailable"
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
            onReload={() => setReloadKey((value) => value + 1)}
            onStopRuntime={handleStop}
          />
        ) : (
          <TerminalWorkspaceStatus
            icon={<AlertTriangle size={16} />}
            title="Terminal runtime is not connected"
            detail="Reload the workspace to reconnect."
          />
        )}
      </div>
    </div>
  );
};

const TerminalWorkspaceKernelView = ({
  kernel,
  teamName,
  projectPath,
  gitBranch,
  settingsOpen,
  surface,
  terminalHeightClassName,
  terminalHeightStyle,
  tabsPortalElement,
  onReload,
  onStopRuntime,
}: {
  kernel: WorkspaceKernel;
  teamName: string;
  projectPath?: string | null;
  gitBranch?: string | null;
  settingsOpen?: boolean;
  surface: 'card' | 'sheet';
  terminalHeightClassName?: string;
  terminalHeightStyle?: React.CSSProperties;
  tabsPortalElement?: HTMLElement | null;
  onReload: () => void;
  onStopRuntime: () => Promise<void>;
}): React.JSX.Element => {
  const snapshot = useWorkspaceSnapshot(kernel);
  const isSheetSurface = surface === 'sheet';
  const autoAttachAttemptRef = useRef<string | null>(null);
  const terminalDisplay = snapshot.terminalDisplay;
  const quickCommands = useMemo(() => [], []);
  const terminalScreenElementRef = useRef<TerminalScreenElementHandle | null>(null);
  const [commandDockElement, setCommandDockElement] =
    useState<TerminalCommandDockElementHandle | null>(null);
  const [commandRuns, setCommandRuns] = useState<TerminalCommandRunPresentation[]>(() =>
    readStoredTerminalCommandRuns(teamName)
  );
  const commandHistoryPersistenceRef = useRef<{
    hasPersistedSnapshot: boolean;
    hasRestoredHistory: boolean | null;
    teamName: string;
  }>({
    hasPersistedSnapshot: false,
    hasRestoredHistory: null,
    teamName,
  });
  const activeScreen = snapshot.attachedSession?.focused_screen ?? null;
  const activeScreenLines = activeScreen?.surface.lines;
  const activeCommandSessionId =
    snapshot.selection.activeSessionId ?? snapshot.catalog.sessions[0]?.session_id ?? null;
  const activeCommandPaneId = activeScreen?.pane_id ?? null;
  const activeCommandRuns = useMemo(
    () =>
      commandRuns.filter(
        (run) => run.sessionId === activeCommandSessionId && run.paneId === activeCommandPaneId
      ),
    [activeCommandPaneId, activeCommandSessionId, commandRuns]
  );

  const scrollTerminalToLatest = useCallback((): void => {
    const scroll = (): void => {
      const screen = terminalScreenElementRef.current;
      if (!screen) {
        return;
      }

      if (typeof screen.scrollToLatestOutput === 'function') {
        screen.scrollToLatestOutput();
        return;
      }

      screen.followOutput = true;
      screen.requestUpdate?.();
      const viewport = screen.shadowRoot?.querySelector<HTMLElement>(
        '[data-testid="tp-screen-viewport"]'
      );
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    };

    scroll();
    window.requestAnimationFrame(scroll);
    window.setTimeout(scroll, 80);
  }, []);

  const terminalScreenRef = useCallback((element: TerminalScreenElementHandle | null): void => {
    terminalScreenElementRef.current = element;
    if (!element) {
      return;
    }

    element.hideShellPromptNoise = true;
    element.setAttribute('hide-shell-prompt-noise', '');
    element.requestUpdate?.();
  }, []);

  useEffect(() => {
    if (!commandDockElement) {
      return undefined;
    }

    const handleCommandSubmitted = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (detail) {
        setCommandRuns((current) => upsertTerminalCommandRun(current, detail, 'running'));
      }
      scrollTerminalToLatest();
    };
    const handleCommandStarted = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (!detail) {
        return;
      }

      setCommandRuns((current) => upsertTerminalCommandRun(current, detail, 'running'));
    };
    const handleCommandFailed = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (!detail) {
        return;
      }

      setCommandRuns((current) =>
        upsertTerminalCommandRun(
          current,
          {
            ...detail,
            durationMs: Math.max(0, Date.now() - detail.startedAtMs),
          },
          'failed'
        )
      );
    };

    commandDockElement.addEventListener('tp-terminal-command-started', handleCommandStarted);
    commandDockElement.addEventListener('tp-terminal-command-submitted', handleCommandSubmitted);
    commandDockElement.addEventListener('tp-terminal-command-failed', handleCommandFailed);
    commandDockElement.addEventListener('tp-terminal-paste-submitted', handleCommandSubmitted);

    return () => {
      commandDockElement.removeEventListener('tp-terminal-command-started', handleCommandStarted);
      commandDockElement.removeEventListener(
        'tp-terminal-command-submitted',
        handleCommandSubmitted
      );
      commandDockElement.removeEventListener('tp-terminal-command-failed', handleCommandFailed);
      commandDockElement.removeEventListener('tp-terminal-paste-submitted', handleCommandSubmitted);
    };
  }, [commandDockElement, scrollTerminalToLatest]);

  useEffect(() => {
    const screenLines = activeScreenLines?.map((line) => line.text) ?? [];
    if (screenLines.length === 0) {
      return;
    }

    setCommandRuns((current) =>
      settleScopedTerminalCommandRuns(
        current,
        activeCommandSessionId,
        activeCommandPaneId,
        screenLines,
        Date.now(),
        false
      )
    );
  }, [activeCommandPaneId, activeCommandSessionId, activeScreen?.sequence, activeScreenLines]);

  useEffect(() => {
    if (!activeCommandRuns.some((run) => run.status === 'running')) {
      return undefined;
    }

    const screenLines = activeScreenLines?.map((line) => line.text) ?? [];
    if (screenLines.length === 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setCommandRuns((current) =>
        settleScopedTerminalCommandRuns(
          current,
          activeCommandSessionId,
          activeCommandPaneId,
          screenLines,
          Date.now(),
          true
        )
      );
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    activeCommandPaneId,
    activeCommandRuns,
    activeCommandSessionId,
    activeScreen?.sequence,
    activeScreenLines,
  ]);

  useEffect(() => {
    setCommandRuns(readStoredTerminalCommandRuns(teamName));
  }, [teamName]);

  useEffect(() => {
    persistTerminalCommandRuns(teamName, commandRuns);
  }, [commandRuns, teamName]);

  useEffect(() => {
    autoAttachAttemptRef.current = null;
    void kernel.bootstrap().catch(() => undefined);
  }, [kernel]);

  useEffect(() => {
    persistValue(storageKey(teamName, 'theme'), snapshot.theme.themeId);
  }, [snapshot.theme.themeId, teamName]);

  useEffect(() => {
    persistValue(storageKey(teamName, 'font-scale'), terminalDisplay.fontScale);
    persistValue(storageKey(teamName, 'line-wrap'), String(terminalDisplay.lineWrap));
  }, [teamName, terminalDisplay.fontScale, terminalDisplay.lineWrap]);

  useEffect(() => {
    const persistence = commandHistoryPersistenceRef.current;
    if (persistence.teamName !== teamName) {
      persistence.teamName = teamName;
      persistence.hasRestoredHistory = null;
      persistence.hasPersistedSnapshot = false;
    }

    if (persistence.hasRestoredHistory === null) {
      persistence.hasRestoredHistory = (readStoredCommandHistory(teamName)?.length ?? 0) > 0;
    }

    if (
      snapshot.commandHistory.entries.length === 0 &&
      persistence.hasRestoredHistory &&
      !persistence.hasPersistedSnapshot
    ) {
      return;
    }

    persistCommandHistory(teamName, snapshot.commandHistory.entries);
    persistence.hasPersistedSnapshot = true;
    if (snapshot.commandHistory.entries.length > 0) {
      persistence.hasRestoredHistory = false;
    }
  }, [snapshot.commandHistory.entries, teamName]);

  useEffect(() => {
    const targetSessionId =
      snapshot.selection.activeSessionId ?? snapshot.catalog.sessions[0]?.session_id ?? null;
    if (snapshot.connection.state !== 'ready' || !targetSessionId) {
      autoAttachAttemptRef.current = null;
      return;
    }

    if (!snapshot.selection.activeSessionId) {
      kernel.commands.setActiveSession(targetSessionId);
    }

    if (autoAttachAttemptRef.current === targetSessionId) {
      return;
    }

    autoAttachAttemptRef.current = targetSessionId;
    void kernel.commands.attachSession(targetSessionId).catch(() => {
      autoAttachAttemptRef.current = null;
    });
  }, [
    kernel.commands,
    snapshot.catalog.sessions,
    snapshot.connection.state,
    snapshot.selection.activeSessionId,
  ]);

  const tabs = (
    <TerminalMuxTabs
      kernel={kernel}
      snapshot={snapshot}
      teamName={teamName}
      placement={tabsPortalElement ? 'sheet-header' : 'console'}
    />
  );

  return (
    <div
      className={cn(
        'agent-team-terminal-console flex min-w-0 flex-col overflow-hidden',
        isSheetSurface
          ? 'rounded-none border-0 bg-transparent'
          : 'rounded-md border border-white/10 bg-[#07090d]',
        terminalHeightClassName ?? 'h-[min(72vh,48rem)] min-h-[32rem]'
      )}
      data-surface={surface}
      style={terminalHeightStyle}
    >
      <style>
        {`
          .agent-team-terminal-console tp-terminal-screen::part(screen-chrome) {
            display: none;
          }

          .agent-team-terminal-console tp-terminal-screen::part(line-number) {
            display: none;
          }

          .agent-team-terminal-console tp-terminal-workspace {
            display: block;
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-workspace::part(body),
          .agent-team-terminal-console tp-terminal-workspace::part(content),
          .agent-team-terminal-console tp-terminal-workspace::part(operations-deck),
          .agent-team-terminal-console tp-terminal-workspace::part(terminal-column) {
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-workspace::part(terminal-column) {
            --tp-workspace-terminal-column-min-height: 0;
            height: 100%;
          }

          .agent-team-terminal-console tp-terminal-screen::part(screen),
          .agent-team-terminal-console tp-terminal-screen::part(screen-lines) {
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-screen {
            display: block;
            height: 100%;
            min-height: 0;
            overflow: hidden;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen {
            --tp-terminal-screen-panel-padding: 0;
            --tp-terminal-screen-panel-padding-bottom: 0;
            --tp-terminal-screen-panel-shadow: none;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(body),
          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(content),
          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(operations-deck) {
            gap: 0;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen::part(screen) {
            border: 0;
            background: transparent;
            box-shadow: none;
            backdrop-filter: none;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen::part(screen-lines) {
            border: 0;
            box-shadow: none;
            background: transparent;
            padding: 0;
            backdrop-filter: none;
          }

          .agent-team-terminal-console tp-terminal-command-dock {
            display: block;
            min-width: 0;
          }

          .agent-team-terminal-console tp-terminal-command-dock::part(command-dock) {
            padding-top: 0;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-command-dock::part(command-dock) {
            border: 0;
            background: transparent;
            padding: 0 1rem 0.25rem;
            backdrop-filter: none;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-command-dock::part(composer) {
            background: rgba(5, 8, 13, 0.24);
            border-color: rgba(125, 211, 252, 0.28);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
            backdrop-filter: blur(18px);
          }

          .agent-team-terminal-console tp-terminal-command-dock::part(status),
          .agent-team-terminal-console tp-terminal-command-dock::part(command-history),
          .agent-team-terminal-console tp-terminal-command-dock::part(session-actions),
          .agent-team-terminal-console tp-terminal-command-dock::part(terminal-accessories) {
            display: none;
          }
        `}
      </style>
      {settingsOpen ? (
        <TerminalWorkspaceSettingsPanel
          kernel={kernel}
          onReload={onReload}
          onStopRuntime={onStopRuntime}
          snapshot={snapshot}
        />
      ) : null}
      {tabsPortalElement ? createPortal(tabs, tabsPortalElement) : tabs}
      <TerminalWorkspace
        autoFocusCommandInput
        className="min-h-0 flex-1"
        inspectorMode="hidden"
        kernel={kernel}
        layoutPreset="classic"
        navigationMode="hidden"
        quickCommands={quickCommands}
      >
        <div slot="status-bar" className="h-0 min-h-0 overflow-hidden" aria-hidden="true" />
        <div slot="tab-strip" className="h-0 min-h-0 overflow-hidden" aria-hidden="true" />
        <TerminalScreen
          ref={terminalScreenRef}
          slot="screen"
          hideShellPromptNoise
          kernel={kernel}
          placement="terminal"
          terminalPromptLabel={formatTerminalPromptLabel(projectPath)}
          commandPresentationMetadata={activeCommandRuns}
        />
        <div slot="command-dock" className="grid min-w-0 shrink-0 grid-rows-[auto_auto]">
          <TerminalWorkingDirectoryBar projectPath={projectPath} gitBranch={gitBranch} />
          <TerminalCommandDock
            ref={setCommandDockElement}
            autoFocusInput
            kernel={kernel}
            placement="terminal"
            quickCommands={quickCommands}
          />
        </div>
      </TerminalWorkspace>
    </div>
  );
};

const TerminalMuxTabs = ({
  kernel,
  snapshot,
  teamName,
  placement = 'console',
}: {
  kernel: WorkspaceKernel;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  placement?: 'console' | 'sheet-header';
}): React.JSX.Element => {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeCandidate, setCloseCandidate] = useState<TerminalMuxTab | null>(null);
  const [tabPreferences, setTabPreferences] = useState<TerminalTabPreferences>(() =>
    readStoredTerminalTabPreferences(teamName)
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const prewarmInFlightRef = useRef<string | null>(null);
  const prewarmFailedSessionRef = useRef<string | null>(null);
  const topology = snapshot.attachedSession?.topology ?? null;
  const controls = resolveTerminalTopologyControlState(snapshot);
  const tabs = topology?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !isPrewarmedTerminalTab(tab));
  const visibleTabIdsKey = visibleTabs.map((tab) => tab.tab_id).join('\u001f');
  const orderedVisibleTabs = useMemo(
    () => orderTerminalTabsByPreference(visibleTabs, tabPreferences.order),
    [tabPreferences.order, visibleTabs]
  );
  const prewarmedTab = tabs.find(isPrewarmedTerminalTab) ?? null;
  const prewarmedTabId = prewarmedTab?.tab_id ?? null;
  const activeSessionId = controls.activeSessionId;
  const activeTabId =
    controls.activeTab?.tab_id ?? topology?.focused_tab ?? tabs[0]?.tab_id ?? null;
  const activeVisibleTabId = visibleTabs.some((tab) => tab.tab_id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.tab_id ?? null);
  const busy = pendingAction !== null;
  const headerPlacement = placement === 'sheet-header';
  const canCloseVisibleTabs = controls.canCloseTab && visibleTabs.length > 1;

  const updateTabPreferences = useCallback(
    (updater: (current: TerminalTabPreferences) => TerminalTabPreferences): void => {
      setTabPreferences((current) => {
        const next = updater(current);
        if (areTerminalTabPreferencesEqual(current, next)) {
          return current;
        }
        persistTerminalTabPreferences(teamName, next);
        return next;
      });
    },
    [teamName]
  );

  const runMuxCommands = async (
    actionId: string,
    commands: readonly TerminalMuxCommand[]
  ): Promise<void> => {
    if (busy || !activeSessionId) {
      return;
    }

    setPendingAction(actionId);
    setError(null);
    try {
      for (const command of commands) {
        await kernel.commands.dispatchMuxCommand(activeSessionId, command);
      }
      await kernel.commands.attachSession(activeSessionId);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const runMuxCommand = async (actionId: string, command: TerminalMuxCommand): Promise<void> => {
    await runMuxCommands(actionId, [command]);
  };

  useEffect(() => {
    setTabPreferences(readStoredTerminalTabPreferences(teamName));
  }, [teamName]);

  useEffect(() => {
    if (visibleTabs.length === 0) {
      return;
    }

    updateTabPreferences((current) => normalizeTerminalTabPreferences(current, visibleTabs));
  }, [updateTabPreferences, visibleTabIdsKey, visibleTabs]);

  useEffect(() => {
    if (!editingTabId) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingTabId]);

  const focusTab = async (tabId: string): Promise<void> => {
    if (!controls.canFocusTab || tabId === activeTabId) {
      return;
    }

    await runMuxCommand(`focus-tab:${tabId}`, { kind: 'focus_tab', tab_id: tabId });
  };

  const createTab = async (): Promise<void> => {
    if (!controls.canCreateTab) {
      return;
    }

    const nextTabTitle = formatNextMuxTabTitle(visibleTabs);

    if (prewarmedTab && controls.canFocusTab && controls.canRenameTab) {
      await runMuxCommands('activate-prewarmed-tab', [
        {
          kind: 'rename_tab',
          tab_id: prewarmedTab.tab_id,
          title: nextTabTitle,
        },
        { kind: 'focus_tab', tab_id: prewarmedTab.tab_id },
      ]);
      return;
    }

    await runMuxCommand('new-tab', {
      kind: 'new_tab',
      title: nextTabTitle,
    });
  };

  const closeTab = async (tab: TerminalMuxTab): Promise<void> => {
    if (!canCloseVisibleTabs || isPrewarmedTerminalTab(tab)) {
      return;
    }

    await runMuxCommand(`close-tab:${tab.tab_id}`, { kind: 'close_tab', tab_id: tab.tab_id });
  };

  const requestCloseTab = async (tab: TerminalMuxTab): Promise<void> => {
    if (!canCloseVisibleTabs || busy || isPrewarmedTerminalTab(tab)) {
      return;
    }

    if (hasTerminalTabHistory(snapshot, tab)) {
      setCloseCandidate(tab);
      return;
    }

    await closeTab(tab);
  };

  const startRenameTab = (tab: TerminalMuxTab, label: string): void => {
    if (!controls.canRenameTab || busy || isPrewarmedTerminalTab(tab)) {
      return;
    }

    setEditingTabId(tab.tab_id);
    setEditingTitle(tab.title?.trim() || label);
  };

  const cancelRenameTab = (): void => {
    setEditingTabId(null);
    setEditingTitle('');
  };

  const commitRenameTab = async (): Promise<void> => {
    const tabId = editingTabId;
    const title = editingTitle.trim();
    const tab = visibleTabs.find((candidate) => candidate.tab_id === tabId);
    if (!tabId || !tab || !title) {
      cancelRenameTab();
      return;
    }

    cancelRenameTab();
    if (title === (tab.title?.trim() || '')) {
      return;
    }

    await runMuxCommand(`rename-tab:${tab.tab_id}`, {
      kind: 'rename_tab',
      tab_id: tab.tab_id,
      title,
    });
  };

  const setTabColor = (tabId: string, colorId: TerminalTabColorId): void => {
    updateTabPreferences((current) => ({
      ...current,
      colors: {
        ...current.colors,
        [tabId]: colorId,
      },
    }));
  };

  const reorderTabs = (
    sourceTabId: string,
    targetTabId: string,
    placementMode: 'before' | 'after'
  ): void => {
    if (sourceTabId === targetTabId) {
      return;
    }

    updateTabPreferences((current) => {
      const nextOrder = reorderTerminalTabsById(
        current.order,
        visibleTabs,
        sourceTabId,
        targetTabId,
        placementMode
      );
      if (areStringArraysEqual(current.order, nextOrder)) {
        return current;
      }
      return {
        ...current,
        order: nextOrder,
      };
    });
  };

  const handleTabDragStart = (
    event: React.DragEvent<HTMLDivElement>,
    tab: TerminalMuxTab
  ): void => {
    if (editingTabId === tab.tab_id || busy) {
      event.preventDefault();
      return;
    }

    setDraggingTabId(tab.tab_id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-terminal-tab-id', tab.tab_id);
    event.dataTransfer.setData('text/plain', tab.tab_id);
  };

  const handleTabDragOver = (event: React.DragEvent<HTMLDivElement>, targetTabId: string): void => {
    const sourceTabId =
      draggingTabId || event.dataTransfer.getData('application/x-terminal-tab-id');
    if (!sourceTabId || sourceTabId === targetTabId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const placementMode = event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
    reorderTabs(sourceTabId, targetTabId, placementMode);
  };

  const handleTabDrop = (event: React.DragEvent<HTMLDivElement>, targetTabId: string): void => {
    const sourceTabId =
      draggingTabId || event.dataTransfer.getData('application/x-terminal-tab-id');
    if (!sourceTabId || sourceTabId === targetTabId) {
      setDraggingTabId(null);
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placementMode = event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
    reorderTabs(sourceTabId, targetTabId, placementMode);
    setDraggingTabId(null);
  };

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeVisibleTabId ||
      !controls.canFocusTab ||
      busy ||
      prewarmedTabId === null ||
      activeTabId !== prewarmedTabId
    ) {
      return;
    }

    const restoreKey = `${activeSessionId}:restore:${prewarmedTabId}:${activeVisibleTabId}`;
    if (prewarmInFlightRef.current === restoreKey) {
      return;
    }

    prewarmInFlightRef.current = restoreKey;
    void (async () => {
      try {
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        await kernel.commands.attachSession(activeSessionId);
      } finally {
        if (prewarmInFlightRef.current === restoreKey) {
          prewarmInFlightRef.current = null;
        }
      }
    })();
  }, [
    activeSessionId,
    activeTabId,
    activeVisibleTabId,
    busy,
    controls.canFocusTab,
    kernel,
    prewarmedTabId,
  ]);

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeVisibleTabId ||
      !controls.canCreateTab ||
      !controls.canFocusTab ||
      busy ||
      prewarmedTabId !== null ||
      prewarmFailedSessionRef.current === activeSessionId
    ) {
      return;
    }

    const prewarmKey = `${activeSessionId}:prewarm:${activeVisibleTabId}:${tabs.length}`;
    if (prewarmInFlightRef.current === prewarmKey) {
      return;
    }

    prewarmInFlightRef.current = prewarmKey;
    void (async () => {
      try {
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'new_tab',
          title: PREWARMED_TERMINAL_TAB_TITLE,
        });
        await kernel.commands.attachSession(activeSessionId);
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        await kernel.commands.attachSession(activeSessionId);
        prewarmFailedSessionRef.current = null;
      } catch {
        prewarmFailedSessionRef.current = activeSessionId;
      } finally {
        if (prewarmInFlightRef.current === prewarmKey) {
          prewarmInFlightRef.current = null;
        }
      }
    })();
  }, [
    activeSessionId,
    activeVisibleTabId,
    busy,
    controls.canCreateTab,
    controls.canFocusTab,
    kernel,
    prewarmedTabId,
    tabs.length,
  ]);

  return (
    <>
      <div
        className={cn(
          'min-w-0 shrink-0',
          headerPlacement
            ? 'bg-transparent px-0 pt-0'
            : 'border-b border-white/10 bg-[#0b0f16] px-2 pt-1'
        )}
        data-testid="agent-team-terminal-mux-tabs"
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest('button,input')) {
            event.stopPropagation();
          }
        }}
      >
        <div
          className={cn(
            'flex min-w-0 gap-1',
            headerPlacement ? 'min-h-7 items-end' : 'min-h-8 items-end'
          )}
        >
          <div
            className={cn(
              'flex min-w-0 flex-1 gap-1 overflow-x-auto',
              headerPlacement ? 'items-end' : 'items-end'
            )}
            role="tablist"
            aria-label="Terminal tabs"
          >
            {visibleTabs.length === 0 ? (
              headerPlacement ? (
                <span className="sr-only">No terminal tabs</span>
              ) : (
                <span className="px-2 py-1.5 text-xs text-slate-500">No terminal tabs</span>
              )
            ) : (
              orderedVisibleTabs.map((tab, index) => {
                const label = formatMuxTabTitle(tab, index);
                const active = tab.tab_id === activeVisibleTabId;
                const pendingFocus = pendingAction === `focus-tab:${tab.tab_id}`;
                const pendingClose = pendingAction === `close-tab:${tab.tab_id}`;
                const closeLabel = canCloseVisibleTabs
                  ? `Close terminal tab ${label}`
                  : 'Create another tab before closing this one';
                const explicitColorId = tabPreferences.colors[tab.tab_id];
                const color = resolveTerminalTabColor(explicitColorId);
                const editing = editingTabId === tab.tab_id;
                const tabColorStyle =
                  active || explicitColorId
                    ? {
                        backgroundColor: color.background,
                        borderColor: color.border,
                        borderBottomColor: active ? 'transparent' : color.border,
                      }
                    : undefined;
                return (
                  <ContextMenu key={`${tab.tab_id}:${index}`}>
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          'inline-grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_auto] overflow-hidden border text-xs transition-colors',
                          headerPlacement
                            ? 'max-w-40 rounded-b-none rounded-t-md'
                            : 'max-w-44 rounded-b-none rounded-t-md',
                          active
                            ? 'relative z-10 border-b-transparent text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                            : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200',
                          draggingTabId === tab.tab_id && 'opacity-55'
                        )}
                        data-active={active}
                        draggable={!editing && !busy}
                        onDragEnd={() => setDraggingTabId(null)}
                        onDragOver={(event) => handleTabDragOver(event, tab.tab_id)}
                        onDragStart={(event) => handleTabDragStart(event, tab)}
                        onDrop={(event) => handleTabDrop(event, tab.tab_id)}
                        style={tabColorStyle}
                      >
                        {editing ? (
                          <div className="inline-flex min-w-0 items-center gap-1.5 px-1.5">
                            <Pencil size={12} className="shrink-0 text-slate-400" />
                            <input
                              ref={renameInputRef}
                              className="h-5 min-w-0 flex-1 rounded border border-white/15 bg-black/35 px-1 font-mono text-[12px] text-slate-100 outline-none ring-0 focus:border-sky-400/60"
                              value={editingTitle}
                              aria-label="Edit terminal tab title"
                              data-testid="agent-team-terminal-tab-title-input"
                              onBlur={() => void commitRenameTab()}
                              onChange={(event) => setEditingTitle(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void commitRenameTab();
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  cancelRenameTab();
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <TerminalButtonTooltip label={tab.title?.trim() || tab.tab_id}>
                            <button
                              type="button"
                              className="inline-flex min-w-0 items-center gap-1.5 px-2 text-left"
                              aria-selected={active}
                              data-testid="agent-team-terminal-mux-tab"
                              disabled={busy && !pendingFocus}
                              role="tab"
                              onClick={() => void focusTab(tab.tab_id)}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                startRenameTab(tab, label);
                              }}
                            >
                              {pendingFocus ? (
                                <Loader2 size={12} className="shrink-0 animate-spin" />
                              ) : null}
                              <span className="min-w-0 truncate">{label}</span>
                            </button>
                          </TerminalButtonTooltip>
                        )}
                        <TerminalButtonTooltip label={closeLabel}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-6 rounded-none border-l border-white/10 p-0 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label={`Close terminal tab ${label}`}
                            data-testid="agent-team-terminal-close-mux-tab"
                            disabled={!canCloseVisibleTabs || editing || (busy && !pendingClose)}
                            onClick={(event) => {
                              event.stopPropagation();
                              void requestCloseTab(tab);
                            }}
                          >
                            {pendingClose ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <X size={12} />
                            )}
                          </Button>
                        </TerminalButtonTooltip>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent alignOffset={-4} className="w-48">
                      <ContextMenuItem
                        disabled={!controls.canRenameTab || busy}
                        onSelect={() => startRenameTab(tab, label)}
                      >
                        <Pencil size={13} />
                        Rename tab
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette size={13} />
                          Tab color
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuLabel>Choose color</ContextMenuLabel>
                          {TERMINAL_TAB_COLOR_OPTIONS.map((option) => (
                            <ContextMenuItem
                              key={option.id}
                              onSelect={() => setTabColor(tab.tab_id, option.id)}
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: option.accent }}
                              />
                              <span className="min-w-0 flex-1">{option.label}</span>
                              {color.id === option.id ? <Check size={13} /> : null}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            )}
            <TerminalButtonTooltip
              label={
                controls.canCreateTab ? 'Create terminal tab' : 'Terminal tabs are unavailable'
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  'size-7 shrink-0 border border-white/10 bg-white/[0.04] p-0 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-45',
                  'rounded-b-none rounded-t-md'
                )}
                aria-label="Create terminal tab"
                data-testid="agent-team-terminal-new-mux-tab"
                disabled={busy || !controls.canCreateTab}
                onClick={() => void createTab()}
              >
                {pendingAction === 'new-tab' || pendingAction === 'activate-prewarmed-tab' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={15} />
                )}
              </Button>
            </TerminalButtonTooltip>
          </div>
        </div>

        {error ? (
          <div className="px-2 py-1 text-xs text-red-300" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={closeCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCloseCandidate(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-md bg-[#10141d]">
          <AlertDialogHeader>
            <AlertDialogTitle>Close terminal tab?</AlertDialogTitle>
            <AlertDialogDescription>
              This tab has terminal output history. Closing it will remove the tab and its visible
              output from this workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const tab = closeCandidate;
                setCloseCandidate(null);
                if (tab) {
                  void closeTab(tab);
                }
              }}
            >
              Close tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const TerminalWorkingDirectoryBar = ({
  projectPath,
  gitBranch,
}: {
  projectPath?: string | null;
  gitBranch?: string | null;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const label = formatWorkingDirectory(projectPath);
  const openTerminalPlatformRepository = useCallback((): void => {
    if (window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(TERMINAL_PLATFORM_GITHUB_URL);
      return;
    }

    window.open(TERMINAL_PLATFORM_GITHUB_URL, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div
      className="flex min-h-6 min-w-0 items-center justify-between gap-3 bg-transparent px-3 text-[11px] text-slate-400"
      data-testid="agent-team-terminal-working-directory"
      title={projectPath || t('terminalWorkspace.shellDefaultDirectory')}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Folder size={12} className="shrink-0 text-slate-500" />
        <span className="sr-only">{t('terminalWorkspace.currentWorkingDirectory')}</span>
        <span className="min-w-0 truncate font-mono text-slate-300">{label}</span>
        {gitBranch ? (
          <span
            className="inline-flex max-w-[14rem] shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.035] px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
            title={t('terminalWorkspace.gitBranchTitle', { branch: gitBranch })}
          >
            <GitBranch size={11} className="shrink-0 text-slate-500" />
            <span className="min-w-0 truncate">{gitBranch}</span>
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.025] px-2 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-sky-300/30 hover:bg-sky-300/10 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/60"
        aria-label={t('terminalWorkspace.openTerminalPlatformRepository')}
        title={t('terminalWorkspace.openTerminalPlatformRepository')}
        onClick={openTerminalPlatformRepository}
      >
        <span>{t('terminalWorkspace.poweredByTerminalPlatform')}</span>
        <Github size={11} className="shrink-0" />
      </button>
    </div>
  );
};

const TerminalWorkspaceSettingsPanel = ({
  kernel,
  onReload,
  onStopRuntime,
  snapshot,
}: {
  kernel: WorkspaceKernel;
  onReload: () => void;
  onStopRuntime: () => Promise<void>;
  snapshot: TerminalWorkspaceSnapshot;
}): React.JSX.Element => {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const display = snapshot.terminalDisplay;

  const runAction = async (actionId: string, action: () => Promise<void> | void): Promise<void> => {
    setPendingAction(actionId);
    try {
      await action();
    } catch {
      // Kernel diagnostics already surface command failures in the terminal workspace.
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div
      className="grid shrink-0 gap-2 border-b border-white/10 bg-[#0b0f16] p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
      data-testid="agent-team-terminal-settings"
    >
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Theme">
        {terminalPlatformThemeManifests.map((theme) => {
          const active = snapshot.theme.themeId === theme.id;

          return (
            <TerminalButtonTooltip key={theme.id} label={`Theme: ${theme.displayName}`}>
              <button
                type="button"
                className={cn(
                  'h-7 shrink-0 rounded-md border px-2 text-xs transition-colors',
                  active
                    ? 'border-sky-400/55 bg-sky-400/15 text-slate-100'
                    : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200'
                )}
                aria-pressed={active}
                onClick={() => kernel.commands.setTheme(theme.id)}
              >
                {formatThemeLabel(theme.displayName, theme.id)}
              </button>
            </TerminalButtonTooltip>
          );
        })}
      </div>

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Display">
        {terminalPlatformTerminalFontScales.map((fontScale) => {
          const active = display.fontScale === fontScale;

          return (
            <TerminalButtonTooltip
              key={fontScale}
              label={`Font: ${formatFontScaleLabel(fontScale)}`}
            >
              <button
                type="button"
                className={cn(
                  'h-7 shrink-0 rounded-md border px-2 text-xs transition-colors',
                  active
                    ? 'border-sky-400/55 bg-sky-400/15 text-slate-100'
                    : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200'
                )}
                aria-pressed={active}
                onClick={() => kernel.commands.setTerminalFontScale(fontScale)}
              >
                {formatFontScaleLabel(fontScale)}
              </button>
            </TerminalButtonTooltip>
          );
        })}
        <TerminalButtonTooltip label={display.lineWrap ? 'Disable wrap' : 'Enable wrap'}>
          <button
            type="button"
            className={cn(
              'h-7 shrink-0 rounded-md border px-2 text-xs transition-colors',
              display.lineWrap
                ? 'border-sky-400/55 bg-sky-400/15 text-slate-100'
                : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200'
            )}
            aria-pressed={display.lineWrap}
            onClick={() => kernel.commands.setTerminalLineWrap(!display.lineWrap)}
          >
            Wrap
          </button>
        </TerminalButtonTooltip>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1">
        <TerminalButtonTooltip label="Reconnect">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-slate-400 transition-colors hover:bg-white/[0.075] hover:text-slate-100 disabled:opacity-50"
            aria-label="Reconnect terminal workspace"
            disabled={pendingAction !== null}
            onClick={() => void runAction('bootstrap', () => kernel.commands.bootstrap())}
          >
            {pendingAction === 'bootstrap' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
        </TerminalButtonTooltip>
        <TerminalButtonTooltip label="Reload sessions">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-slate-400 transition-colors hover:bg-white/[0.075] hover:text-slate-100 disabled:opacity-50"
            aria-label="Reload terminal sessions"
            disabled={pendingAction !== null}
            onClick={() =>
              void runAction('refresh-sessions', () => kernel.commands.refreshSessions())
            }
          >
            {pendingAction === 'refresh-sessions' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Terminal size={13} />
            )}
          </button>
        </TerminalButtonTooltip>
        <TerminalButtonTooltip label="Reload runtime">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-slate-400 transition-colors hover:bg-white/[0.075] hover:text-slate-100 disabled:opacity-50"
            aria-label="Reload terminal runtime"
            disabled={pendingAction !== null}
            onClick={onReload}
          >
            <RefreshCw size={13} />
          </button>
        </TerminalButtonTooltip>
        <TerminalButtonTooltip label="Stop runtime">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-red-500/25 bg-red-500/10 text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-50"
            aria-label="Stop terminal runtime"
            disabled={pendingAction !== null}
            onClick={() => void runAction('stop-runtime', onStopRuntime)}
          >
            {pendingAction === 'stop-runtime' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Square size={12} />
            )}
          </button>
        </TerminalButtonTooltip>
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

function storageKey(teamName: string, key: string): string {
  return `agent-teams:terminal-workspace:${teamName}:${key}`;
}

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readStoredBoolean(key: string): boolean | null {
  const value = readStoredValue(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function readStoredTerminalTabPreferences(teamName: string): TerminalTabPreferences {
  const raw = readStoredValue(storageKey(teamName, 'tab-preferences'));
  if (!raw) return createDefaultTerminalTabPreferences();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultTerminalTabPreferences();
    }

    const source = parsed as {
      order?: unknown;
      colors?: unknown;
    };
    const order = Array.isArray(source.order)
      ? source.order.filter((item): item is string => typeof item === 'string')
      : [];
    const colors: Record<string, TerminalTabColorId> = {};
    if (source.colors && typeof source.colors === 'object') {
      for (const [tabId, colorId] of Object.entries(source.colors)) {
        if (typeof tabId === 'string' && isTerminalTabColorId(colorId)) {
          colors[tabId] = colorId;
        }
      }
    }

    return {
      version: TERMINAL_TAB_PREFERENCES_VERSION,
      order,
      colors,
    };
  } catch {
    return createDefaultTerminalTabPreferences();
  }
}

function readStoredCommandHistory(teamName: string): string[] | null {
  const raw = readStoredValue(storageKey(teamName, 'command-history'));
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => normalizeStoredTerminalCommandHistoryEntry(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(-COMMAND_HISTORY_LIMIT);
  } catch {
    return null;
  }
}

function normalizeStoredTerminalCommandHistoryEntry(value: string): string | null {
  const entry = stripStoredShellPromptPrefix(value.trim()).trim();
  return entry.length > 0 ? entry : null;
}

function stripStoredShellPromptPrefix(value: string): string {
  const command = findStoredShellPromptCommand(value);
  if (command !== null) {
    return command;
  }

  return isStoredShellPromptOnly(value) ? '' : value;
}

function findStoredShellPromptCommand(value: string): string | null {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const marker = value[index] ?? '';
    if (!isShellPromptMarker(marker)) continue;

    const command = value.slice(index + 1);
    if (!command.startsWith(' ') || command.trim().length === 0) continue;

    const prefix = value.slice(0, index).trimEnd();
    if (looksLikeStoredShellPromptPrefix(prefix)) {
      return command.trimStart();
    }
  }

  return null;
}

function isStoredShellPromptOnly(value: string): boolean {
  const trimmed = value.trimEnd();
  const marker = trimmed.at(-1) ?? '';
  if (!isShellPromptMarker(marker)) {
    return false;
  }

  return looksLikeStoredShellPromptPrefix(trimmed.slice(0, -1).trimEnd());
}

function looksLikeStoredShellPromptPrefix(value: string): boolean {
  let remaining = value.trim();
  let hasEnvironmentPrefix = false;

  while (remaining.startsWith('(')) {
    const closeIndex = remaining.indexOf(')');
    if (closeIndex < 2 || closeIndex > 48) {
      return false;
    }

    hasEnvironmentPrefix = true;
    remaining = remaining.slice(closeIndex + 1).trimStart();
  }

  if (!remaining || remaining.length > 260) {
    return false;
  }

  const firstToken = firstWhitespaceSeparatedToken(remaining);
  const locationToken = lastWhitespaceSeparatedToken(remaining);
  const hasUserHostPrefix = firstToken.includes('@') && firstToken !== locationToken;

  return (
    isPathLikePromptToken(locationToken) ||
    ((hasEnvironmentPrefix || hasUserHostPrefix) && isSafePromptToken(locationToken))
  );
}

function firstWhitespaceSeparatedToken(value: string): string {
  const trimmed = value.trim();
  const spaceIndex = trimmed.indexOf(' ');
  const tabIndex = trimmed.indexOf('\t');
  const index =
    spaceIndex === -1 ? tabIndex : tabIndex === -1 ? spaceIndex : Math.min(spaceIndex, tabIndex);
  return index === -1 ? trimmed : trimmed.slice(0, index);
}

function lastWhitespaceSeparatedToken(value: string): string {
  const trimmed = value.trim();
  const spaceIndex = trimmed.lastIndexOf(' ');
  const tabIndex = trimmed.lastIndexOf('\t');
  const index = Math.max(spaceIndex, tabIndex);
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function isPathLikePromptToken(value: string): boolean {
  return (
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    isWindowsDrivePath(value)
  );
}

function isWindowsDrivePath(value: string): boolean {
  const driveLetter = value.charCodeAt(0);
  const isLetter =
    (driveLetter >= 65 && driveLetter <= 90) || (driveLetter >= 97 && driveLetter <= 122);
  return isLetter && value[1] === ':' && value.length > 2;
}

function isSafePromptToken(value: string): boolean {
  if (value.length === 0 || value.length > 181) {
    return false;
  }

  return Array.from(value).every((char) => {
    const code = char.charCodeAt(0);
    return code > 32 && char !== '%' && char !== '$' && char !== '#';
  });
}

function isShellPromptMarker(value: string): boolean {
  return value === '%' || value === '$' || value === '#';
}

function persistValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort UI preference persistence.
  }
}

function persistTerminalTabPreferences(
  teamName: string,
  preferences: TerminalTabPreferences
): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName, 'tab-preferences'),
      JSON.stringify(preferences)
    );
  } catch {
    // Best-effort tab UI preference persistence.
  }
}

function persistCommandHistory(teamName: string, entries: readonly string[]): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName, 'command-history'),
      JSON.stringify(entries.slice(-COMMAND_HISTORY_LIMIT))
    );
  } catch {
    // Best-effort command history persistence.
  }
}

function readStoredTerminalCommandRuns(teamName: string): TerminalCommandRunPresentation[] {
  const raw = readStoredValue(storageKey(teamName, 'command-runs'));
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return capTerminalCommandRuns(
      parsed
        .map((entry) => normalizeStoredTerminalCommandRun(entry))
        .filter((entry): entry is TerminalCommandRunPresentation => entry !== null)
    );
  } catch {
    return [];
  }
}

function normalizeStoredTerminalCommandRun(value: unknown): TerminalCommandRunPresentation | null {
  if (!isRecord(value)) {
    return null;
  }

  const clientEventId =
    typeof value.clientEventId === 'string' && value.clientEventId.trim()
      ? value.clientEventId.trim()
      : null;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const paneId = typeof value.paneId === 'string' && value.paneId.trim() ? value.paneId : null;
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId : null;
  const startedAtMs =
    typeof value.startedAtMs === 'number' && Number.isFinite(value.startedAtMs)
      ? value.startedAtMs
      : 0;
  const status = isTerminalCommandRunPresentationStatus(value.status) ? value.status : 'unknown';

  if (!clientEventId || !command || !paneId || !sessionId) {
    return null;
  }

  const run: TerminalCommandRunPresentation = {
    clientEventId,
    command,
    paneId,
    sessionId,
    startedAtMs,
    status,
  };

  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)) {
    run.durationMs = Math.max(0, value.durationMs);
  }
  if (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)) {
    run.exitCode = Math.trunc(value.exitCode);
  }

  return run;
}

function isTerminalCommandRunPresentationStatus(
  value: unknown
): value is TerminalCommandRunPresentation['status'] {
  return value === 'failed' || value === 'running' || value === 'succeeded' || value === 'unknown';
}

function persistTerminalCommandRuns(
  teamName: string,
  runs: readonly TerminalCommandRunPresentation[]
): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName, 'command-runs'),
      JSON.stringify(capTerminalCommandRuns(runs))
    );
  } catch {
    // Best-effort command presentation persistence.
  }
}

function formatMuxTabTitle(tab: TerminalMuxTab, index: number): string {
  return tab.title?.trim() || `Tab ${index + 1}`;
}

function formatNewMuxTabTitle(tabNumber: number): string {
  return `Tab ${tabNumber}`;
}

function formatNextMuxTabTitle(tabs: readonly TerminalMuxTab[]): string {
  const usedTitles = new Set(
    tabs.map((tab) => tab.title?.trim()).filter((title): title is string => Boolean(title))
  );
  let nextNumber = Math.max(tabs.length + 1, 1);

  for (const title of usedTitles) {
    const match = /^Tab\s+(\d+)$/i.exec(title);
    if (!match) continue;
    nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
  }

  let nextTitle = formatNewMuxTabTitle(nextNumber);
  while (usedTitles.has(nextTitle)) {
    nextNumber += 1;
    nextTitle = formatNewMuxTabTitle(nextNumber);
  }

  return nextTitle;
}

function createDefaultTerminalTabPreferences(): TerminalTabPreferences {
  return {
    version: TERMINAL_TAB_PREFERENCES_VERSION,
    order: [],
    colors: {},
  };
}

function normalizeTerminalTabPreferences(
  preferences: TerminalTabPreferences,
  tabs: readonly TerminalMuxTab[]
): TerminalTabPreferences {
  const normalizedOrder = orderTerminalTabsByPreference(tabs, preferences.order).map(
    (tab) => tab.tab_id
  );
  const visibleTabIds = new Set(normalizedOrder);
  const colors: Record<string, TerminalTabColorId> = {};

  for (const [tabId, colorId] of Object.entries(preferences.colors)) {
    if (visibleTabIds.has(tabId) && isTerminalTabColorId(colorId)) {
      colors[tabId] = colorId;
    }
  }

  return {
    version: TERMINAL_TAB_PREFERENCES_VERSION,
    order: normalizedOrder,
    colors,
  };
}

function orderTerminalTabsByPreference(
  tabs: readonly TerminalMuxTab[],
  order: readonly string[]
): TerminalMuxTab[] {
  const remainingTabsById = new Map(tabs.map((tab) => [tab.tab_id, tab]));
  const orderedTabs: TerminalMuxTab[] = [];

  for (const tabId of order) {
    const tab = remainingTabsById.get(tabId);
    if (!tab) continue;
    orderedTabs.push(tab);
    remainingTabsById.delete(tabId);
  }

  return [...orderedTabs, ...tabs.filter((tab) => remainingTabsById.has(tab.tab_id))];
}

function reorderTerminalTabsById(
  currentOrder: readonly string[],
  tabs: readonly TerminalMuxTab[],
  sourceTabId: string,
  targetTabId: string,
  placementMode: 'before' | 'after'
): string[] {
  const order = orderTerminalTabsByPreference(tabs, currentOrder).map((tab) => tab.tab_id);
  if (!order.includes(sourceTabId) || !order.includes(targetTabId)) {
    return order;
  }

  const withoutSource = order.filter((tabId) => tabId !== sourceTabId);
  const targetIndex = withoutSource.indexOf(targetTabId);
  if (targetIndex === -1) {
    return order;
  }

  withoutSource.splice(placementMode === 'after' ? targetIndex + 1 : targetIndex, 0, sourceTabId);
  return withoutSource;
}

function resolveTerminalTabColor(colorId: TerminalTabColorId | undefined): TerminalTabColorOption {
  return (
    TERMINAL_TAB_COLOR_OPTIONS.find((option) => option.id === colorId) ??
    TERMINAL_TAB_COLOR_OPTIONS.find((option) => option.id === 'sky') ??
    TERMINAL_TAB_COLOR_OPTIONS[0]
  );
}

function isTerminalTabColorId(value: unknown): value is TerminalTabColorId {
  return (
    typeof value === 'string' && TERMINAL_TAB_COLOR_OPTIONS.some((option) => option.id === value)
  );
}

function areTerminalTabPreferencesEqual(
  left: TerminalTabPreferences,
  right: TerminalTabPreferences
): boolean {
  if (left.version !== right.version || !areStringArraysEqual(left.order, right.order)) {
    return false;
  }

  const leftColors = Object.entries(left.colors);
  const rightColors = Object.entries(right.colors);
  if (leftColors.length !== rightColors.length) {
    return false;
  }

  return leftColors.every(([tabId, colorId]) => right.colors[tabId] === colorId);
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPrewarmedTerminalTab(tab: TerminalMuxTab): boolean {
  return tab.title?.trim() === PREWARMED_TERMINAL_TAB_TITLE;
}

function hasTerminalTabHistory(snapshot: TerminalWorkspaceSnapshot, tab: TerminalMuxTab): boolean {
  const paneIds = collectPaneIds(tab.root);
  const focusedScreen = snapshot.attachedSession?.focused_screen ?? null;

  for (const paneId of paneIds) {
    const historicalLines = snapshot.historicalPanes?.[paneId]?.lines ?? [];
    if (historicalLines.some((line) => line.trim().length > 0)) {
      return true;
    }

    if (
      focusedScreen?.pane_id === paneId &&
      focusedScreen.surface.lines.some((line) => line.text.trim().length > 0)
    ) {
      return true;
    }
  }

  return false;
}

function collectPaneIds(node: TerminalMuxPaneTreeNode): string[] {
  if (node.kind === 'leaf') {
    return [node.pane_id];
  }

  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function formatWorkingDirectory(path?: string | null): string {
  const normalizedPath = trimTrailingSlashes(path?.trim() || '');
  if (!normalizedPath) {
    return 'Shell default directory';
  }

  return compactUserHome(normalizedPath);
}

export function formatTerminalPromptLabel(path?: string | null): string {
  const workingDirectory = formatWorkingDirectory(path);
  return workingDirectory === 'Shell default directory' ? 'local shell' : workingDirectory;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function compactUserHome(path: string): string {
  const usersPrefix = '/Users/';
  if (!path.startsWith(usersPrefix)) {
    return path;
  }

  const rest = path.slice(usersPrefix.length);
  const nextSlashIndex = rest.indexOf('/');
  if (nextSlashIndex === -1) {
    return '~';
  }

  return `~${rest.slice(nextSlashIndex)}`;
}

function formatThemeLabel(displayName: string, themeId: string): string {
  if (themeId === 'terminal-platform-default') return 'Dark';
  if (themeId === 'terminal-platform-light') return 'Light';
  return displayName.replace(/^Terminal Platform\s*/i, '').trim() || displayName;
}

function formatFontScaleLabel(fontScale: string): string {
  if (fontScale === 'compact') return 'Compact';
  if (fontScale === 'large') return 'Large';
  return 'Default';
}

export function normalizeTerminalCommandRunEventDetail(
  event: Event
): (TerminalCommandRunPresentation & { durationMs?: number }) | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isRecord(detail)) {
    return null;
  }

  const command = typeof detail.command === 'string' ? detail.command.trim() : '';
  const clientEventId =
    typeof detail.clientEventId === 'string' && detail.clientEventId.trim()
      ? detail.clientEventId.trim()
      : null;
  const paneId = typeof detail.paneId === 'string' ? detail.paneId : null;
  const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId : null;
  const startedAtMs =
    typeof detail.startedAtMs === 'number' && Number.isFinite(detail.startedAtMs)
      ? detail.startedAtMs
      : Date.now();

  if (!command || !clientEventId || !paneId || !sessionId) {
    return null;
  }

  const durationMs =
    typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)
      ? detail.durationMs
      : undefined;

  return {
    clientEventId,
    command,
    durationMs,
    paneId,
    sessionId,
    startedAtMs,
    status: 'running',
  };
}

export function upsertTerminalCommandRun(
  runs: readonly TerminalCommandRunPresentation[],
  nextRun: TerminalCommandRunPresentation,
  status: TerminalCommandRunPresentation['status']
): TerminalCommandRunPresentation[] {
  const next = {
    ...nextRun,
    status,
  };
  const existingIndex = runs.findIndex((run) => run.clientEventId === nextRun.clientEventId);
  const merged =
    existingIndex >= 0
      ? runs.map((run, index) => (index === existingIndex ? { ...run, ...next } : run))
      : [...runs, next];

  return capTerminalCommandRuns(merged);
}

function capTerminalCommandRuns(
  runs: readonly TerminalCommandRunPresentation[]
): TerminalCommandRunPresentation[] {
  const countsByPane = new Map<string, number>();
  const keptReversed: TerminalCommandRunPresentation[] = [];

  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;

    const scopeKey = `${run.sessionId}\u001f${run.paneId}`;
    const count = countsByPane.get(scopeKey) ?? 0;
    if (count >= COMMAND_HISTORY_LIMIT) {
      continue;
    }

    countsByPane.set(scopeKey, count + 1);
    keptReversed.push(run);
  }

  return keptReversed.reverse().slice(-COMMAND_RUNS_STORAGE_LIMIT);
}

export function settleTerminalCommandRuns(
  runs: TerminalCommandRunPresentation[],
  screenLines: readonly string[],
  nowMs: number,
  allowEmptyCompletion: boolean
): TerminalCommandRunPresentation[] {
  let changed = false;
  const next = runs.map((run) => {
    const completion = inferTerminalCommandCompletion(screenLines, run.command);
    if (!completion.completed) {
      return run;
    }

    const inferredStatus = inferTerminalCommandOutputStatus(completion.outputLines);
    if (run.status !== 'running') {
      if (run.status !== 'failed' && inferredStatus === 'failed') {
        changed = true;
        return {
          ...run,
          status: 'failed' as const,
        };
      }

      return run;
    }

    if (completion.outputLines.length === 0 && !allowEmptyCompletion) {
      return run;
    }

    changed = true;
    return {
      ...run,
      durationMs: Math.max(0, nowMs - run.startedAtMs),
      status: completion.outputLines.length > 0 ? inferredStatus : 'unknown',
    };
  });

  return changed ? next : runs;
}

function settleScopedTerminalCommandRuns(
  runs: TerminalCommandRunPresentation[],
  sessionId: string | null,
  paneId: string | null,
  screenLines: readonly string[],
  nowMs: number,
  allowEmptyCompletion: boolean
): TerminalCommandRunPresentation[] {
  if (!sessionId || !paneId) {
    return runs;
  }

  const scopedRuns = runs.filter((run) => run.sessionId === sessionId && run.paneId === paneId);
  if (scopedRuns.length === 0) {
    return runs;
  }

  const settledScopedRuns = settleTerminalCommandRuns(
    scopedRuns,
    screenLines,
    nowMs,
    allowEmptyCompletion
  );
  if (settledScopedRuns === scopedRuns) {
    return runs;
  }

  let scopedIndex = 0;
  return runs.map((run) => {
    if (run.sessionId !== sessionId || run.paneId !== paneId) {
      return run;
    }

    const settledRun = settledScopedRuns[scopedIndex];
    scopedIndex += 1;
    return settledRun ?? run;
  });
}

export function inferTerminalCommandCompletion(
  lines: readonly string[],
  command: string
): { completed: boolean; outputLines: string[] } {
  const commandLineIndex = findLatestTerminalCommandLineIndex(lines, command);
  if (commandLineIndex === -1) {
    return { completed: false, outputLines: [] };
  }

  for (let index = commandLineIndex + 1; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (isTerminalPromptOnlyLine(text) || isTerminalPromptCommandLine(text)) {
      return {
        completed: true,
        outputLines: lines
          .slice(commandLineIndex + 1, index)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0),
      };
    }
  }

  return { completed: false, outputLines: [] };
}

function findLatestTerminalCommandLineIndex(lines: readonly string[], command: string): number {
  const normalizedCommand = normalizeCommandForPromptMatch(command);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!isTerminalPromptCommandLine(line)) {
      continue;
    }

    if (normalizeCommandForPromptMatch(extractCommandFromPromptLine(line)) === normalizedCommand) {
      return index;
    }
  }

  return -1;
}

function isTerminalPromptOnlyLine(line: string): boolean {
  const text = line.trim();
  if (!text) {
    return false;
  }

  if (text === '%' || text === '$' || text === '#') {
    return true;
  }

  return /(?:^|\s)[%$#]\s*$/u.test(text) && !/(?:^|\s)[%$#]\s+\S/u.test(text);
}

function isTerminalPromptCommandLine(line: string): boolean {
  return extractCommandFromPromptLine(line).length > 0;
}

function extractCommandFromPromptLine(line: string): string {
  const trimmed = line.trimEnd();
  const wrappedPromptCommand = /^<\s{2,}(.+)$/u.exec(trimmed);
  if (wrappedPromptCommand?.[1]) {
    return wrappedPromptCommand[1].trim();
  }

  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const marker = trimmed[index] ?? '';
    if (marker !== '%' && marker !== '$' && marker !== '#') {
      continue;
    }

    const command = trimmed.slice(index + 1);
    return command.startsWith(' ') ? command.trim() : '';
  }

  return '';
}

function normalizeCommandForPromptMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function inferTerminalCommandOutputStatus(
  outputLines: readonly string[]
): TerminalCommandRunPresentation['status'] {
  const output = stripAnsiEscapeSequences(outputLines.join('\n')).toLowerCase();
  if (
    /(?:^|\n)\s*(?:fatal|error):/u.test(output) ||
    /(?:^|\n)\s*(?:npm|pnpm|yarn)\s+err!?/u.test(output) ||
    /(?:^|\n)\s*traceback\s+\(most recent call last\):/u.test(output) ||
    /(?:^|\n)\s*exception:/u.test(output) ||
    /(?:command not found|no such file or directory|permission denied|not a git repository)/u.test(
      output
    ) ||
    /(?:exit(?:ed)?\s+(?:with\s+)?(?:status|code)|exit\s+code)\s+[1-9]\d*/u.test(output)
  ) {
    return 'failed';
  }

  return 'succeeded';
}

function stripAnsiEscapeSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
