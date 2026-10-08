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
import {
  TerminalCommandDock,
  TerminalScreen,
  TerminalWorkspace,
  useWorkspaceSnapshot,
} from '@terminal-platform/workspace-react';

import {
  copyTextToClipboard,
  resolveTerminalCommandContextMenuState,
  type TerminalCommandContextMenuState,
} from '../adapters/terminalCommandContextMenu';
import {
  persistTerminalCommandHistory as persistCommandHistory,
  readStoredTerminalCommandHistory as readStoredCommandHistory,
} from '../adapters/terminalCommandHistoryStorage';
import { normalizeTerminalCommandRunEventDetail } from '../adapters/terminalCommandRunEvents';
import {
  persistTerminalCommandRuns,
  readStoredTerminalCommandRuns,
} from '../adapters/terminalCommandRunsStorage';
import { TerminalWorkingDirectoryBar } from '../adapters/TerminalWorkingDirectoryBar';
import {
  persistTerminalAppearanceSettings,
  persistTerminalPreference,
  readStoredTerminalAppearanceSettings,
} from '../adapters/terminalWorkspacePreferencesStorage';
import {
  normalizeTerminalAppearanceSettings,
  type TerminalAppearanceSettings,
} from '../model/terminalAppearanceSettings';
import {
  createTerminalLocalAutocompleteCandidates,
  isTerminalLocalAutocompleteDraftEligible,
  resolveTerminalLocalAutocompleteSuggestion,
} from '../model/terminalCommandAutocomplete';
import {
  closeSupersededTerminalCommandRuns,
  createTerminalCommandScreenLines,
  settleScopedTerminalCommandRuns,
  type TerminalCommandRunPresentation,
  type TerminalCommandScreenLine,
  upsertTerminalCommandRun,
} from '../model/terminalCommandRuns';
import { formatTerminalPromptLabel } from '../model/terminalPathPresentation';
import { isRecord } from '../utils/valueGuards';
import { createTerminalAppearanceStyle } from '../view-models/terminalAppearanceStyle';

import { TerminalCommandContextMenu } from './TerminalCommandContextMenu';
import { TerminalMuxTabs } from './TerminalMuxTabs';
import { TerminalTabContentSkeleton } from './TerminalTabContentSkeleton';
import { TERMINAL_WORKSPACE_CONSOLE_CSS } from './terminalWorkspaceConsoleCss';
import {
  type TerminalWorkspaceSettingsOperations,
  TerminalWorkspaceSettingsPage,
} from './TerminalWorkspaceSettingsPage';

import type { WorkspaceKernel } from '@terminal-platform/workspace-core';

const TERMINAL_LOCAL_AUTOCOMPLETE_THROTTLE_MS = 75;

type TerminalScreenElementHandle = ComponentRef<typeof TerminalScreen> & {
  followOutput?: boolean;
  requestUpdate?: () => void;
  scrollToLatestOutput?: () => void;
};

type TerminalCommandDockElementHandle = ComponentRef<typeof TerminalCommandDock>;

export const TerminalWorkspaceKernelView = ({
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
    persistTerminalPreference(teamName, 'theme', snapshot.theme.themeId);
  }, [snapshot.theme.themeId, teamName]);

  useEffect(() => {
    persistTerminalPreference(teamName, 'font-scale', terminalDisplay.fontScale);
    persistTerminalPreference(teamName, 'line-wrap', String(terminalDisplay.lineWrap));
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
      <style>{TERMINAL_WORKSPACE_CONSOLE_CSS}</style>
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
