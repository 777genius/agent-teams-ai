import { useCallback, useEffect, useRef, useState } from 'react';

import {
  resolveTerminalTabReorderIntent,
  type TerminalTabGeometry,
  type TerminalTabReorderIntent,
} from '../utils/terminalTabPointerReorder';

import { useTerminalTabReorderMotion } from './useTerminalTabReorderMotion';

import type {
  TerminalTabDropIndicator,
  TerminalTabPointerDrag,
} from '../model/terminalTabPreferences';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

interface TerminalTabPointerDragSession extends TerminalTabPointerDrag {
  captureElement: HTMLDivElement;
  scopeKey: string;
}

export interface UseTerminalTabPointerReorderOptions {
  activeTabId: string | null;
  canFocusTab: boolean;
  disabled: boolean;
  editingTabId: string | null;
  orderedTabIds: readonly string[];
  scopeKey: string;
  onRequestFocus: (tabId: string) => void | Promise<void>;
  onRequestReorder: (intent: TerminalTabReorderIntent) => void;
}

export interface UseTerminalTabPointerReorderResult {
  draggingTabId: string | null;
  dropIndicator: TerminalTabDropIndicator | null;
  endTabPointerDrag: (event?: ReactPointerEvent<HTMLDivElement>) => void;
  getTabDragOffsetX: (tabId: string) => number;
  handleTabClick: (event: ReactMouseEvent<HTMLButtonElement>, tabId: string) => void;
  handleTabLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleTabPointerDown: (event: ReactPointerEvent<HTMLDivElement>, tabId: string) => void;
  handleTabPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleTabPointerUp: (event: ReactPointerEvent<HTMLDivElement>, tabId: string) => void;
  registerTabElement: (tabId: string, element: HTMLDivElement | null) => void;
  tabListElementRef: RefObject<HTMLDivElement | null>;
}

