import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  useTerminalTabPointerReorder,
  type UseTerminalTabPointerReorderOptions,
  type UseTerminalTabPointerReorderResult,
} from '@features/terminal-workspace/renderer/hooks/useTerminalTabPointerReorder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const ORDERED_TAB_IDS = ['tab-1', 'tab-2', 'tab-3'];

describe('useTerminalTabPointerReorder', () => {
  let controls: UseTerminalTabPointerReorderResult | null;
  let host: HTMLDivElement;
  let options: UseTerminalTabPointerReorderOptions;
  let root: Root;
  let tabElements: Map<string, TestTabElement>;

  function Harness(props: UseTerminalTabPointerReorderOptions): null {
    controls = useTerminalTabPointerReorder(props);
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => createMediaQueryList())
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    controls = null;
    options = createOptions();
    tabElements = new Map([
      ['tab-1', createTabElement(0)],
      ['tab-2', createTabElement(100)],
      ['tab-3', createTabElement(200)],
    ]);
    await render();
    registerTabs();
  });

  afterEach(async () => {
    if (host.isConnected) {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('emits a narrow reorder intent, focuses the dropped tab, and suppresses its trailing click', () => {
    const source = requiredTab('tab-1');
    const down = createPointerEvent(source.element, {
      clientX: 10,
      pointerId: 1,
    });
    const move = createPointerEvent(source.element, {
      clientX: 260,
      pointerId: 1,
    });

    act(() => {
      requiredControls().handleTabPointerDown(down.event, 'tab-1');
      requiredControls().handleTabPointerMove(move.event);
    });

    expect(source.setPointerCapture).toHaveBeenCalledWith(1);
    expect(move.preventDefault).toHaveBeenCalledOnce();
    expect(requiredControls().draggingTabId).toBe('tab-1');
    expect(requiredControls().getTabDragOffsetX('tab-1')).toBe(200);
    expect(requiredControls().dropIndicator).toEqual({
      placementMode: 'after',
      tabId: 'tab-3',
    });
    expect(options.onRequestReorder).toHaveBeenCalledWith({
      placementMode: 'after',
      sourceTabId: 'tab-1',
      targetTabId: 'tab-3',
    });

    const up = createPointerEvent(source.element, {
      clientX: 260,
      pointerId: 1,
    });
    act(() => requiredControls().handleTabPointerUp(up.event, 'tab-1'));

    expect(options.onRequestFocus).toHaveBeenCalledOnce();
    expect(options.onRequestFocus).toHaveBeenCalledWith('tab-1');
    expect(source.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(requiredControls().draggingTabId).toBeNull();

    const trailingClick = createMouseEvent(1);
    act(() => requiredControls().handleTabClick(trailingClick.event, 'tab-1'));
    expect(trailingClick.preventDefault).toHaveBeenCalledOnce();
    expect(trailingClick.stopPropagation).toHaveBeenCalledOnce();
    expect(options.onRequestFocus).toHaveBeenCalledOnce();
  });

  it('keeps the first pointer as the exclusive drag owner', () => {
    const first = requiredTab('tab-1');
    const second = requiredTab('tab-2');

    act(() => {
      requiredControls().handleTabPointerDown(
        createPointerEvent(first.element, { clientX: 10, pointerId: 1 }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerDown(
        createPointerEvent(second.element, {
          clientX: 110,
          isPrimary: true,
          pointerId: 2,
        }).event,
        'tab-2'
      );
      requiredControls().handleTabPointerMove(
        createPointerEvent(second.element, { clientX: 260, pointerId: 2 }).event
      );
    });

    expect(first.setPointerCapture).toHaveBeenCalledOnce();
    expect(second.setPointerCapture).not.toHaveBeenCalled();
    expect(options.onRequestReorder).not.toHaveBeenCalled();

    act(() =>
      requiredControls().handleTabPointerMove(
        createPointerEvent(first.element, { clientX: 260, pointerId: 1 }).event
      )
    );
    expect(options.onRequestReorder).toHaveBeenCalledOnce();
  });

  it('cancels on lost pointer capture and ignores later events from that pointer', () => {
    const source = requiredTab('tab-1');
    beginActiveDrag(source, 1);
    vi.mocked(options.onRequestReorder).mockClear();

    act(() =>
      requiredControls().handleTabLostPointerCapture(
        createPointerEvent(source.element, { clientX: 260, pointerId: 1 }).event
      )
    );
    expect(requiredControls().draggingTabId).toBeNull();
    expect(source.releasePointerCapture).not.toHaveBeenCalled();

    act(() => {
      requiredControls().handleTabPointerMove(
        createPointerEvent(source.element, { clientX: 120, pointerId: 1 }).event
      );
      requiredControls().handleTabPointerUp(
        createPointerEvent(source.element, { clientX: 120, pointerId: 1 }).event,
        'tab-1'
      );
    });
    expect(options.onRequestReorder).not.toHaveBeenCalled();
    expect(options.onRequestFocus).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'session scope changes',
      patch: { scopeKey: 'team-a/session-b' },
    },
    {
      label: 'the controller becomes busy',
      patch: { disabled: true },
    },
    {
      label: 'rename mode starts',
      patch: { editingTabId: 'tab-2' },
    },
    {
      label: 'the source tab is removed',
      patch: { orderedTabIds: ['tab-2', 'tab-3'] },
    },
  ])('cancels the owned pointer when $label', async ({ patch }) => {
    const source = requiredTab('tab-1');
    beginActiveDrag(source, 1);
    vi.mocked(options.onRequestReorder).mockClear();

    await render(patch);

    expect(source.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(requiredControls().draggingTabId).toBeNull();
    act(() =>
      requiredControls().handleTabPointerMove(
        createPointerEvent(source.element, { clientX: 120, pointerId: 1 }).event
      )
    );
    expect(options.onRequestReorder).not.toHaveBeenCalled();
  });

  it('releases pointer capture without committing state after unmount', async () => {
    const source = requiredTab('tab-1');
    beginActiveDrag(source, 1);

    await act(async () => {
      root.unmount();
    });
    host.remove();

    expect(source.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('protects a newer pointer session from stale click-reset timers', () => {
    vi.useFakeTimers();
    const first = requiredTab('tab-1');
    const second = requiredTab('tab-3');

    act(() => {
      requiredControls().handleTabPointerDown(
        createPointerEvent(first.element, { clientX: 10, pointerId: 1 }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerUp(
        createPointerEvent(first.element, { clientX: 10, pointerId: 1 }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerDown(
        createPointerEvent(second.element, { clientX: 210, pointerId: 2 }).event,
        'tab-3'
      );
      vi.runOnlyPendingTimers();
      requiredControls().handleTabPointerUp(
        createPointerEvent(second.element, { clientX: 210, pointerId: 2 }).event,
        'tab-3'
      );
    });
    expect(options.onRequestFocus).toHaveBeenCalledTimes(2);

    const trailingClick = createMouseEvent(1);
    act(() => requiredControls().handleTabClick(trailingClick.event, 'tab-3'));
    expect(trailingClick.preventDefault).toHaveBeenCalledOnce();
    expect(options.onRequestFocus).toHaveBeenCalledTimes(2);
  });

  it('allows a keyboard-generated tab click while pointer click suppression is pending', () => {
    vi.useFakeTimers();
    const source = requiredTab('tab-1');
    act(() => {
      requiredControls().handleTabPointerDown(
        createPointerEvent(source.element, { clientX: 10, pointerId: 1 }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerUp(
        createPointerEvent(source.element, { clientX: 10, pointerId: 1 }).event,
        'tab-1'
      );
    });
    expect(options.onRequestFocus).toHaveBeenCalledOnce();

    const keyboardClick = createMouseEvent(0);
    act(() => requiredControls().handleTabClick(keyboardClick.event, 'tab-1'));

    expect(keyboardClick.preventDefault).not.toHaveBeenCalled();
    expect(options.onRequestFocus).toHaveBeenCalledTimes(2);
  });

  it('keeps keyboard tab navigation available while another tab is being renamed', async () => {
    await render({ editingTabId: 'tab-2' });

    const keyboardClick = createMouseEvent(0);
    act(() => requiredControls().handleTabClick(keyboardClick.event, 'tab-1'));

    expect(keyboardClick.preventDefault).not.toHaveBeenCalled();
    expect(options.onRequestFocus).toHaveBeenCalledWith('tab-1');
  });

  it('ignores close controls and vertical gestures without capturing a drag', () => {
    const source = requiredTab('tab-1');
    const closeButton = document.createElement('button');
    closeButton.dataset.terminalTabDragIgnore = 'true';
    source.element.appendChild(closeButton);

    act(() =>
      requiredControls().handleTabPointerDown(
        createPointerEvent(source.element, {
          clientX: 10,
          pointerId: 1,
          target: closeButton,
        }).event,
        'tab-1'
      )
    );
    expect(source.setPointerCapture).not.toHaveBeenCalled();

    act(() => {
      requiredControls().handleTabPointerDown(
        createPointerEvent(source.element, { clientX: 10, pointerId: 2 }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerMove(
        createPointerEvent(source.element, {
          clientX: 13,
          clientY: 30,
          pointerId: 2,
        }).event
      );
    });
    expect(requiredControls().draggingTabId).toBeNull();
    expect(options.onRequestReorder).not.toHaveBeenCalled();
  });

  async function render(patch: Partial<UseTerminalTabPointerReorderOptions> = {}): Promise<void> {
    options = { ...options, ...patch };
    await act(async () => {
      root.render(React.createElement(Harness, options));
      await Promise.resolve();
    });
  }

  function registerTabs(): void {
    const list = createTabElement(0, 280);
    act(() => {
      requiredControls().tabListElementRef.current = list.element;
      tabElements.forEach(({ element }, tabId) => {
        requiredControls().registerTabElement(tabId, element);
      });
    });
  }

  function beginActiveDrag(source: TestTabElement, pointerId: number): void {
    act(() => {
      requiredControls().handleTabPointerDown(
        createPointerEvent(source.element, { clientX: 10, pointerId }).event,
        'tab-1'
      );
      requiredControls().handleTabPointerMove(
        createPointerEvent(source.element, { clientX: 260, pointerId }).event
      );
    });
    expect(requiredControls().draggingTabId).toBe('tab-1');
  }

  function requiredControls(): UseTerminalTabPointerReorderResult {
    if (!controls) {
      throw new Error('Tab reorder controls are not mounted');
    }
    return controls;
  }

  function requiredTab(tabId: string): TestTabElement {
    const tab = tabElements.get(tabId);
    if (!tab) {
      throw new Error(`Unknown test tab: ${tabId}`);
    }
    return tab;
  }
});

function createOptions(): UseTerminalTabPointerReorderOptions {
  return {
    activeTabId: 'tab-2',
    canFocusTab: true,
    disabled: false,
    editingTabId: null,
    orderedTabIds: ORDERED_TAB_IDS,
    scopeKey: 'team-a/session-a',
    onRequestFocus: vi.fn(),
    onRequestReorder: vi.fn(),
  };
}

interface TestTabElement {
  element: HTMLDivElement;
  releasePointerCapture: ReturnType<typeof vi.fn>;
  setPointerCapture: ReturnType<typeof vi.fn>;
}

function createTabElement(left: number, width = 80): TestTabElement {
  const element = document.createElement('div');
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: vi.fn(() => createRect(left, width)),
    },
    releasePointerCapture: {
      configurable: true,
      value: releasePointerCapture,
    },
    setPointerCapture: {
      configurable: true,
      value: setPointerCapture,
    },
  });
  return { element, releasePointerCapture, setPointerCapture };
}

function createPointerEvent(
  currentTarget: HTMLDivElement,
  {
    clientX,
    clientY = 10,
    isPrimary = true,
    pointerId,
    target = currentTarget,
  }: Readonly<{
    clientX: number;
    clientY?: number;
    isPrimary?: boolean;
    pointerId: number;
    target?: EventTarget;
  }>
): {
  event: ReactPointerEvent<HTMLDivElement>;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  return {
    event: {
      button: 0,
      clientX,
      clientY,
      currentTarget,
      isPrimary,
      pointerId,
      preventDefault,
      target,
    } as unknown as ReactPointerEvent<HTMLDivElement>,
    preventDefault,
  };
}

function createMouseEvent(detail: number): {
  event: ReactMouseEvent<HTMLButtonElement>;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    event: {
      detail,
      preventDefault,
      stopPropagation,
    } as unknown as ReactMouseEvent<HTMLButtonElement>,
    preventDefault,
    stopPropagation,
  };
}

function createRect(left: number, width: number): DOMRect {
  return {
    bottom: 40,
    height: 30,
    left,
    right: left + width,
    toJSON: () => ({}),
    top: 10,
    width,
    x: left,
    y: 10,
  };
}

function createMediaQueryList(): MediaQueryList {
  return {
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  };
}
