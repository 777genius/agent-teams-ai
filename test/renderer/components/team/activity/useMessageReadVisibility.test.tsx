import React, { act, type RefObject, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMessageReadVisibilityRequirement,
  isMessageReadIntersection,
  useMessageReadVisibility,
} from '../../../../../src/renderer/components/team/activity/useMessageReadVisibility';

class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: ReadonlyArray<number>;
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {}
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(height: number, width = 100, isIntersecting = true): void {
    const target = [...this.targets][0] ?? document.createElement('div');
    this.callback(
      [
        {
          target,
          isIntersecting,
          intersectionRect: { width, height },
        } as IntersectionObserverEntry,
      ],
      this
    );
  }
}

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  emit(): void {
    this.callback([], this);
  }
}

function VisibilityHarness({
  enabled,
  visibilityKey,
  onVisible,
  observerRoot,
  rowHeight,
}: {
  enabled: boolean;
  visibilityKey: string;
  onVisible: () => void;
  observerRoot: RefObject<HTMLElement | null>;
  rowHeight: number;
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  useMessageReadVisibility({
    targetRef: rowRef,
    observerRoot,
    observationEnabled: enabled,
    visibilityKey,
    onVisible,
  });
  return <div ref={rowRef} data-test-height={rowHeight} />;
}

describe('useMessageReadVisibility', () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    FakeIntersectionObserver.instances = [];
    FakeResizeObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    visibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const height = Number(this.dataset.testHeight ?? 800);
      const top = Number(this.dataset.testTop ?? 0);
      return {
        x: 0,
        y: top,
        width: 100,
        height,
        top,
        right: 100,
        bottom: top + height,
        left: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('caps the required fraction for tall rows and rejects a thin visible edge', () => {
    const normal = getMessageReadVisibilityRequirement({
      rowHeight: 100,
      outerViewportHeight: 600,
      innerClipHeight: 200,
    });
    const tall = getMessageReadVisibilityRequirement({
      rowHeight: 2_000,
      outerViewportHeight: 600,
      innerClipHeight: 200,
    });

    expect(normal).toMatchObject({ requiredHeight: 15, requiredRatio: 0.15 });
    expect(tall).toMatchObject({ availableHeight: 200, requiredHeight: 30 });
    expect(tall?.requiredRatio).toBeCloseTo(0.015);
    expect(
      isMessageReadIntersection(
        { isIntersecting: true, intersectionRect: { width: 100, height: 29.49 } as DOMRectReadOnly },
        tall
      )
    ).toBe(false);
    expect(
      isMessageReadIntersection(
        { isIntersecting: true, intersectionRect: { width: 100, height: 29.5 } as DOMRectReadOnly },
        tall
      )
    ).toBe(true);
    expect(
      isMessageReadIntersection(
        { isIntersecting: true, intersectionRect: { width: 0, height: 30 } as DOMRectReadOnly },
        tall
      )
    ).toBe(false);
  });

  it('rebuilds its threshold after resize and ignores the stale observer callback', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const viewport = document.createElement('div');
    viewport.dataset.testHeight = '600';
    document.body.appendChild(viewport);
    const root = createRoot(host);
    const onVisible = vi.fn();

    await act(async () => {
      root.render(
        <VisibilityHarness
          enabled
          visibilityKey="message-1"
          onVisible={onVisible}
          observerRoot={{ current: viewport }}
          rowHeight={2_000}
        />
      );
    });

    const firstObserver = FakeIntersectionObserver.instances.at(-1)!;
    expect(firstObserver.thresholds).toEqual([0, 0.045]);

    viewport.dataset.testHeight = '200';
    act(() => FakeResizeObserver.instances.at(-1)?.emit());
    const resizedObserver = FakeIntersectionObserver.instances.at(-1)!;
    expect(resizedObserver).not.toBe(firstObserver);
    expect(resizedObserver.thresholds).toEqual([0, 0.015]);

    act(() => firstObserver.emit(90));
    expect(onVisible).not.toHaveBeenCalled();
    act(() => resizedObserver.emit(29.5));
    expect(onVisible).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('pauses for the gate and hidden document, then reconnects without accepting stale callbacks', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const viewport = document.createElement('div');
    viewport.dataset.testHeight = '400';
    document.body.appendChild(viewport);
    const observerRoot = { current: viewport };
    const root = createRoot(host);
    const onVisible = vi.fn();

    await act(async () => {
      root.render(
        <VisibilityHarness
          enabled={false}
          visibilityKey="message-1"
          onVisible={onVisible}
          observerRoot={observerRoot}
          rowHeight={100}
        />
      );
    });
    expect(FakeIntersectionObserver.instances).toHaveLength(0);

    await act(async () => {
      root.render(
        <VisibilityHarness
          enabled
          visibilityKey="message-1"
          onVisible={onVisible}
          observerRoot={observerRoot}
          rowHeight={100}
        />
      );
    });
    const beforeHide = FakeIntersectionObserver.instances.at(-1)!;

    visibilityState = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => beforeHide.emit(100));
    expect(onVisible).not.toHaveBeenCalled();

    visibilityState = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const afterShow = FakeIntersectionObserver.instances.at(-1)!;
    expect(afterShow).not.toBe(beforeHide);
    act(() => afterShow.emit(100));
    expect(onVisible).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('does not read behind the overlapping footer and reads after scrolling above it', async () => {
    const layout = document.createElement('div');
    layout.dataset.messagesThreadLayout = 'wide';
    const viewport = document.createElement('div');
    viewport.dataset.testHeight = '400';
    const footer = document.createElement('div');
    footer.dataset.messagesThreadFooter = 'true';
    footer.dataset.testTop = '300';
    footer.dataset.testHeight = '100';
    layout.append(viewport, footer);
    document.body.append(layout);
    const host = document.createElement('div');
    viewport.append(host);
    const root = createRoot(host);
    const onVisible = vi.fn();

    await act(async () => {
      root.render(
        <VisibilityHarness
          enabled
          visibilityKey="covered-message"
          onVisible={onVisible}
          observerRoot={{ current: viewport }}
          rowHeight={100}
        />
      );
    });
    const row = host.firstElementChild as HTMLElement;
    row.dataset.testTop = '350';
    act(() => FakeIntersectionObserver.instances.at(-1)?.emit(100));
    expect(onVisible).not.toHaveBeenCalled();

    row.dataset.testTop = '200';
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(onVisible).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
