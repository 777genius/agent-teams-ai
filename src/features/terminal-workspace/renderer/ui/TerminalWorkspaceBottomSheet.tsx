import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Sheet, type SheetContext } from 'react-modal-sheet';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { HEADER_ROW1_HEIGHT } from '@renderer/constants/layout';
import { PanelBottomClose, PanelBottomOpen, Settings2, Terminal, X } from 'lucide-react';
import { useDragControls } from 'motion/react';

import { TerminalWorkspacePanel } from './TerminalWorkspacePanel';

import type {
  TerminalWorkspaceBootstrap,
  TerminalWorkspaceBootstrapRequest,
} from '../../contracts';

export interface TerminalWorkspaceBottomSheetProps {
  open: boolean;
  mountPoint: HTMLElement | null;
  teamName: string;
  teamDisplayName?: string | null;
  projectPath?: string | null;
  gitBranch?: string | null;
  isTeamAlive?: boolean;
  onOpenChange: (open: boolean) => void;
  getBootstrap: (request: TerminalWorkspaceBootstrapRequest) => Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime: (teamName: string) => Promise<void>;
}

const TERMINAL_SHEET_HEADER_HEIGHT = 44;
const TERMINAL_SHEET_COLLAPSED_SNAP_INDEX = 1;
const TERMINAL_SHEET_PREVIEW_SNAP_INDEX = 2;
const TERMINAL_SHEET_EXPANDED_SNAP_INDEX = 3;
const TERMINAL_SHEET_FULL_SNAP_INDEX = 4;
const TERMINAL_SHEET_OPEN_SNAP_INDEX = TERMINAL_SHEET_PREVIEW_SNAP_INDEX;

interface TerminalSheetControllerBridgeProps {
  active: boolean;
  contentFrameRef: RefObject<HTMLDivElement | null>;
  mountHeight: number;
  sheetApiRef: RefObject<SheetContext | null>;
  snapPoints: number[];
  teamName: string;
  onSnapIndexChange: (snapIndex: number) => void;
}

const TerminalSheetControllerBridge = ({
  active,
  contentFrameRef,
  mountHeight,
  sheetApiRef,
  snapPoints,
  teamName,
  onSnapIndexChange,
}: TerminalSheetControllerBridgeProps): null => {
  const sheet = Sheet.useContext();

  useEffect(() => {
    sheetApiRef.current = sheet;
    return () => {
      if (sheetApiRef.current === sheet) {
        sheetApiRef.current = null;
      }
    };
  }, [sheet, sheetApiRef]);

  useEffect(() => {
    const syncContentHeight = (y: number): void => {
      if (!contentFrameRef.current) {
        return;
      }
      contentFrameRef.current.style.height = `${Math.max(
        mountHeight - y - TERMINAL_SHEET_HEADER_HEIGHT,
        0
      )}px`;
    };

    syncContentHeight(sheet.y.get());
    return sheet.y.on('change', syncContentHeight);
  }, [contentFrameRef, mountHeight, sheet]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const forceOpen = (): void => {
      onSnapIndexChange(TERMINAL_SHEET_OPEN_SNAP_INDEX);
      sheet.snapTo(TERMINAL_SHEET_OPEN_SNAP_INDEX);
      syncSheetYToSnap(sheet, TERMINAL_SHEET_OPEN_SNAP_INDEX, snapPoints, mountHeight);
    };
    const frame = window.requestAnimationFrame(forceOpen);
    const timers = [50, 150, 320, 700, 1200, 1800].map((delay) =>
      window.setTimeout(forceOpen, delay)
    );

    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [active, mountHeight, onSnapIndexChange, sheet, snapPoints, teamName]);

  return null;
};

