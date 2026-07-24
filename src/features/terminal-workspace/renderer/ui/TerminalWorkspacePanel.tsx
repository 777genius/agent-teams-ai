import {
  type ComponentRef,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

import { normalizeTerminalCommandRunEventDetail } from '../adapters/terminalCommandRunEvents';
import {
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  isTerminalBackgroundImageFit,
  isTerminalBackgroundMode,
  normalizeTerminalAppearanceColor,
  type TerminalAppearanceSettings,
  type TerminalBackgroundImageFit,
} from '../model/terminalAppearanceSettings';
import {
  createTerminalLocalAutocompleteCandidates,
  isTerminalLocalAutocompleteDraftEligible,
  resolveTerminalLocalAutocompleteSuggestion,
} from '../model/terminalCommandAutocomplete';
import { normalizeStoredTerminalCommandHistoryEntry } from '../model/terminalCommandHistory';
import {
  capTerminalCommandRuns,
  closeSupersededTerminalCommandRuns,
  createTerminalCommandScreenLines,
  settleScopedTerminalCommandRuns,
  TERMINAL_COMMAND_HISTORY_LIMIT,
  type TerminalCommandRunPresentation,
  type TerminalCommandScreenLine,
  upsertTerminalCommandRun,
} from '../model/terminalCommandRuns';
import {
  formatTerminalPromptLabel,
  formatWorkingDirectory,
} from '../model/terminalPathPresentation';
import { isRecord } from '../utils/valueGuards';

import {
  type TerminalWorkspaceSettingsActionId,
  TerminalWorkspaceSettingsView,
} from './TerminalWorkspaceSettingsView';

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
  onSettingsOpenChange?: (open: boolean) => void;
  terminalHeightClassName?: string;
  terminalHeightStyle?: CSSProperties;
  tabsPortalElement?: HTMLElement | null;
  getBootstrap: (request: TerminalWorkspaceBootstrapRequest) => Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime: (teamName: string) => Promise<void>;
}

const TERMINAL_LOCAL_AUTOCOMPLETE_THROTTLE_MS = 75;
const PREWARMED_TERMINAL_TAB_TITLE = '__tp_prewarmed_shell__';
const TERMINAL_TAB_PREFERENCES_VERSION = 1;
const TERMINAL_PLATFORM_GITHUB_URL = 'https://github.com/777genius/terminal-platform';
type TerminalWorkspaceSnapshot = ReturnType<WorkspaceKernel['getSnapshot']>;
type TerminalMuxCommand = Parameters<WorkspaceKernel['commands']['dispatchMuxCommand']>[1];
type TerminalScreenElementHandle = ComponentRef<typeof TerminalScreen> & {
  followOutput?: boolean;
  requestUpdate?: () => void;
  scrollToLatestOutput?: () => void;
};
type TerminalCommandDockElementHandle = ComponentRef<typeof TerminalCommandDock>;
type TeamTFunction = ReturnType<typeof useAppTranslation>['t'];
type TerminalMuxTab = NonNullable<
  TerminalWorkspaceSnapshot['attachedSession']
>['topology']['tabs'][number];
type TerminalMuxPaneTreeNode = TerminalMuxTab['root'];
type TerminalTabColorId = (typeof TERMINAL_TAB_COLOR_OPTIONS)[number]['id'];

interface TerminalTabColorOption {
  id: string;
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

interface TerminalTabDropIndicator {
  placementMode: 'before' | 'after';
  tabId: string;
}

interface TerminalTabPointerDrag {
  active: boolean;
  grabOffsetX: number;
  offsetX: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  tabId: string;
}

interface TerminalCommandContextMenuState {
  blockText: string;
  commandText: string;
  outputText: string;
  x: number;
  y: number;
}

const TERMINAL_TAB_COLOR_OPTIONS = [
  {
    id: 'slate',
    accent: '#94a3b8',
    border: 'rgba(148, 163, 184, 0.56)',
    background: 'rgba(148, 163, 184, 0.14)',
    hoverBackground: 'rgba(148, 163, 184, 0.18)',
  },
  {
    id: 'sky',
    accent: '#38bdf8',
    border: 'rgba(56, 189, 248, 0.58)',
    background: 'rgba(56, 189, 248, 0.15)',
    hoverBackground: 'rgba(56, 189, 248, 0.2)',
  },
  {
    id: 'blue',
    accent: '#60a5fa',
    border: 'rgba(96, 165, 250, 0.58)',
    background: 'rgba(96, 165, 250, 0.15)',
    hoverBackground: 'rgba(96, 165, 250, 0.2)',
  },
  {
    id: 'cyan',
    accent: '#22d3ee',
    border: 'rgba(34, 211, 238, 0.58)',
    background: 'rgba(34, 211, 238, 0.14)',
    hoverBackground: 'rgba(34, 211, 238, 0.19)',
  },
  {
    id: 'teal',
    accent: '#2dd4bf',
    border: 'rgba(45, 212, 191, 0.56)',
    background: 'rgba(45, 212, 191, 0.14)',
    hoverBackground: 'rgba(45, 212, 191, 0.19)',
  },
  {
    id: 'emerald',
    accent: '#34d399',
    border: 'rgba(52, 211, 153, 0.56)',
    background: 'rgba(52, 211, 153, 0.14)',
    hoverBackground: 'rgba(52, 211, 153, 0.19)',
  },
  {
    id: 'lime',
    accent: '#a3e635',
    border: 'rgba(163, 230, 53, 0.52)',
    background: 'rgba(163, 230, 53, 0.12)',
    hoverBackground: 'rgba(163, 230, 53, 0.17)',
  },
  {
    id: 'amber',
    accent: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.54)',
    background: 'rgba(251, 191, 36, 0.13)',
    hoverBackground: 'rgba(251, 191, 36, 0.18)',
  },
  {
    id: 'orange',
    accent: '#fb923c',
    border: 'rgba(251, 146, 60, 0.54)',
    background: 'rgba(251, 146, 60, 0.13)',
    hoverBackground: 'rgba(251, 146, 60, 0.18)',
  },
  {
    id: 'rose',
    accent: '#fb7185',
    border: 'rgba(251, 113, 133, 0.56)',
    background: 'rgba(251, 113, 133, 0.14)',
    hoverBackground: 'rgba(251, 113, 133, 0.19)',
  },
  {
    id: 'violet',
    accent: '#a78bfa',
    border: 'rgba(167, 139, 250, 0.56)',
    background: 'rgba(167, 139, 250, 0.14)',
    hoverBackground: 'rgba(167, 139, 250, 0.19)',
  },
] as const satisfies readonly TerminalTabColorOption[];

