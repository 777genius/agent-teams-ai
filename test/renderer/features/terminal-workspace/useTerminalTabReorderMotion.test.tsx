import React, { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTerminalTabReorderMotion } from '@features/terminal-workspace/renderer/hooks/useTerminalTabReorderMotion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReorderMotionControls = ReturnType<typeof useTerminalTabReorderMotion>;
interface ReorderMotionHarnessProps {
  draggingTabId: string | null;
  orderedTabIdsKey: string;
  tabElementRefs: RefObject<Map<string, HTMLDivElement>>;
}

describe('useTerminalTabReorderMotion', () => {
  let host: HTMLDivElement;
  let root: Root;
  let controls: ReorderMotionControls | null;

  function Harness(props: ReorderMotionHarnessProps): null {
    controls = useTerminalTabReorderMotion(props);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => createMediaQueryList(false))
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    controls = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('animates moved tabs from their captured positions and cancels stale animations', async () => {
    const first = createTabElement(10);
    const second = createTabElement(110);
    const staleAnimation = { cancel: vi.fn() } as unknown as Animation;
    const getAnimations = vi.fn(() => [staleAnimation]);
    const animate = vi.fn();
    Object.defineProperties(second.element, {
      animate: { configurable: true, value: animate },
      getAnimations: { configurable: true, value: getAnimations },
    });
    const tabElementRefs = createTabElementRefs(first.element, second.element);

    await renderHarness({
      draggingTabId: 'tab-1',
      orderedTabIdsKey: 'tab-1 tab-2',
      tabElementRefs,
    });
    act(() => controls?.captureTabRectsBeforeReorder());

    first.setLeft(110);
    second.setLeft(10);
    await renderHarness({
      draggingTabId: 'tab-1',
      orderedTabIdsKey: 'tab-2 tab-1',
      tabElementRefs,
    });

    expect(first.animate).not.toHaveBeenCalled();
    expect(staleAnimation.cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate(100px, 0px)' }, { transform: 'translate(0, 0)' }],
      {
        duration: 180,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }
    );
  });

  it('does not capture or animate tab positions when reduced motion is preferred', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => createMediaQueryList(true))
    );
    const first = createTabElement(10);
    const second = createTabElement(110);
    const tabElementRefs = createTabElementRefs(first.element, second.element);

    await renderHarness({ draggingTabId: null, orderedTabIdsKey: 'tab-1 tab-2', tabElementRefs });
    act(() => controls?.captureTabRectsBeforeReorder());
    second.setLeft(10);
    await renderHarness({ draggingTabId: null, orderedTabIdsKey: 'tab-2 tab-1', tabElementRefs });

    expect(first.getBoundingClientRect).not.toHaveBeenCalled();
    expect(second.getBoundingClientRect).not.toHaveBeenCalled();
    expect(first.animate).not.toHaveBeenCalled();
    expect(second.animate).not.toHaveBeenCalled();
  });

  it('skips moved elements without the Web Animations API', async () => {
    const first = createTabElement(10);
    const second = createTabElement(110);
    Object.defineProperty(second.element, 'animate', {
      configurable: true,
      value: undefined,
    });
    const tabElementRefs = createTabElementRefs(first.element, second.element);

    await renderHarness({ draggingTabId: null, orderedTabIdsKey: 'tab-1 tab-2', tabElementRefs });
    act(() => controls?.captureTabRectsBeforeReorder());
    second.setLeft(10);

    await expect(
      renderHarness({ draggingTabId: null, orderedTabIdsKey: 'tab-2 tab-1', tabElementRefs })
    ).resolves.toBeUndefined();
    expect(first.animate).not.toHaveBeenCalled();
  });

  async function renderHarness({
    draggingTabId,
    orderedTabIdsKey,
    tabElementRefs,
  }: ReorderMotionHarnessProps): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(Harness, { draggingTabId, orderedTabIdsKey, tabElementRefs })
      );
      await Promise.resolve();
    });
  }
});

function createTabElement(initialLeft: number): {
  animate: ReturnType<typeof vi.fn>;
  element: HTMLDivElement;
  getBoundingClientRect: ReturnType<typeof vi.fn>;
  setLeft: (left: number) => void;
} {
  let left = initialLeft;
  const element = document.createElement('div');
  const animate = vi.fn();
  const getBoundingClientRect = vi.fn(() => createRect(left));
  Object.defineProperties(element, {
    animate: { configurable: true, value: animate },
    getBoundingClientRect: { configurable: true, value: getBoundingClientRect },
  });

  return {
    animate,
    element,
    getBoundingClientRect,
    setLeft: (nextLeft: number) => {
      left = nextLeft;
    },
  };
}

function createTabElementRefs(
  first: HTMLDivElement,
  second: HTMLDivElement
): RefObject<Map<string, HTMLDivElement>> {
  return {
    current: new Map([
      ['tab-1', first],
      ['tab-2', second],
    ]),
  };
}

function createRect(left: number): DOMRect {
  return {
    bottom: 40,
    height: 30,
    left,
    right: left + 80,
    toJSON: () => ({}),
    top: 10,
    width: 80,
    x: left,
    y: 10,
  };
}

function createMediaQueryList(matches: boolean): MediaQueryList {
  return {
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  };
}