function resolveSnapPointHeight(snapPoint: number | undefined, mountHeight: number): number {
  const fallbackHeight = mountHeight > 0 ? mountHeight : 760;
  if (typeof snapPoint !== 'number') {
    return fallbackHeight;
  }
  if (snapPoint > 0 && snapPoint <= 1) {
    return Math.round(snapPoint * fallbackHeight);
  }
  if (snapPoint < 0) {
    return Math.max(fallbackHeight + snapPoint, 0);
  }
  return snapPoint;
}

function resolveSheetYForSnap(
  snapIndex: number,
  snapPoints: number[],
  mountHeight: number
): number {
  const sheetHeight = mountHeight > 0 ? mountHeight : 760;
  const snapHeight = Math.min(
    resolveSnapPointHeight(snapPoints[snapIndex], sheetHeight),
    sheetHeight
  );
  return Math.max(sheetHeight - snapHeight, 0);
}

function syncSheetYToSnap(
  sheet: SheetContext,
  snapIndex: number,
  snapPoints: number[],
  mountHeight: number
): void {
  const y = resolveSheetYForSnap(snapIndex, snapPoints, mountHeight);
  sheet.y.set(y);
  window.requestAnimationFrame(() => sheet.y.set(y));
}

export const TerminalWorkspaceBottomSheet = ({
  open,
  mountPoint,
  teamName,
  teamDisplayName,
  projectPath,
  gitBranch,
  isTeamAlive,
  onOpenChange,
  getBootstrap,
  stopTeamRuntime,
}: TerminalWorkspaceBottomSheetProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const sheetApiRef = useRef<SheetContext | null>(null);
  const terminalContentFrameRef = useRef<HTMLDivElement | null>(null);
  const terminalSheetDragControls = useDragControls();
  const [mountHeight, setMountHeight] = useState(0);
  const [snapIndex, setSnapIndex] = useState(TERMINAL_SHEET_OPEN_SNAP_INDEX);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [headerTabsElement, setHeaderTabsElement] = useState<HTMLDivElement | null>(null);
  const [forceOpenSnapActive, setForceOpenSnapActive] = useState(false);

  useEffect(() => {
    if (!open) {
      setForceOpenSnapActive(false);
      return undefined;
    }

    setSnapIndex(TERMINAL_SHEET_OPEN_SNAP_INDEX);
    setForceOpenSnapActive(true);
    const timer = window.setTimeout(() => setForceOpenSnapActive(false), 2200);

    return () => window.clearTimeout(timer);
  }, [open, teamName]);

  useEffect(() => {
    if (!open || !mountPoint) {
      return undefined;
    }

    const updateHeight = (): void => {
      const viewportHeight = window.innerHeight || mountPoint.getBoundingClientRect().height;
      const availableHeight = Math.max(
        Math.ceil(viewportHeight) - HEADER_ROW1_HEIGHT,
        TERMINAL_SHEET_HEADER_HEIGHT
      );
      setMountHeight(availableHeight);
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', updateHeight);
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(mountPoint);

    return () => {
      window.removeEventListener('resize', updateHeight);
      observer.disconnect();
    };
  }, [mountPoint, open]);

  const snapPoints = useMemo(() => {
    const maxOpenHeight =
      mountHeight > 0 ? Math.max(mountHeight - 1, TERMINAL_SHEET_HEADER_HEIGHT) : 760;
    const collapsedHeight = Math.min(TERMINAL_SHEET_HEADER_HEIGHT, maxOpenHeight);
    const previewHeight = Math.min(Math.max(Math.round(maxOpenHeight * 0.5), 320), maxOpenHeight);
    const expandedHeight = Math.min(
      Math.max(Math.round(maxOpenHeight * 0.82), previewHeight),
      maxOpenHeight
    );

    return [0, collapsedHeight, previewHeight, expandedHeight, 1];
  }, [mountHeight]);

  const normalizedSnapIndex = Math.min(
    Math.max(snapIndex, TERMINAL_SHEET_COLLAPSED_SNAP_INDEX),
    TERMINAL_SHEET_FULL_SNAP_INDEX
  );
  const collapsed = normalizedSnapIndex === TERMINAL_SHEET_COLLAPSED_SNAP_INDEX;
  const expanded = normalizedSnapIndex >= TERMINAL_SHEET_EXPANDED_SNAP_INDEX;
  const activeSheetHeight = useMemo(() => {
    const snapPoint =
      snapPoints[normalizedSnapIndex] ?? snapPoints[TERMINAL_SHEET_PREVIEW_SNAP_INDEX];
    if (snapPoint === 1) {
      return mountHeight > 0 ? mountHeight : 760;
    }
    return snapPoint;
  }, [mountHeight, normalizedSnapIndex, snapPoints]);
  const activeContentHeight = collapsed
    ? 0
    : Math.max(activeSheetHeight - TERMINAL_SHEET_HEADER_HEIGHT, 0);
  const snapTo = useCallback(
    (nextIndex: number): void => {
      setSnapIndex(nextIndex);
      const sheet = sheetApiRef.current;
      if (!sheet) {
        return;
      }
      sheet.snapTo(nextIndex);
      syncSheetYToSnap(sheet, nextIndex, snapPoints, mountHeight);
    },
    [mountHeight, snapPoints]
  );

  const forceOpenSnap = useCallback((): void => {
    snapTo(TERMINAL_SHEET_OPEN_SNAP_INDEX);
  }, [snapTo]);

  const handleOpenEnd = useCallback((): void => {
    forceOpenSnap();
  }, [forceOpenSnap]);

  useEffect(() => {
    if (!open || !mountPoint || !forceOpenSnapActive) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(forceOpenSnap);
    const timers = [50, 150, 320, 700, 1200, 1800].map((delay) =>
      window.setTimeout(forceOpenSnap, delay)
    );

    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [forceOpenSnap, forceOpenSnapActive, mountHeight, mountPoint, open, teamName]);

  const toggleExpanded = useCallback((): void => {
    snapTo(expanded ? TERMINAL_SHEET_PREVIEW_SNAP_INDEX : TERMINAL_SHEET_FULL_SNAP_INDEX);
  }, [expanded, snapTo]);
  const expansionActionLabel = expanded
    ? t('terminalWorkspace.restoreHalfHeightSheet')
    : t('terminalWorkspace.expandTerminalSheet');
  const settingsActionLabel = settingsOpen
    ? t('terminalWorkspace.closeTerminalSettings')
    : t('terminalWorkspace.openTerminalSettings');
  const closeSheetLabel = t('terminalWorkspace.closeTerminalSheet');
  const handleDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || mountHeight <= 0) {
        return;
      }
      setForceOpenSnapActive(false);
      terminalSheetDragControls.start(event);
    },
    [mountHeight, terminalSheetDragControls]
  );

  if (!open || !mountPoint) {
    return null;
  }

  return (
    <Sheet
      isOpen
      mountPoint={mountPoint}
      avoidKeyboard={false}
      detent="full"
      snapPoints={snapPoints}
      initialSnap={normalizedSnapIndex}
      onClose={() => onOpenChange(false)}
      onSnap={setSnapIndex}
      onOpenEnd={handleOpenEnd}
      disableDismiss
      disableScrollLocking
      data-terminal-sheet-snap={normalizedSnapIndex}
      data-terminal-sheet-settling={forceOpenSnapActive ? 'true' : 'false'}
      style={
        {
          zIndex: 34,
          top: HEADER_ROW1_HEIGHT,
          right: 0,
          bottom: 0,
          left: 0,
          width: '100%',
          height: `calc(100% - ${HEADER_ROW1_HEIGHT}px)`,
        } as CSSProperties
      }
      className="agent-team-terminal-sheet-root !pointer-events-none"
      unstyled
    >
      <style>
        {`
          .agent-team-terminal-sheet-root[data-sheet-state="open"] {
            visibility: visible !important;
          }

          .agent-team-terminal-sheet-root > .react-modal-sheet-container {
            width: 100% !important;
            max-width: none !important;
          }
        `}
      </style>
      <TerminalSheetControllerBridge
        active={open && forceOpenSnapActive}
        contentFrameRef={terminalContentFrameRef}
        mountHeight={mountHeight}
        onSnapIndexChange={setSnapIndex}
        sheetApiRef={sheetApiRef}
        snapPoints={snapPoints}
        teamName={teamName}
      />
      <Sheet.Container
        unstyled
        className="pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-none border-0 border-t border-white/[0.06] bg-[rgba(5,8,13,0.36)] shadow-none backdrop-blur-[30px]"
        style={{ height: mountHeight > 0 ? mountHeight : undefined }}
        data-testid="terminal-workspace-bottom-sheet"
      >
        <Sheet.Header
          unstyled
          dragControls={terminalSheetDragControls}
          dragListener={false}
          className="shrink-0 cursor-grab select-none border-b border-white/[0.07] bg-transparent active:cursor-grabbing"
        >
          <div className="relative h-11 px-3">
            <div
              className="absolute inset-x-0 top-0 z-[2] flex h-5 cursor-grab touch-none items-start justify-center pt-1 active:cursor-grabbing"
              data-testid="terminal-workspace-sheet-drag-handle"
              onPointerDown={handleDragPointerDown}
            >
              <Sheet.DragIndicator className="!h-1 !w-11 !rounded-full !bg-slate-500/55" />
            </div>
            <div className="flex h-full items-end gap-2 pt-4">
              <span
                className="mb-2 flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-slate-300"
                title={teamDisplayName || teamName}
              >
                <Terminal size={14} />
              </span>
              <span
                className={[
                  'mb-5 size-1.5 shrink-0 rounded-full',
                  isTeamAlive ? 'bg-emerald-400' : 'bg-sky-400',
                ].join(' ')}
                title={
                  isTeamAlive
                    ? t('terminalWorkspace.teamRuntime')
                    : t('terminalWorkspace.localShell')
                }
              />

              <div
                ref={setHeaderTabsElement}
                className="flex min-w-0 flex-1 translate-y-px self-end"
              />
              <div
                className="mb-2 flex shrink-0 items-center gap-1"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={[
                        'size-7 p-0 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]',
                        settingsOpen
                          ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                          : '',
                      ].join(' ')}
                      aria-label={settingsActionLabel}
                      aria-pressed={settingsOpen}
                      onClick={() => setSettingsOpen((value) => !value)}
                    >
                      <Settings2 size={15} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{settingsActionLabel}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                      aria-label={expansionActionLabel}
                      onClick={toggleExpanded}
                    >
                      {expanded ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{expansionActionLabel}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                      aria-label={closeSheetLabel}
                      onClick={() => onOpenChange(false)}
                    >
                      <X size={15} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{closeSheetLabel}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </Sheet.Header>

        {!collapsed && (
          <Sheet.Content
            className="flex min-h-0 flex-1 overflow-hidden bg-transparent"
            scrollClassName="flex h-full min-h-0 flex-col overflow-hidden"
            disableDrag
            disableScroll
          >
            <div
              ref={terminalContentFrameRef}
              className="flex min-h-0 shrink-0 flex-col p-0"
              data-testid="terminal-workspace-sheet-content-frame"
              style={{ height: activeContentHeight }}
            >
              <TerminalWorkspacePanel
                teamName={teamName}
                teamDisplayName={teamDisplayName}
                projectPath={projectPath}
                gitBranch={gitBranch}
                isTeamAlive={isTeamAlive}
                surface="sheet"
                settingsOpen={settingsOpen}
                onSettingsOpenChange={setSettingsOpen}
                terminalHeightClassName="h-full min-h-0 flex-1"
                tabsPortalElement={headerTabsElement}
                getBootstrap={getBootstrap}
                stopTeamRuntime={stopTeamRuntime}
              />
            </div>
          </Sheet.Content>
        )}
      </Sheet.Container>
    </Sheet>
  );
};