const TerminalButtonTooltip = ({
  children,
  label,
  side = 'top',
}: Readonly<{
  children: React.ReactElement;
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>): React.JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
};

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
      initialThemeId: readStoredValue(storageKey(teamName, 'theme')),
      initialTerminalFontScale: readStoredValue(storageKey(teamName, 'font-scale')),
      initialTerminalLineWrap: readStoredBoolean(storageKey(teamName, 'line-wrap')),
      initialCommandHistoryEntries: readStoredCommandHistory(teamName),
      commandHistoryLimit: TERMINAL_COMMAND_HISTORY_LIMIT,
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
  onSettingsOpenChange,
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
  terminalHeightStyle?: CSSProperties;
  tabsPortalElement?: HTMLElement | null;
  onSettingsOpenChange?: (open: boolean) => void;
  onReload: () => void;
  onStopRuntime: () => Promise<void>;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const snapshot = useWorkspaceSnapshot(kernel);
  const isSheetSurface = surface === 'sheet';
  const autoAttachAttemptRef = useRef<string | null>(null);
  const terminalDisplay = snapshot.terminalDisplay;
  const quickCommands = useMemo(() => [], []);
  const terminalScreenElementRef = useRef<TerminalScreenElementHandle | null>(null);
  const [commandDockElement, setCommandDockElement] =
    useState<TerminalCommandDockElementHandle | null>(null);
  const [terminalContentPending, setTerminalContentPending] = useState(false);
  const [commandContextMenu, setCommandContextMenu] =
    useState<TerminalCommandContextMenuState | null>(null);
  const [commandRuns, setCommandRuns] = useState<TerminalCommandRunPresentation[]>(() =>
    readStoredTerminalCommandRuns(teamName)
  );
  const commandRunSettlementContextRef = useRef<{
    paneId: string | null;
    screenLines: readonly TerminalCommandScreenLine[];
    sessionId: string | null;
  }>({ paneId: null, screenLines: [], sessionId: null });
  const [commandDraft, setCommandDraft] = useState('');
  const [autocompleteSuggestion, setAutocompleteSuggestion] = useState<string | null>(null);
  const [dismissedAutocompleteDraft, setDismissedAutocompleteDraft] = useState<string | null>(null);
  const commandHistoryPersistenceRef = useRef<{
    hasPersistedSnapshot: boolean;
    hasRestoredHistory: boolean | null;
    teamName: string;
  }>({
    hasPersistedSnapshot: false,
    hasRestoredHistory: null,
    teamName,
  });
  const [appearanceSettings, setAppearanceSettings] = useState<TerminalAppearanceSettings>(() =>
    readStoredTerminalAppearanceSettings(teamName)
  );
  const activeScreen = snapshot.attachedSession?.focused_screen ?? null;
  const terminalConnectionBootstrapping =
    snapshot.connection.state === 'idle' || snapshot.connection.state === 'bootstrapping';
  const terminalScreenPending = snapshot.connection.state === 'ready' && activeScreen === null;
  const showTerminalContentSkeleton =
    terminalContentPending || terminalConnectionBootstrapping || terminalScreenPending;
  const activeScreenLines = activeScreen?.surface.lines;
  const activeScreenHistory = activeScreen
    ? snapshot.historicalPanes?.[activeScreen.pane_id]
    : undefined;
  const activeScreenCommandLines = useMemo(() => {
    const historyLines = activeScreenHistory?.lines ?? [];
    let historyTailIndex = historyLines.length - 1;
    while (historyTailIndex >= 0 && !historyLines[historyTailIndex]?.trim()) {
      historyTailIndex -= 1;
    }

    return [
      ...createTerminalCommandScreenLines(
        activeScreenLines ?? [],
        activeScreen?.surface.cursor?.row ?? null
      ),
      ...historyLines.map((text, index) => ({
        historyCapturedAtMs: activeScreenHistory?.capturedAtMs,
        ...(index === historyTailIndex ? { isHistoryTailLine: true } : {}),
        source: 'history' as const,
        text,
      })),
    ];
  }, [activeScreen?.surface.cursor?.row, activeScreenHistory, activeScreenLines]);
  const activeCommandSessionId =
    snapshot.selection.activeSessionId ?? snapshot.catalog.sessions[0]?.session_id ?? null;
  const activeCommandPaneId = activeScreen?.pane_id ?? null;
  commandRunSettlementContextRef.current = {
    paneId: activeCommandPaneId,
    screenLines: activeScreenCommandLines,
    sessionId: activeCommandSessionId,
  };
  const activeCommandRuns = useMemo(
    () =>
      commandRuns.filter(
        (run) => run.sessionId === activeCommandSessionId && run.paneId === activeCommandPaneId
      ),
    [activeCommandPaneId, activeCommandSessionId, commandRuns]
  );
  const autocompleteCandidates = useMemo(
    () =>
      createTerminalLocalAutocompleteCandidates({
        commandHistory: snapshot.commandHistory.entries,
        commandRuns,
        cwd: projectPath,
      }),
    [commandRuns, projectPath, snapshot.commandHistory.entries]
  );
  const terminalAppearanceStyle = useMemo(
    () =>
      ({
        ...terminalHeightStyle,
        ...createTerminalAppearanceStyle(appearanceSettings),
      }) as CSSProperties,
    [appearanceSettings, terminalHeightStyle]
  );
  const updateAppearanceSettings = useCallback(
    (updates: Partial<TerminalAppearanceSettings>): void => {
      setAppearanceSettings((current) =>
        normalizeTerminalAppearanceSettings({ ...current, ...updates })
      );
    },
    []
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

  const closeCommandContextMenu = useCallback((): void => {
    setCommandContextMenu(null);
  }, []);

  const copyCommandContextMenuText = useCallback(async (text: string): Promise<void> => {
    setCommandContextMenu(null);
    if (!text.trim()) {
      return;
    }

    await copyTextToClipboard(text);
  }, []);

  const handleTerminalScreenContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const menu = resolveTerminalCommandContextMenuState(event.nativeEvent);
      if (!menu) {
        setCommandContextMenu(null);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setCommandContextMenu(menu);
    },
    []
  );

  useEffect(() => {
    if (!commandContextMenu) {
      return undefined;
    }

    const close = (): void => setCommandContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      close();
    };

    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [commandContextMenu]);

  useEffect(() => {
    if (!commandDockElement) {
      return undefined;
    }

    const handleCommandSubmitted = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (detail) {
        setCommandRuns((current) =>
          upsertTerminalCommandRun(
            closeSupersededTerminalCommandRuns(
              current,
              detail,
              activeScreenCommandLines,
              Date.now()
            ),
            detail,
            'running'
          )
        );
      }
      scrollTerminalToLatest();
    };
    const handleCommandStarted = (event: Event): void => {
      const detail = normalizeTerminalCommandRunEventDetail(event);
      if (!detail) {
        return;
      }

      setCommandDraft('');
      setAutocompleteSuggestion(null);
      setDismissedAutocompleteDraft(null);
      setCommandRuns((current) =>
        upsertTerminalCommandRun(
          closeSupersededTerminalCommandRuns(current, detail, activeScreenCommandLines, Date.now()),
          detail,
          'running'
        )
      );
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
  }, [activeScreenCommandLines, commandDockElement, scrollTerminalToLatest]);

  useEffect(() => {
    if (!commandDockElement) {
      return undefined;
    }

    const handleDraftChange = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = isRecord(detail) && typeof detail.value === 'string' ? detail.value : '';
      setCommandDraft(value);
      setDismissedAutocompleteDraft((current) => (current === value ? current : null));
    };
    const handleAutocompleteAccept = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = isRecord(detail) && typeof detail.value === 'string' ? detail.value : '';
      setCommandDraft(value);
      setDismissedAutocompleteDraft(null);
      setAutocompleteSuggestion(null);
    };
    const handleAutocompleteDismiss = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const draft = isRecord(detail) && typeof detail.draft === 'string' ? detail.draft : '';
      setDismissedAutocompleteDraft(draft);
      setAutocompleteSuggestion(null);
    };

    commandDockElement.addEventListener('tp-terminal-command-draft-change', handleDraftChange);
    commandDockElement.addEventListener(
      'tp-terminal-command-autocomplete-accept',
      handleAutocompleteAccept
    );
    commandDockElement.addEventListener(
      'tp-terminal-command-autocomplete-dismiss',
      handleAutocompleteDismiss
    );

    return () => {
      commandDockElement.removeEventListener('tp-terminal-command-draft-change', handleDraftChange);
      commandDockElement.removeEventListener(
        'tp-terminal-command-autocomplete-accept',
        handleAutocompleteAccept
      );
      commandDockElement.removeEventListener(
        'tp-terminal-command-autocomplete-dismiss',
        handleAutocompleteDismiss
      );
    };
  }, [commandDockElement]);

  useEffect(() => {
    if (
      !isTerminalLocalAutocompleteDraftEligible(commandDraft) ||
      dismissedAutocompleteDraft === commandDraft
    ) {
      setAutocompleteSuggestion(null);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setAutocompleteSuggestion(
        resolveTerminalLocalAutocompleteSuggestion({
          candidates: autocompleteCandidates,
          cwd: projectPath,
          dismissedDraft: dismissedAutocompleteDraft,
          draft: commandDraft,
          paneId: activeCommandPaneId,
          sessionId: activeCommandSessionId,
        })
      );
    }, TERMINAL_LOCAL_AUTOCOMPLETE_THROTTLE_MS);

    return () => window.clearTimeout(timer);
  }, [
    activeCommandPaneId,
    activeCommandSessionId,
    autocompleteCandidates,
    commandDraft,
    dismissedAutocompleteDraft,
    projectPath,
  ]);

  useEffect(() => {
    const screenLines = activeScreenCommandLines;
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
  }, [
    activeCommandPaneId,
    activeCommandSessionId,
    activeScreen?.sequence,
    activeScreenCommandLines,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const context = commandRunSettlementContextRef.current;
      if (!context.sessionId || !context.paneId || context.screenLines.length === 0) {
        return;
      }

      setCommandRuns((current) => {
        const hasPendingScopedRun = current.some(
          (run) =>
            run.sessionId === context.sessionId &&
            run.paneId === context.paneId &&
            (run.status === 'running' || run.status === 'unknown')
        );
        return hasPendingScopedRun
          ? settleScopedTerminalCommandRuns(
              current,
              context.sessionId,
              context.paneId,
              context.screenLines,
              Date.now(),
              true
            )
          : current;
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCommandRuns(readStoredTerminalCommandRuns(teamName));
  }, [teamName]);

  useEffect(() => {
    persistTerminalCommandRuns(teamName, commandRuns);
  }, [commandRuns, teamName]);

  useEffect(() => {
    setAppearanceSettings(readStoredTerminalAppearanceSettings(teamName));
  }, [teamName]);

  useEffect(() => {
    persistTerminalAppearanceSettings(teamName, appearanceSettings);
  }, [appearanceSettings, teamName]);

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
      settingsOpen={settingsOpen}
      snapshot={snapshot}
      teamName={teamName}
      onSettingsOpenChange={onSettingsOpenChange}
      onTabContentPendingChange={setTerminalContentPending}
      placement={tabsPortalElement ? 'sheet-header' : 'console'}
    />
  );

  return (
    <div
      className={cn(
        'agent-team-terminal-console relative isolate flex min-w-0 flex-col overflow-hidden',
        isSheetSurface
          ? 'rounded-none border-0 bg-transparent'
          : 'rounded-md border border-white/10 bg-[#07090d]',
        terminalHeightClassName ?? 'h-[min(72vh,48rem)] min-h-[32rem]'
      )}
      data-background-mode={appearanceSettings.backgroundMode}
      data-surface={surface}
      style={terminalAppearanceStyle}
    >
      <style>
        {`
          .agent-team-terminal-console::before {
            content: '';
            position: absolute;
            inset: calc(var(--agent-terminal-background-image-blur) * -1);
            z-index: 0;
            pointer-events: none;
            background-color: var(--agent-terminal-background-color);
            background-image:
              linear-gradient(
                rgba(3, 7, 12, var(--agent-terminal-image-dim-opacity)),
                rgba(3, 7, 12, var(--agent-terminal-image-dim-opacity))
              ),
              var(--agent-terminal-background-image);
            background-position: var(--agent-terminal-background-position);
            background-repeat: var(--agent-terminal-background-repeat);
            background-size: var(--agent-terminal-background-size);
            opacity: var(--agent-terminal-panel-opacity);
            backdrop-filter: blur(var(--agent-terminal-backdrop-blur));
            filter: blur(var(--agent-terminal-background-image-blur));
          }

          .agent-team-terminal-console > * {
            position: relative;
            z-index: 1;
          }

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
            --tp-terminal-history-font-size: var(--agent-terminal-font-size);
          }

          .agent-team-terminal-console tp-terminal-screen {
            --tp-terminal-history-font-size: var(--agent-terminal-font-size);
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
            --tp-terminal-command-font-size: var(--agent-terminal-font-size);
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
      {tabsPortalElement ? createPortal(tabs, tabsPortalElement) : tabs}
      {settingsOpen ? (
        <TerminalWorkspaceSettingsPage
          appearanceSettings={appearanceSettings}
          kernel={kernel}
          onAppearanceSettingsChange={updateAppearanceSettings}
          onClose={() => onSettingsOpenChange?.(false)}
          onReload={onReload}
          onStopRuntime={onStopRuntime}
          snapshot={snapshot}
        />
      ) : (
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
          <div
            slot="screen"
            className="relative h-full min-h-0 overflow-hidden"
            onContextMenuCapture={handleTerminalScreenContextMenuCapture}
          >
            <TerminalScreen
              ref={terminalScreenRef}
              hideShellPromptNoise
              kernel={kernel}
              placement="terminal"
              terminalPromptLabel={formatTerminalPromptLabel(
                projectPath,
                t('terminalWorkspace.localShellBadge')
              )}
              commandPresentationMetadata={activeCommandRuns}
            />
            {showTerminalContentSkeleton ? <TerminalTabContentSkeleton /> : null}
          </div>
          <div slot="command-dock" className="grid min-w-0 shrink-0 grid-rows-[auto_auto]">
            <TerminalWorkingDirectoryBar projectPath={projectPath} gitBranch={gitBranch} />
            <TerminalCommandDock
              ref={setCommandDockElement}
              autoFocusInput
              autocompleteSuggestion={autocompleteSuggestion ?? undefined}
              commandActionsLabel={t('terminalWorkspace.terminalCommandActions')}
              commandPlaceholder={t('terminalWorkspace.commandPlaceholder')}
              interruptLabel={t('terminalWorkspace.commandInterrupt')}
              interruptTitle={t('terminalWorkspace.commandInterruptTitle')}
              kernel={kernel}
              placement="terminal"
              quickCommands={quickCommands}
              submitLabel={t('terminalWorkspace.commandRun')}
              submitTitle={t('terminalWorkspace.commandRunTitle')}
            />
          </div>
        </TerminalWorkspace>
      )}
      {commandContextMenu
        ? createPortal(
            <TerminalCommandContextMenu
              menu={commandContextMenu}
              onClose={closeCommandContextMenu}
              onCopy={copyCommandContextMenuText}
            />,
            document.body
          )
        : null}
    </div>
  );
};

const TerminalTabContentSkeleton = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 border-t border-white/10 bg-[#080c14] px-6 py-5 backdrop-blur-xl"
      data-testid="agent-team-terminal-content-skeleton"
      aria-label={t('terminalWorkspace.loadingTerminalTab')}
    >
      <div className="flex h-full flex-col justify-end gap-6">
        {[0, 1, 2].map((sectionIndex) => (
          <div key={sectionIndex} className="space-y-3 border-t border-white/[0.06] pt-4">
            <div className="h-3 w-2/3 max-w-[34rem] animate-pulse rounded bg-white/10" />
            <div className="h-4 w-1/2 max-w-[24rem] animate-pulse rounded bg-white/[0.15]" />
            <div className="h-3 w-1/3 max-w-[18rem] animate-pulse rounded bg-white/[0.08]" />
          </div>
        ))}
      </div>
    </div>
  );
};

const TerminalCommandContextMenu = ({
  menu,
  onClose,
  onCopy,
}: {
  menu: TerminalCommandContextMenuState;
  onClose: () => void;
  onCopy: (text: string) => void | Promise<void>;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      role="menu"
      aria-label={t('terminalWorkspace.terminalCommandActions')}
      tabIndex={-1}
      className="fixed z-[10000] min-w-56 rounded-md border border-white/10 bg-[#181a1f] p-1 text-[13px] text-slate-100 shadow-[0_18px_44px_rgba(0,0,0,0.46)] outline-none"
      data-testid="agent-team-terminal-command-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <TerminalCommandContextMenuItem
        label={t('terminalWorkspace.copy')}
        shortcut="⌘C"
        testId="agent-team-terminal-command-context-copy"
        text={menu.blockText}
        onCopy={onCopy}
      />
      <TerminalCommandContextMenuItem
        label={t('terminalWorkspace.copyCommand')}
        shortcut="⇧⌘C"
        testId="agent-team-terminal-command-context-copy-command"
        text={menu.commandText}
        onCopy={onCopy}
      />
      <TerminalCommandContextMenuItem
        disabled={!menu.outputText}
        label={t('terminalWorkspace.copyOutput')}
        shortcut="⌥⇧⌘C"
        testId="agent-team-terminal-command-context-copy-output"
        text={menu.outputText}
        onCopy={onCopy}
      />
    </div>
  );
};

const TerminalCommandContextMenuItem = ({
  disabled = false,
  label,
  shortcut,
  testId,
  text,
  onCopy,
}: {
  disabled?: boolean;
  label: string;
  shortcut: string;
  testId: string;
  text: string;
  onCopy: (text: string) => void | Promise<void>;
}): React.JSX.Element => (
  <button
    type="button"
    role="menuitem"
    className="flex w-full items-center justify-between gap-6 rounded px-3 py-2 text-left text-slate-100 outline-none transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] disabled:cursor-not-allowed disabled:text-slate-500"
    data-testid={testId}
    disabled={disabled}
    onClick={() => void onCopy(text)}
  >
    <span>{label}</span>
    <span className="font-mono text-[12px] text-slate-500">{shortcut}</span>
  </button>
);

const TerminalMuxTabs = ({
  kernel,
  settingsOpen = false,
  snapshot,
  teamName,
  onSettingsOpenChange,
  onTabContentPendingChange,
  placement = 'console',
}: {
  kernel: WorkspaceKernel;
  settingsOpen?: boolean;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  onSettingsOpenChange?: (open: boolean) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
  placement?: 'console' | 'sheet-header';
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeCandidate, setCloseCandidate] = useState<TerminalMuxTab | null>(null);
  const [tabPreferences, setTabPreferences] = useState<TerminalTabPreferences>(() =>
    readStoredTerminalTabPreferences(teamName)
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<TerminalTabDropIndicator | null>(null);
  const [tabPointerDrag, setTabPointerDrag] = useState<TerminalTabPointerDrag | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const prewarmInFlightRef = useRef<string | null>(null);
  const prewarmFailedSessionRef = useRef<string | null>(null);
  const suppressNextTabClickRef = useRef(false);
  const tabListElementRef = useRef<HTMLDivElement | null>(null);
  const tabElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabPointerDragRef = useRef<TerminalTabPointerDrag | null>(null);
  const tabRectsBeforeReorderRef = useRef<Map<string, DOMRect> | null>(null);
  const topology = snapshot.attachedSession?.topology ?? null;
  const controls = resolveTerminalTopologyControlState(snapshot);
  const tabs = topology?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !isPrewarmedTerminalTab(tab));
  const visibleTabIdsKey = visibleTabs.map((tab) => tab.tab_id).join('\u001f');
  const orderedVisibleTabs = useMemo(
    () => orderTerminalTabsByPreference(visibleTabs, tabPreferences.order),
    [tabPreferences.order, visibleTabs]
  );
  const orderedVisibleTabIdsKey = orderedVisibleTabs.map((tab) => tab.tab_id).join('\u001f');
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

  const setTabPointerDragState = useCallback((nextDrag: TerminalTabPointerDrag | null): void => {
    tabPointerDragRef.current = nextDrag;
    setTabPointerDrag(nextDrag);
  }, []);

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

  const registerTabElement = useCallback((tabId: string, element: HTMLDivElement | null): void => {
    if (element) {
      tabElementRefs.current.set(tabId, element);
      return;
    }

    tabElementRefs.current.delete(tabId);
  }, []);

  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const captureTabRectsBeforeReorder = useCallback((): void => {
    if (prefersReducedMotion()) {
      tabRectsBeforeReorderRef.current = null;
      return;
    }

    const rects = new Map<string, DOMRect>();
    tabElementRefs.current.forEach((element, tabId) => {
      rects.set(tabId, element.getBoundingClientRect());
    });
    tabRectsBeforeReorderRef.current = rects.size > 1 ? rects : null;
  }, [prefersReducedMotion]);

  useLayoutEffect(() => {
    const previousRects = tabRectsBeforeReorderRef.current;
    if (!previousRects || prefersReducedMotion()) {
      tabRectsBeforeReorderRef.current = null;
      return;
    }

    tabRectsBeforeReorderRef.current = null;
    tabElementRefs.current.forEach((element, tabId) => {
      if (tabId === draggingTabId) {
        return;
      }

      const previousRect = previousRects.get(tabId);
      if (!previousRect) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        return;
      }

      if (typeof element.animate !== 'function') {
        return;
      }

      element.getAnimations?.().forEach((animation) => animation.cancel());
      element.animate(
        [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0, 0)' }],
        {
          duration: 180,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }
      );
    });
  }, [draggingTabId, orderedVisibleTabIdsKey, prefersReducedMotion]);

  const runMuxCommands = async (
    actionId: string,
    commands: readonly TerminalMuxCommand[]
  ): Promise<void> => {
    if (busy || !activeSessionId) {
      return;
    }

    const tabContentPending =
      actionId.startsWith('focus-tab:') || actionId === 'activate-prewarmed-tab';
    setPendingAction(actionId);
    setError(null);
    if (tabContentPending) {
      onTabContentPendingChange?.(true);
    }
    try {
      for (const command of commands) {
        await kernel.commands.dispatchMuxCommand(activeSessionId, command);
      }
      await kernel.commands.attachSession(activeSessionId);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setPendingAction(null);
      if (tabContentPending) {
        onTabContentPendingChange?.(false);
      }
    }
  };

  const runMuxCommand = async (actionId: string, command: TerminalMuxCommand): Promise<void> => {
    await runMuxCommands(actionId, [command]);
  };

  useEffect(() => {
    setTabPreferences(readStoredTerminalTabPreferences(teamName));
  }, [teamName]);

  useEffect(
    () => () => {
      onTabContentPendingChange?.(false);
    },
    [onTabContentPendingChange]
  );

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
    onSettingsOpenChange?.(false);
    if (!controls.canFocusTab || tabId === activeTabId) {
      return;
    }

    await runMuxCommand(`focus-tab:${tabId}`, { kind: 'focus_tab', tab_id: tabId });
  };

  const createTab = async (): Promise<void> => {
    if (!controls.canCreateTab) {
      return;
    }

    onSettingsOpenChange?.(false);
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

    const tabToFocusAfterClose =
      controls.canFocusTab && tab.tab_id === activeVisibleTabId
        ? resolveVisibleTabToFocusAfterClose(orderedVisibleTabs, tab.tab_id)
        : null;
    const commands: TerminalMuxCommand[] = [{ kind: 'close_tab', tab_id: tab.tab_id }];

    if (tabToFocusAfterClose) {
      commands.push({ kind: 'focus_tab', tab_id: tabToFocusAfterClose });
    }

    await runMuxCommands(`close-tab:${tab.tab_id}`, commands);
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

    captureTabRectsBeforeReorder();
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

  const getTabReorderTarget = useCallback(
    (sourceTabId: string, clientX: number): TerminalTabDropIndicator | null => {
      const candidates = orderedVisibleTabs
        .filter((tab) => tab.tab_id !== sourceTabId)
        .map((tab) => {
          const element = tabElementRefs.current.get(tab.tab_id);
          const rect = element?.getBoundingClientRect();
          return rect
            ? {
                centerX: rect.left + rect.width / 2,
                left: rect.left,
                tabId: tab.tab_id,
              }
            : null;
        })
        .filter(
          (
            candidate
          ): candidate is {
            centerX: number;
            left: number;
            tabId: string;
          } => candidate !== null
        )
        .sort((left, right) => left.left - right.left);

      if (candidates.length === 0) {
        return null;
      }

      const beforeCandidate = candidates.find((candidate) => clientX < candidate.centerX);
      if (beforeCandidate) {
        return { placementMode: 'before', tabId: beforeCandidate.tabId };
      }

      return { placementMode: 'after', tabId: candidates[candidates.length - 1].tabId };
    },
    [orderedVisibleTabs]
  );

  const endTabPointerDrag = useCallback(
    (event?: React.PointerEvent<HTMLDivElement>): void => {
      const activeDrag = tabPointerDragRef.current;
      if (event && activeDrag?.pointerId !== event.pointerId) {
        return;
      }

      if (event && activeDrag?.active) {
        event.preventDefault();
      }

      if (event) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Pointer capture can already be released by the browser.
        }
      }

      setTabPointerDragState(null);
      setDraggingTabId(null);
      setDropIndicator(null);
      tabRectsBeforeReorderRef.current = null;
      window.setTimeout(() => {
        suppressNextTabClickRef.current = false;
      }, 0);
    },
    [setTabPointerDragState]
  );

  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    tab: TerminalMuxTab
  ): void => {
    const target = event.target;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      editingTabId === tab.tab_id ||
      busy ||
      (target instanceof HTMLElement && shouldIgnoreTerminalTabDragTarget(target))
    ) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    setTabPointerDragState({
      active: false,
      grabOffsetX: event.clientX - rect.left,
      offsetX: 0,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      tabId: tab.tab_id,
    });
    setDropIndicator(null);

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some test environments do not implement pointer capture.
    }
  };

  const handleTabPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const activeDrag = tabPointerDragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - activeDrag.startClientX;
    const deltaY = event.clientY - activeDrag.startClientY;
    const shouldStartDrag =
      activeDrag.active || (Math.abs(deltaX) >= 4 && Math.abs(deltaX) >= Math.abs(deltaY));
    if (!shouldStartDrag) {
      return;
    }

    event.preventDefault();
    suppressNextTabClickRef.current = true;
    setDraggingTabId(activeDrag.tabId);

    const element = tabElementRefs.current.get(activeDrag.tabId);
    const rect = element?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const baseLeft = rect.left - activeDrag.offsetX;
    const tabListRect = tabListElementRef.current?.getBoundingClientRect();
    const unclampedLeft = event.clientX - activeDrag.grabOffsetX;
    const clampedLeft = tabListRect
      ? Math.min(
          Math.max(unclampedLeft, tabListRect.left),
          Math.max(tabListRect.left, tabListRect.right - rect.width)
        )
      : unclampedLeft;
    const nextDrag = {
      ...activeDrag,
      active: true,
      offsetX: clampedLeft - baseLeft,
    };

    setTabPointerDragState(nextDrag);

    const reorderTarget = getTabReorderTarget(activeDrag.tabId, event.clientX);
    if (!reorderTarget) {
      setDropIndicator(null);
      return;
    }

    const nextOrder = reorderTerminalTabsById(
      tabPreferences.order,
      visibleTabs,
      activeDrag.tabId,
      reorderTarget.tabId,
      reorderTarget.placementMode
    );
    if (
      areStringArraysEqual(
        orderedVisibleTabs.map((tab) => tab.tab_id),
        nextOrder
      )
    ) {
      setDropIndicator(null);
      return;
    }

    setDropIndicator((current) =>
      current?.tabId === reorderTarget.tabId &&
      current.placementMode === reorderTarget.placementMode
        ? current
        : reorderTarget
    );
    reorderTabs(activeDrag.tabId, reorderTarget.tabId, reorderTarget.placementMode);
  };

  const handleTabPointerUp = (
    event: React.PointerEvent<HTMLDivElement>,
    tab: TerminalMuxTab
  ): void => {
    const activeDrag = tabPointerDragRef.current;
    const shouldFocusTab =
      activeDrag?.pointerId === event.pointerId &&
      activeDrag.tabId === tab.tab_id &&
      controls.canFocusTab &&
      tab.tab_id !== activeTabId &&
      !busy;

    if (shouldFocusTab) {
      suppressNextTabClickRef.current = true;
      void focusTab(tab.tab_id);
    }

    endTabPointerDrag(event);
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
            ref={tabListElementRef}
            role="tablist"
            aria-label={t('terminalWorkspace.terminalTabs')}
            tabIndex={-1}
          >
            {visibleTabs.length === 0 ? (
              headerPlacement ? (
                <span className="sr-only">{t('terminalWorkspace.noTerminalTabs')}</span>
              ) : (
                <span className="px-2 py-1.5 text-xs text-slate-500">
                  {t('terminalWorkspace.noTerminalTabs')}
                </span>
              )
            ) : (
              orderedVisibleTabs.map((tab, index) => {
                const label = formatMuxTabTitle(tab, index);
                const active = !settingsOpen && tab.tab_id === activeVisibleTabId;
                const pendingClose = pendingAction === `close-tab:${tab.tab_id}`;
                const closeLabel = canCloseVisibleTabs
                  ? t('terminalWorkspace.closeTerminalTab', { tab: label })
                  : t('terminalWorkspace.createAnotherTabBeforeClosing');
                const explicitColorId = tabPreferences.colors[tab.tab_id];
                const color = resolveTerminalTabColor(explicitColorId);
                const editing = editingTabId === tab.tab_id;
                const tabColorStyle =
                  active || explicitColorId
                    ? ({
                        backgroundColor: color.background,
                        '--tp-tab-border': color.border,
                        '--tp-tab-border-bottom': active ? 'transparent' : color.border,
                      } as React.CSSProperties)
                    : undefined;
                const dragOffsetX =
                  tabPointerDrag?.tabId === tab.tab_id ? tabPointerDrag.offsetX : 0;
                const tabStyle =
                  dragOffsetX !== 0
                    ? ({
                        ...(tabColorStyle ?? {}),
                        transform: `translateX(${dragOffsetX}px)`,
                      } as React.CSSProperties)
                    : tabColorStyle;
                return (
                  <ContextMenu key={tab.tab_id}>
                    <ContextMenuTrigger asChild>
                      <div
                        ref={(element) => registerTabElement(tab.tab_id, element)}
                        className={cn(
                          'group relative inline-grid h-7 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)] overflow-hidden border text-xs transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out will-change-transform',
                          headerPlacement
                            ? 'max-w-40 rounded-b-none rounded-t-md'
                            : 'max-w-44 rounded-b-none rounded-t-md',
                          active
                            ? 'relative z-10 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                            : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200',
                          (active || explicitColorId) &&
                            'border-[var(--tp-tab-border)] border-b-[var(--tp-tab-border-bottom)]',
                          draggingTabId === tab.tab_id &&
                            'z-30 cursor-grabbing shadow-[0_10px_26px_rgba(0,0,0,0.34)]'
                        )}
                        data-active={active}
                        data-dragging={draggingTabId === tab.tab_id}
                        data-drop-placement={
                          dropIndicator?.tabId === tab.tab_id
                            ? dropIndicator.placementMode
                            : undefined
                        }
                        data-terminal-tab-id={tab.tab_id}
                        onPointerCancel={endTabPointerDrag}
                        onPointerDown={(event) => handleTabPointerDown(event, tab)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={(event) => handleTabPointerUp(event, tab)}
                        style={tabStyle}
                      >
                        {dropIndicator?.tabId === tab.tab_id && draggingTabId !== tab.tab_id ? (
                          <span
                            className={cn(
                              'pointer-events-none absolute bottom-0 top-1 z-30 w-0.5 rounded-full bg-sky-300/90 shadow-[0_0_10px_rgba(125,211,252,0.75)]',
                              dropIndicator.placementMode === 'before' ? '-left-px' : '-right-px'
                            )}
                            data-testid="agent-team-terminal-tab-drop-indicator"
                          />
                        ) : null}
                        {editing ? (
                          <div className="inline-flex min-w-0 items-center gap-1.5 px-1.5">
                            <Pencil size={12} className="shrink-0 text-slate-400" />
                            <input
                              ref={renameInputRef}
                              className="h-5 min-w-0 flex-1 rounded border border-white/15 bg-black/35 px-1 font-mono text-[12px] text-slate-100 outline-none ring-0 focus:border-sky-400/60"
                              value={editingTitle}
                              aria-label={t('terminalWorkspace.editTerminalTabTitle')}
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
                              className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                              aria-selected={active}
                              data-testid="agent-team-terminal-mux-tab"
                              disabled={busy}
                              role="tab"
                              onClick={(event) => {
                                if (suppressNextTabClickRef.current) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  return;
                                }
                                void focusTab(tab.tab_id);
                              }}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                startRenameTab(tab, label);
                              }}
                            >
                              <span className="min-w-0 truncate">{label}</span>
                            </button>
                          </TerminalButtonTooltip>
                        )}
                        {!editing ? (
                          <TerminalButtonTooltip label={closeLabel}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'pointer-events-none absolute bottom-0 right-0 top-0 z-20 h-7 w-7 rounded-none border-0 bg-transparent p-0 text-slate-500 opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
                                pendingClose && 'pointer-events-auto opacity-100'
                              )}
                              aria-label={t('terminalWorkspace.closeTerminalTab', { tab: label })}
                              data-terminal-tab-drag-ignore="true"
                              data-testid="agent-team-terminal-close-mux-tab"
                              disabled={!canCloseVisibleTabs || (busy && !pendingClose)}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
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
                        ) : null}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent alignOffset={-4} className="w-48">
                      <ContextMenuItem
                        disabled={!controls.canRenameTab || busy}
                        onSelect={() => startRenameTab(tab, label)}
                      >
                        <Pencil size={13} />
                        {t('terminalWorkspace.renameTab')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette size={13} />
                          {t('terminalWorkspace.tabColor')}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuLabel>{t('terminalWorkspace.chooseColor')}</ContextMenuLabel>
                          {TERMINAL_TAB_COLOR_OPTIONS.map((option) => (
                            <ContextMenuItem
                              key={option.id}
                              onSelect={() => setTabColor(tab.tab_id, option.id)}
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: option.accent }}
                              />
                              <span className="min-w-0 flex-1">
                                {formatTerminalTabColorLabel(t, option.id)}
                              </span>
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
            {settingsOpen ? (
              <div
                className={cn(
                  'group relative z-10 inline-grid h-7 max-w-44 shrink-0 select-none grid-cols-[minmax(0,1fr)] overflow-hidden rounded-b-none rounded-t-md border border-sky-400/55 border-b-transparent bg-sky-400/15 text-xs text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
                  headerPlacement ? 'max-w-40' : 'max-w-44'
                )}
                data-testid="agent-team-terminal-settings-tab"
              >
                <button
                  type="button"
                  className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                  aria-selected="true"
                  role="tab"
                  onClick={() => onSettingsOpenChange?.(true)}
                >
                  <Palette size={13} className="shrink-0 text-sky-200" />
                  <span className="min-w-0 truncate">{t('terminalWorkspace.settingsTab')}</span>
                </button>
                <TerminalButtonTooltip label={t('terminalWorkspace.closeTerminalSettings')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute bottom-0 right-0 top-0 h-7 w-7 rounded-none border-0 bg-transparent p-0 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                    aria-label={t('terminalWorkspace.closeTerminalSettingsTab')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSettingsOpenChange?.(false);
                    }}
                  >
                    <X size={12} />
                  </Button>
                </TerminalButtonTooltip>
              </div>
            ) : null}
            <TerminalButtonTooltip
              label={
                controls.canCreateTab
                  ? t('terminalWorkspace.createTerminalTab')
                  : t('terminalWorkspace.terminalTabsUnavailable')
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
                aria-label={t('terminalWorkspace.createTerminalTab')}
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
            <AlertDialogTitle>
              {t('terminalWorkspace.closeTerminalTabDialogTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('terminalWorkspace.closeTerminalTabDialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('terminalWorkspace.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const tab = closeCandidate;
                setCloseCandidate(null);
                if (tab) {
                  void closeTab(tab);
                }
              }}
            >
              {t('terminalWorkspace.closeTab')}
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
  const label = formatWorkingDirectory(projectPath, t('terminalWorkspace.shellDefaultDirectory'));
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

const TerminalWorkspaceSettingsPage = ({
  appearanceSettings,
  kernel,
  onAppearanceSettingsChange,
  onClose,
  onReload,
  onStopRuntime,
  snapshot,
}: {
  appearanceSettings: TerminalAppearanceSettings;
  kernel: WorkspaceKernel;
  onAppearanceSettingsChange: (updates: Partial<TerminalAppearanceSettings>) => void;
  onClose: () => void;
  onReload: () => void;
  onStopRuntime: () => Promise<void>;
  snapshot: TerminalWorkspaceSnapshot;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pendingAction, setPendingAction] = useState<TerminalWorkspaceSettingsActionId | null>(
    null
  );
  const display = snapshot.terminalDisplay;

  const runAction = async (
    actionId: TerminalWorkspaceSettingsActionId,
    action: () => Promise<void> | void
  ): Promise<void> => {
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
    <TerminalWorkspaceSettingsView
      appearanceSettings={appearanceSettings}
      display={{
        fontScale: display.fontScale,
        lineWrap: display.lineWrap,
        themeId: snapshot.theme.themeId,
      }}
      fontScaleOptions={terminalPlatformTerminalFontScales.map((fontScale) => ({
        id: fontScale,
        label: formatFontScaleLabel(t, fontScale),
      }))}
      onAppearanceSettingsChange={onAppearanceSettingsChange}
      onClose={onClose}
      onFontScaleChange={(fontScale) => kernel.commands.setTerminalFontScale(fontScale)}
      onLineWrapChange={(lineWrap) => kernel.commands.setTerminalLineWrap(lineWrap)}
      onReconnect={() => void runAction('bootstrap', () => kernel.commands.bootstrap())}
      onRefreshSessions={() =>
        void runAction('refresh-sessions', () => kernel.commands.refreshSessions())
      }
      onReload={onReload}
      onResetAppearance={() => onAppearanceSettingsChange(DEFAULT_TERMINAL_APPEARANCE_SETTINGS)}
      onStopRuntime={() => void runAction('stop-runtime', onStopRuntime)}
      onThemeChange={(themeId) => kernel.commands.setTheme(themeId)}
      pendingAction={pendingAction}
      themeOptions={terminalPlatformThemeManifests.map((theme) => ({
        id: theme.id,
        label: formatThemeLabel(t, theme.displayName, theme.id),
      }))}
    />
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

function resolveTerminalCommandContextMenuState(
  event: MouseEvent
): TerminalCommandContextMenuState | null {
  const entry = findTerminalHistoryEntryElement(event);
  if (!entry) {
    return null;
  }

  const commandText = getTerminalHistoryEntryText(entry, [
    '[part~="history-entry-command-text"]',
    '.history-entry-command .history-entry-text',
    '[part~="history-entry-command"]',
    '.history-entry-command',
  ]);
  if (!commandText) {
    return null;
  }

  const outputText = getTerminalHistoryEntryText(entry, [
    '[part~="history-entry-output-text"]',
    '.history-entry-output .history-entry-text',
    '[part~="history-entry-output"]',
    '.history-entry-output',
  ]);
  const blockText = [commandText, outputText].filter(Boolean).join('\n');

  return {
    blockText,
    commandText,
    outputText,
    x: clampTerminalContextMenuCoordinate(event.clientX, window.innerWidth, 240),
    y: clampTerminalContextMenuCoordinate(event.clientY, window.innerHeight, 132),
  };
}

function findTerminalHistoryEntryElement(event: MouseEvent): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const pathItem of path) {
    if (pathItem instanceof HTMLElement && isTerminalHistoryEntryElement(pathItem)) {
      return pathItem;
    }
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return target.closest<HTMLElement>('.history-entry,[part~="history-entry"]');
}

function isTerminalHistoryEntryElement(element: HTMLElement): boolean {
  return (
    element.classList.contains('history-entry') || hasTerminalElementPart(element, 'history-entry')
  );
}

function hasTerminalElementPart(element: HTMLElement, part: string): boolean {
  return (
    element
      .getAttribute('part')
      ?.split(/\s+/u)
      .some((value) => value === part) === true
  );
}

function getTerminalHistoryEntryText(entry: HTMLElement, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const text = normalizeTerminalContextMenuText(
      Array.from(entry.querySelectorAll<HTMLElement>(selector))
        .map((element) => element.textContent ?? '')
        .join('\n')
    );
    if (text) {
      return text;
    }
  }

  return '';
}

function normalizeTerminalContextMenuText(value: string): string {
  return value
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .trim();
}

function clampTerminalContextMenuCoordinate(value: number, max: number, size: number): number {
  return Math.max(8, Math.min(value, Math.max(8, max - size - 8)));
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the textarea fallback below.
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
  } finally {
    textArea.remove();
  }
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

function readStoredTerminalAppearanceSettings(teamName: string): TerminalAppearanceSettings {
  const raw = readStoredValue(storageKey(teamName, 'appearance-settings'));
  if (!raw) return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;

  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeTerminalAppearanceSettings(parsed);
  } catch {
    return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;
  }
}

function normalizeTerminalAppearanceSettings(value: unknown): TerminalAppearanceSettings {
  if (!isRecord(value)) {
    return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;
  }

  return {
    version: DEFAULT_TERMINAL_APPEARANCE_SETTINGS.version,
    fontSizePx: clampFiniteNumber(
      value.fontSizePx,
      11,
      24,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.fontSizePx
    ),
    opacityPercent: clampFiniteNumber(
      value.opacityPercent,
      35,
      100,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.opacityPercent
    ),
    backgroundMode: isTerminalBackgroundMode(value.backgroundMode)
      ? value.backgroundMode
      : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundMode,
    backgroundColor:
      typeof value.backgroundColor === 'string'
        ? normalizeTerminalAppearanceColor(value.backgroundColor)
        : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundColor,
    backgroundImageUrl:
      typeof value.backgroundImageUrl === 'string' ? value.backgroundImageUrl.slice(0, 2048) : '',
    backgroundImageFit: isTerminalBackgroundImageFit(value.backgroundImageFit)
      ? value.backgroundImageFit
      : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundImageFit,
    backdropBlurPx: clampFiniteNumber(
      value.backdropBlurPx,
      0,
      40,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backdropBlurPx
    ),
    dimBackgroundImage:
      typeof value.dimBackgroundImage === 'boolean'
        ? value.dimBackgroundImage
        : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.dimBackgroundImage,
  };
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
      .slice(-TERMINAL_COMMAND_HISTORY_LIMIT);
  } catch {
    return null;
  }
}

function persistValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort UI preference persistence.
  }
}

function persistTerminalAppearanceSettings(
  teamName: string,
  settings: TerminalAppearanceSettings
): void {
  try {
    window.localStorage.setItem(
      storageKey(teamName, 'appearance-settings'),
      JSON.stringify(normalizeTerminalAppearanceSettings(settings))
    );
  } catch {
    // Best-effort appearance preference persistence.
  }
}

function createTerminalAppearanceStyle(settings: TerminalAppearanceSettings): CSSProperties {
  const normalizedSettings = normalizeTerminalAppearanceSettings(settings);
  const imageUrl = normalizedSettings.backgroundImageUrl.trim();
  const hasImage = normalizedSettings.backgroundMode === 'image' && imageUrl.length > 0;

  return {
    '--agent-terminal-font-size': `${normalizedSettings.fontSizePx}px`,
    '--agent-terminal-panel-opacity': String(normalizedSettings.opacityPercent / 100),
    '--agent-terminal-background-color': normalizedSettings.backgroundColor,
    '--agent-terminal-background-image': hasImage ? createCssUrl(imageUrl) : 'none',
    '--agent-terminal-background-position': getTerminalBackgroundPosition(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-background-repeat': getTerminalBackgroundRepeat(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-background-size': getTerminalBackgroundSize(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-backdrop-blur': `${normalizedSettings.backdropBlurPx}px`,
    '--agent-terminal-background-image-blur': hasImage
      ? `${normalizedSettings.backdropBlurPx}px`
      : '0px',
    '--agent-terminal-image-dim-opacity':
      hasImage && normalizedSettings.dimBackgroundImage ? '0.42' : '0',
  } as CSSProperties;
}

function clampFiniteNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(numberValue), min), max);
}

function createCssUrl(value: string): string {
  return `url("${value.replace(/["\\\n\r]/gu, '')}")`;
}