export function useTerminalTabPointerReorder({
  activeTabId,
  canFocusTab,
  disabled,
  editingTabId,
  orderedTabIds,
  scopeKey,
  onRequestFocus,
  onRequestReorder,
}: UseTerminalTabPointerReorderOptions): UseTerminalTabPointerReorderResult {
  const [dragSession, setDragSession] = useState<TerminalTabPointerDragSession | null>(null);
  const [dropIndicator, setDropIndicator] = useState<TerminalTabDropIndicator | null>(null);
  const dragSessionRef = useRef<TerminalTabPointerDragSession | null>(null);
  const mountedRef = useRef(false);
  const suppressNextTabClickRef = useRef(false);
  const suppressionGenerationRef = useRef(0);
  const suppressionTimerRef = useRef<number | null>(null);
  const tabListElementRef = useRef<HTMLDivElement | null>(null);
  const tabElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const orderedTabIdsKey = orderedTabIds.join('\u001f');
  const draggingTabId = dragSession?.active ? dragSession.tabId : null;
  const { captureTabRectsBeforeReorder, clearCapturedTabRects } = useTerminalTabReorderMotion({
    draggingTabId,
    orderedTabIdsKey,
    tabElementRefs,
  });

  const clearSuppressionTimer = useCallback((): void => {
    suppressionGenerationRef.current += 1;
    if (suppressionTimerRef.current !== null) {
      window.clearTimeout(suppressionTimerRef.current);
      suppressionTimerRef.current = null;
    }
  }, []);

  const scheduleSuppressionReset = useCallback((): void => {
    clearSuppressionTimer();
    const generation = suppressionGenerationRef.current;
    suppressionTimerRef.current = window.setTimeout(() => {
      if (suppressionGenerationRef.current !== generation || dragSessionRef.current) {
        return;
      }
      suppressionTimerRef.current = null;
      suppressNextTabClickRef.current = false;
    }, 0);
  }, [clearSuppressionTimer]);

  const setDragSessionState = useCallback(
    (nextSession: TerminalTabPointerDragSession | null): void => {
      dragSessionRef.current = nextSession;
      if (mountedRef.current) {
        setDragSession(nextSession);
      }
    },
    []
  );

  const resetDragSession = useCallback(
    ({
      releaseCapture,
      resetClickSuppression,
    }: Readonly<{
      releaseCapture: boolean;
      resetClickSuppression: boolean;
    }>): void => {
      const activeSession = dragSessionRef.current;
      if (!activeSession) {
        return;
      }

      dragSessionRef.current = null;
      if (releaseCapture) {
        releasePointerCapture(activeSession);
      }
      clearCapturedTabRects();
      if (mountedRef.current) {
        setDragSession(null);
        setDropIndicator(null);
      }
      if (resetClickSuppression) {
        scheduleSuppressionReset();
      }
    },
    [clearCapturedTabRects, scheduleSuppressionReset]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSuppressionTimer();
      const activeSession = dragSessionRef.current;
      dragSessionRef.current = null;
      if (activeSession) {
        releasePointerCapture(activeSession);
      }
      clearCapturedTabRects();
    };
  }, [clearCapturedTabRects, clearSuppressionTimer]);

  useEffect(() => {
    const activeSession = dragSessionRef.current;
    if (
      activeSession &&
      (activeSession.scopeKey !== scopeKey ||
        disabled ||
        editingTabId !== null ||
        !orderedTabIds.includes(activeSession.tabId))
    ) {
      resetDragSession({ releaseCapture: true, resetClickSuppression: true });
    }
  }, [disabled, editingTabId, orderedTabIds, resetDragSession, scopeKey]);

  const registerTabElement = useCallback((tabId: string, element: HTMLDivElement | null): void => {
    if (element) {
      tabElementRefs.current.set(tabId, element);
      return;
    }
    tabElementRefs.current.delete(tabId);
  }, []);

  const endTabPointerDrag = useCallback(
    (event?: ReactPointerEvent<HTMLDivElement>): void => {
      const activeSession = dragSessionRef.current;
      if (!activeSession || (event && activeSession.pointerId !== event.pointerId)) {
        return;
      }
      if (event && activeSession.active) {
        event.preventDefault();
      }
      resetDragSession({ releaseCapture: true, resetClickSuppression: true });
    },
    [resetDragSession]
  );

  const handleTabLostPointerCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const activeSession = dragSessionRef.current;
      if (activeSession?.pointerId !== event.pointerId) {
        return;
      }
      resetDragSession({ releaseCapture: false, resetClickSuppression: true });
    },
    [resetDragSession]
  );

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tabId: string): void => {
      const target = event.target;
      if (
        dragSessionRef.current ||
        event.button !== 0 ||
        !event.isPrimary ||
        disabled ||
        editingTabId !== null ||
        !orderedTabIds.includes(tabId) ||
        (target instanceof HTMLElement && shouldIgnoreTerminalTabDragTarget(target))
      ) {
        return;
      }

      clearSuppressionTimer();
      suppressNextTabClickRef.current = false;
      const rect = event.currentTarget.getBoundingClientRect();
      const nextSession: TerminalTabPointerDragSession = {
        active: false,
        captureElement: event.currentTarget,
        grabOffsetX: event.clientX - rect.left,
        offsetX: 0,
        pointerId: event.pointerId,
        scopeKey,
        startClientX: event.clientX,
        startClientY: event.clientY,
        tabId,
      };
      setDragSessionState(nextSession);
      setDropIndicator(null);

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in some browser test environments.
      }
    },
    [clearSuppressionTimer, disabled, editingTabId, orderedTabIds, scopeKey, setDragSessionState]
  );

  const handleTabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const activeSession = dragSessionRef.current;
      if (!activeSession || activeSession.pointerId !== event.pointerId) {
        return;
      }
      if (
        activeSession.scopeKey !== scopeKey ||
        disabled ||
        editingTabId !== null ||
        !orderedTabIds.includes(activeSession.tabId)
      ) {
        resetDragSession({ releaseCapture: true, resetClickSuppression: true });
        return;
      }

      const deltaX = event.clientX - activeSession.startClientX;
      const deltaY = event.clientY - activeSession.startClientY;
      const shouldStartDrag =
        activeSession.active || (Math.abs(deltaX) >= 4 && Math.abs(deltaX) >= Math.abs(deltaY));
      if (!shouldStartDrag) {
        return;
      }

      event.preventDefault();
      suppressNextTabClickRef.current = true;
      const sourceElement = tabElementRefs.current.get(activeSession.tabId);
      const sourceRect = sourceElement?.getBoundingClientRect();
      if (!sourceElement || !sourceRect) {
        resetDragSession({ releaseCapture: true, resetClickSuppression: true });
        return;
      }

      const baseLeft = sourceRect.left - activeSession.offsetX;
      const tabListRect = tabListElementRef.current?.getBoundingClientRect();
      const unclampedLeft = event.clientX - activeSession.grabOffsetX;
      const clampedLeft = tabListRect
        ? Math.min(
            Math.max(unclampedLeft, tabListRect.left),
            Math.max(tabListRect.left, tabListRect.right - sourceRect.width)
          )
        : unclampedLeft;
      const nextSession: TerminalTabPointerDragSession = {
        ...activeSession,
        active: true,
        offsetX: clampedLeft - baseLeft,
      };
      setDragSessionState(nextSession);

      const reorderIntent = resolveTerminalTabReorderIntent({
        clientX: event.clientX,
        orderedTabIds,
        sourceTabId: activeSession.tabId,
        tabGeometries: collectTabGeometries(orderedTabIds, tabElementRefs.current),
      });
      if (!reorderIntent) {
        setDropIndicator(null);
        return;
      }

      const nextIndicator: TerminalTabDropIndicator = {
        placementMode: reorderIntent.placementMode,
        tabId: reorderIntent.targetTabId,
      };
      setDropIndicator((current) =>
        current?.tabId === nextIndicator.tabId &&
        current.placementMode === nextIndicator.placementMode
          ? current
          : nextIndicator
      );
      captureTabRectsBeforeReorder();
      onRequestReorder(reorderIntent);
    },
    [
      captureTabRectsBeforeReorder,
      disabled,
      editingTabId,
      onRequestReorder,
      orderedTabIds,
      resetDragSession,
      scopeKey,
      setDragSessionState,
    ]
  );

  const handleTabPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tabId: string): void => {
      const activeSession = dragSessionRef.current;
      if (!activeSession || activeSession.pointerId !== event.pointerId) {
        return;
      }

      const shouldFocusTab =
        activeSession.scopeKey === scopeKey &&
        activeSession.tabId === tabId &&
        orderedTabIds.includes(tabId) &&
        canFocusTab &&
        tabId !== activeTabId &&
        !disabled &&
        editingTabId === null;
      if (shouldFocusTab) {
        suppressNextTabClickRef.current = true;
        void onRequestFocus(tabId);
      }
      endTabPointerDrag(event);
    },
    [
      activeTabId,
      canFocusTab,
      disabled,
      editingTabId,
      endTabPointerDrag,
      onRequestFocus,
      orderedTabIds,
      scopeKey,
    ]
  );

  const handleTabClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, tabId: string): void => {
      const keyboardInitiated = event.detail === 0;
      if (!keyboardInitiated && suppressNextTabClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!disabled && orderedTabIds.includes(tabId)) {
        void onRequestFocus(tabId);
      }
    },
    [disabled, onRequestFocus, orderedTabIds]
  );

  const getTabDragOffsetX = useCallback(
    (tabId: string): number => (dragSession?.tabId === tabId ? dragSession.offsetX : 0),
    [dragSession]
  );

  return {
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
  };
}

function collectTabGeometries(
  orderedTabIds: readonly string[],
  tabElements: ReadonlyMap<string, HTMLDivElement>
): TerminalTabGeometry[] {
  return orderedTabIds.flatMap((tabId) => {
    const rect = tabElements.get(tabId)?.getBoundingClientRect();
    return rect ? [{ left: rect.left, tabId, width: rect.width }] : [];
  });
}

function releasePointerCapture(session: TerminalTabPointerDragSession): void {
  try {
    session.captureElement.releasePointerCapture(session.pointerId);
  } catch {
    // Capture may already be released by the browser.
  }
}

function shouldIgnoreTerminalTabDragTarget(target: HTMLElement): boolean {
  return Boolean(target.closest('[data-terminal-tab-drag-ignore="true"],input,textarea,select,a'));
}
