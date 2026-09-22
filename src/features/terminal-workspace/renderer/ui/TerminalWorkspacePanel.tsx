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
import { cn } from '@renderer/lib/utils';
import { createWorkspaceWebSocketTransport } from '@terminal-platform/workspace-adapter-websocket';
import { createWorkspaceKernel, type WorkspaceKernel } from '@terminal-platform/workspace-core';
import {
  TerminalCommandDock,
  TerminalScreen,
  TerminalWorkspace,
  useWorkspaceSnapshot,
} from '@terminal-platform/workspace-react';
import { AlertTriangle, Loader2, RefreshCw, Square, Terminal } from 'lucide-react';

import { readStoredTerminalCommandHistory } from '../adapters/terminalCommandHistoryStorage';
import { openTerminalPlatformRepository } from '../adapters/terminalWorkspaceExternalNavigation';
import {
  persistTerminalAppearanceSettings,
  persistTerminalPreference,
  readStoredTerminalAppearanceSettings,
  readStoredTerminalBooleanPreference,
  readStoredTerminalPreference,
} from '../adapters/terminalWorkspacePreferencesStorage';
import { useTerminalCommandAutocomplete } from '../hooks/useTerminalCommandAutocomplete';
import { useTerminalCommandContextMenu } from '../hooks/useTerminalCommandContextMenu';
import { useTerminalCommandHistoryPersistence } from '../hooks/useTerminalCommandHistoryPersistence';
import { useTerminalCommandRuns } from '../hooks/useTerminalCommandRuns';
import {
  normalizeTerminalAppearanceSettings,
  type TerminalAppearanceSettings,
} from '../model/terminalAppearanceSettings';
import {
  createTerminalCommandScreenLines,
  TERMINAL_COMMAND_HISTORY_LIMIT,
} from '../model/terminalCommandRuns';
import { formatTerminalPromptLabel } from '../model/terminalPathPresentation';
import { createTerminalAppearanceStyle } from '../view-models/terminalAppearanceStyle';

import { TerminalButtonTooltip } from './TerminalButtonTooltip';
import { TerminalCommandContextMenu } from './TerminalCommandContextMenu';
import { TerminalMuxTabs } from './TerminalMuxTabs';
import { TerminalWorkingDirectoryBar } from './TerminalWorkingDirectoryBar';
import { TerminalTabContentSkeleton, TerminalWorkspaceStatus } from './TerminalWorkspaceFeedback';
import {
  type TerminalWorkspaceSettingsOperations,
  TerminalWorkspaceSettingsPage,
} from './TerminalWorkspaceSettingsPage';

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

type TerminalScreenElementHandle = ComponentRef<typeof TerminalScreen> & {
  followOutput?: boolean;
  requestUpdate?: () => void;
  scrollToLatestOutput?: () => void;
};
type TerminalCommandDockElementHandle = ComponentRef<typeof TerminalCommandDock>;

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
      initialThemeId: readStoredTerminalPreference(teamName, 'theme'),
      initialTerminalFontScale: readStoredTerminalPreference(teamName, 'font-scale'),
      initialTerminalLineWrap: readStoredTerminalBooleanPreference(teamName, 'line-wrap'),
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
  const settingsOperations = useMemo<TerminalWorkspaceSettingsOperations>(
    () => ({
      reconnect: () => kernel.commands.bootstrap(),
      refreshSessions: () => kernel.commands.refreshSessions(),
      stopRuntime: () => onStopRuntime(),
      setFontScale: (fontScale) => kernel.commands.setTerminalFontScale(fontScale),
      setLineWrap: (lineWrap) => kernel.commands.setTerminalLineWrap(lineWrap),
      setTheme: (themeId) => kernel.commands.setTheme(themeId),
    }),
    [kernel.commands, onStopRuntime]
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
  const { activeCommandRuns, commandRuns } = useTerminalCommandRuns({
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
    persistTerminalPreference(teamName, 'theme', snapshot.theme.themeId);
  }, [snapshot.theme.themeId, teamName]);

  useEffect(() => {
    persistTerminalPreference(teamName, 'font-scale', terminalDisplay.fontScale);
    persistTerminalPreference(teamName, 'line-wrap', String(terminalDisplay.lineWrap));
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
      commandRuns={commandRuns}
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
          display={{
            fontScale: terminalDisplay.fontScale,
            lineWrap: terminalDisplay.lineWrap,
            themeId: snapshot.theme.themeId,
          }}
          operations={settingsOperations}
          onAppearanceSettingsChange={updateAppearanceSettings}
          onClose={() => onSettingsOpenChange?.(false)}
          onReload={onReload}
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
            <TerminalWorkingDirectoryBar
              projectPath={projectPath}
              gitBranch={gitBranch}
              onOpenTerminalPlatformRepository={openTerminalPlatformRepository}
            />
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