function getTerminalBackgroundSize(fit: TerminalBackgroundImageFit): string {
  if (fit === 'stretch') return '100% 100%';
  if (fit === 'tile' || fit === 'center') return 'auto';
  return fit;
}

function getTerminalBackgroundRepeat(fit: TerminalBackgroundImageFit): string {
  return fit === 'tile' ? 'repeat' : 'no-repeat';
}

function getTerminalBackgroundPosition(fit: TerminalBackgroundImageFit): string {
  return fit === 'tile' ? 'top left' : 'center';
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
      JSON.stringify(entries.slice(-TERMINAL_COMMAND_HISTORY_LIMIT))
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
  const storedStatus = isTerminalCommandRunPresentationStatus(value.status)
    ? value.status
    : 'unknown';
  const status = storedStatus === 'running' ? 'unknown' : storedStatus;

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

function resolveVisibleTabToFocusAfterClose(
  orderedTabs: readonly TerminalMuxTab[],
  closingTabId: string
): string | null {
  const closingIndex = orderedTabs.findIndex((tab) => tab.tab_id === closingTabId);
  if (closingIndex < 0) {
    return null;
  }

  return orderedTabs[closingIndex - 1]?.tab_id ?? orderedTabs[closingIndex + 1]?.tab_id ?? null;
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

function shouldIgnoreTerminalTabDragTarget(target: HTMLElement): boolean {
  return Boolean(target.closest('[data-terminal-tab-drag-ignore="true"],input,textarea,select,a'));
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

function formatThemeLabel(t: TeamTFunction, displayName: string, themeId: string): string {
  if (themeId === 'terminal-platform-default') return t('terminalWorkspace.themeDark');
  if (themeId === 'terminal-platform-light') return t('terminalWorkspace.themeLight');
  return displayName.replace(/^Terminal Platform\s*/i, '').trim() || displayName;
}

function formatFontScaleLabel(t: TeamTFunction, fontScale: string): string {
  if (fontScale === 'compact') return t('terminalWorkspace.fontScaleCompact');
  if (fontScale === 'large') return t('terminalWorkspace.fontScaleLarge');
  return t('terminalWorkspace.fontScaleDefault');
}

function formatTerminalTabColorLabel(t: TeamTFunction, colorId: TerminalTabColorId): string {
  switch (colorId) {
    case 'slate':
      return t('terminalWorkspace.tabColorSlate');
    case 'sky':
      return t('terminalWorkspace.tabColorSky');
    case 'blue':
      return t('terminalWorkspace.tabColorBlue');
    case 'cyan':
      return t('terminalWorkspace.tabColorCyan');
    case 'teal':
      return t('terminalWorkspace.tabColorTeal');
    case 'emerald':
      return t('terminalWorkspace.tabColorEmerald');
    case 'lime':
      return t('terminalWorkspace.tabColorLime');
    case 'amber':
      return t('terminalWorkspace.tabColorAmber');
    case 'orange':
      return t('terminalWorkspace.tabColorOrange');
    case 'rose':
      return t('terminalWorkspace.tabColorRose');
    case 'violet':
      return t('terminalWorkspace.tabColorViolet');
  }
}

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
