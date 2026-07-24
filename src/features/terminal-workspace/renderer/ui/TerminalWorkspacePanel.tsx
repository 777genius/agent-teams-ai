import {
  type ComponentRef,
  type CSSProperties,
  useCallback,
  useEffect,
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

import { readStoredTerminalCommandHistory } from '../adapters/terminalCommandHistoryStorage';
import {
  persistTerminalTabPreferences,
  readStoredTerminalTabPreferences,
} from '../adapters/terminalTabPreferencesStorage';
import { useTerminalCommandAutocomplete } from '../hooks/useTerminalCommandAutocomplete';
import { useTerminalCommandContextMenu } from '../hooks/useTerminalCommandContextMenu';
import { useTerminalCommandHistoryPersistence } from '../hooks/useTerminalCommandHistoryPersistence';
import { useTerminalCommandRuns } from '../hooks/useTerminalCommandRuns';
import {
  type TerminalMuxCommands,
  useTerminalMuxTabLifecycle,
} from '../hooks/useTerminalMuxTabLifecycle';
import { useTerminalTabPointerReorder } from '../hooks/useTerminalTabPointerReorder';
import {
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  normalizeTerminalAppearanceSettings,
  resolveTerminalBackgroundImageUrl,
  type TerminalAppearanceSettings,
  type TerminalBackgroundImageFit,
} from '../model/terminalAppearanceSettings';
import {
  createTerminalCommandScreenLines,
  TERMINAL_COMMAND_HISTORY_LIMIT,
} from '../model/terminalCommandRuns';
import {
  formatTerminalPromptLabel,
  formatWorkingDirectory,
} from '../model/terminalPathPresentation';
import {
  areStringArraysEqual,
  areTerminalTabPreferencesEqual,
  formatMuxTabTitle,
  getTerminalTabColorLabelKey,
  isPrewarmedTerminalTab,
  normalizeTerminalTabPreferences,
  orderTerminalTabsByPreference,
  reorderTerminalTabsById,
  resolveTerminalTabColor,
  TERMINAL_TAB_COLOR_OPTIONS,
  type TerminalTabColorId,
  type TerminalTabPreferences,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';

import { TerminalCommandContextMenu } from './TerminalCommandContextMenu';
import {
  type TerminalWorkspaceSettingsActionId,
  TerminalWorkspaceSettingsView,
} from './TerminalWorkspaceSettingsView';

import type {
  TerminalWorkspaceBootstrap,
  TerminalWorkspaceBootstrapRequest,
} from '../../contracts';
import type { TerminalTabReorderIntent } from '../utils/terminalTabPointerReorder';

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

const TERMINAL_PLATFORM_GITHUB_URL = 'https://github.com/777genius/terminal-platform';
type TerminalScreenElementHandle = ComponentRef<typeof TerminalScreen> & {
  followOutput?: boolean;
  requestUpdate?: () => void;
  scrollToLatestOutput?: () => void;
};
type TerminalCommandDockElementHandle = ComponentRef<typeof TerminalCommandDock>;
type TeamTFunction = ReturnType<typeof useAppTranslation>['t'];

const TerminalButtonTooltip = ({
  children,
  label,
  side = 'top',
}: Readonly<{
  children: React.ReactElement;
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>{label}</TooltipContent>
  </Tooltip>
);

export const TerminalWorkspacePanel = (props: TerminalWorkspacePanelProps): React.JSX.Element => (
  <TerminalWorkspacePanelTeamScope key={props.teamName} {...props} />
);
const TerminalWorkspacePanelTeamScope = ({
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
      initialCommandHistoryEntries: readStoredTerminalCommandHistory(teamName),
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
  const { activeCommandRuns } = useTerminalCommandRuns({
    activePaneId: activeCommandPaneId,
    activeSessionId: activeCommandSessionId,
    eventSource: commandDockElement,
    onCommandSubmitted: scrollTerminalToLatest,
    screenLines: activeScreenCommandLines,
    screenSequence: activeScreen?.sequence,
    teamName,
  });
  const { autocompleteSuggestion } = useTerminalCommandAutocomplete({
    commandHistory: snapshot.commandHistory.entries,
    commandRuns: activeCommandRuns,
    cwd: projectPath,
    eventSource: commandDockElement,
    paneId: activeCommandPaneId,
    sessionId: activeCommandSessionId,
  });
  const {
    copyMenuText: copyCommandContextMenuText,
    handleContextMenuCapture: handleTerminalScreenContextMenuCapture,
    handleOpenChange: handleCommandContextMenuOpenChange,
    menu: commandContextMenu,
  } = useTerminalCommandContextMenu({
    contextKey: JSON.stringify([
      teamName,
      activeCommandSessionId,
      activeCommandPaneId,
      settingsOpen,
    ]),
  });

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

  useTerminalCommandHistoryPersistence({
    entries: snapshot.commandHistory.entries,
    teamName,
  });

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
      commands={kernel.commands}
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
      {commandContextMenu ? (
        <TerminalCommandContextMenu
          menu={commandContextMenu}
          onCopy={copyCommandContextMenuText}
          onOpenChange={handleCommandContextMenuOpenChange}
        />
      ) : null}
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

const TerminalMuxTabs = ({
  commands,
  settingsOpen = false,
  snapshot,
  teamName,
  onSettingsOpenChange,
  onTabContentPendingChange,
  placement = 'console',
}: {
  commands: TerminalMuxCommands;
  settingsOpen?: boolean;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  onSettingsOpenChange?: (open: boolean) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
  placement?: 'console' | 'sheet-header';
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [tabPreferences, setTabPreferences] = useState<TerminalTabPreferences>(() =>
    readStoredTerminalTabPreferences(teamName)
  );
  const topology = snapshot.attachedSession?.topology ?? null;
  const controls = resolveTerminalTopologyControlState(snapshot);
  const tabs = topology?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !isPrewarmedTerminalTab(tab));
  const visibleTabIdsKey = visibleTabs.map((tab) => tab.tab_id).join('\u001f');
  const orderedVisibleTabs = useMemo(
    () => orderTerminalTabsByPreference(visibleTabs, tabPreferences.order),
    [tabPreferences.order, visibleTabs]
  );
  const orderedVisibleTabIds = useMemo(
    () => orderedVisibleTabs.map((tab) => tab.tab_id),
    [orderedVisibleTabs]
  );
  const prewarmedTab = tabs.find(isPrewarmedTerminalTab) ?? null;
  const activeSessionId = controls.activeSessionId;
  const activeTabId =
    controls.activeTab?.tab_id ?? topology?.focused_tab ?? tabs[0]?.tab_id ?? null;
  const activeVisibleTabId = visibleTabs.some((tab) => tab.tab_id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.tab_id ?? null);
  const headerPlacement = placement === 'sheet-header';
  const canCloseVisibleTabs = controls.canCloseTab && visibleTabs.length > 1;
  const {
    busy,
    cancelRenameTab,
    closeCandidate,
    commitRenameTab,
    confirmCloseCandidate,
    createTab,
    dismissCloseCandidate,
    editingTabId,
    editingTitle,
    error,
    focusTab,
    pendingAction,
    renameInputRef,
    requestCloseTab,
    setEditingTitle,
    startRenameTab,
  } = useTerminalMuxTabLifecycle({
    activeSessionId,
    activeTabId,
    activeVisibleTabId,
    canCloseVisibleTabs,
    canCreateTab: controls.canCreateTab,
    canFocusTab: controls.canFocusTab,
    canRenameTab: controls.canRenameTab,
    commands,
    orderedVisibleTabs,
    prewarmedTab,
    snapshot,
    tabsCount: tabs.length,
    visibleTabs,
    onSettingsOpenChange,
    onTabContentPendingChange,
  });

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

  const reorderTabs = useCallback(
    ({ placementMode, sourceTabId, targetTabId }: TerminalTabReorderIntent): void => {
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
    },
    [updateTabPreferences, visibleTabs]
  );

  const {
    draggingTabId,
    dropIndicator,
    endTabPointerDrag,
    getTabDragOffsetX,
    handleTabClick,
    handleTabLostPointerCapture,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerUp,
    registerTabElement,
    tabListElementRef,
  } = useTerminalTabPointerReorder({
    activeTabId,
    canFocusTab: controls.canFocusTab,
    disabled: busy,
    editingTabId,
    orderedTabIds: orderedVisibleTabIds,
    scopeKey: `${teamName}\u001f${activeSessionId ?? ''}`,
    onRequestFocus: focusTab,
    onRequestReorder: reorderTabs,
  });

  useEffect(() => {
    setTabPreferences(readStoredTerminalTabPreferences(teamName));
  }, [teamName]);

  useEffect(() => {
    if (visibleTabs.length === 0) {
      return;
    }

    updateTabPreferences((current) => normalizeTerminalTabPreferences(current, visibleTabs));
  }, [updateTabPreferences, visibleTabIdsKey, visibleTabs]);

  const setTabColor = (tabId: string, colorId: TerminalTabColorId): void => {
    updateTabPreferences((current) => ({
      ...current,
      colors: {
        ...current.colors,
        [tabId]: colorId,
      },
    }));
  };

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
                const dragOffsetX = getTabDragOffsetX(tab.tab_id);
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
                        onLostPointerCapture={handleTabLostPointerCapture}
                        onPointerCancel={endTabPointerDrag}
                        onPointerDown={(event) => handleTabPointerDown(event, tab.tab_id)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={(event) => handleTabPointerUp(event, tab.tab_id)}
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
                              onClick={(event) => handleTabClick(event, tab.tab_id)}
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
                                {t(getTerminalTabColorLabelKey(option.id))}
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
            dismissCloseCandidate();
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
            <AlertDialogAction onClick={() => void confirmCloseCandidate()}>
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
  const imageUrl = resolveTerminalBackgroundImageUrl(normalizedSettings.backgroundImageUrl);
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
