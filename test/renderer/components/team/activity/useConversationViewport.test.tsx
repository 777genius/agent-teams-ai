import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type ConversationViewportHandle,
  useConversationViewport,
} from '@renderer/components/team/activity/useConversationViewport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineRow } from '@renderer/components/team/activity/timelineRows';
import type { Virtualizer } from '@tanstack/react-virtual';

describe('conversation viewport owner', () => {
  let root: Root;
  let host: HTMLDivElement;
  let scroll: HTMLDivElement;
  let content: HTMLDivElement;
  let height: number;
  let client: number;
  let resize: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let hidden: boolean;
  const handleRef: { current: ConversationViewportHandle | null } = { current: null };
  let props: Parameters<typeof useConversationViewport>[0];
  let state: ReturnType<typeof useConversationViewport>;
  const flush = () =>
    act(() => {
      for (let i = 0; i < 12; i++) {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      }
    });
  const render = () => act(() => root.render(<Probe />));
  function Probe() {
    state = useConversationViewport(props);
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    frames = new Map();
    nextFrame = 0;
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    host = document.createElement('div');
    scroll = document.createElement('div');
    content = document.createElement('div');
    document.body.append(host, scroll);
    scroll.append(content);
    root = createRoot(host);
    height = 1000;
    client = 200;
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => client },
      clientWidth: { get: () => 400 },
    });
    scroll.getBoundingClientRect = () => ({ top: 0, width: 400, height: client }) as DOMRect;
    props = {
      enabled: true,
      identity: 'team:feed:1',
      active: true,
      rows: [],
      scrollRef: { current: scroll },
      contentRef: { current: content },
      handleRef,
      virtual: false,
      virtualizer: {
        shouldAdjustScrollPositionOnItemSizeChange: undefined,
        measure: vi.fn(),
        getOffsetForIndex: vi.fn(() => [300, 'start']),
      } as unknown as Virtualizer<HTMLElement, Element>,
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
  it('places at tail before read observation and follows resize without restarting the gate', () => {
    render();
    expect(scroll.scrollTop).toBe(800);
    expect(state.observationEnabled).toBe(false);
    flush();
    expect(state.observationEnabled).toBe(true);
    height = 1300;
    act(() => resize());
    expect(scroll.scrollTop).toBe(1100);
    expect(state.observationEnabled).toBe(true);
    flush();
    expect(frames.size).toBe(0);
  });
  it('upward input cancels a pending follow before the browser scroll event', () => {
    render();
    flush();
    height = 1300;
    act(() => resize());
    act(() => scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 })));
    scroll.scrollTop = 600;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    height = 1600;
    act(() => resize());
    flush();
    expect(scroll.scrollTop).toBe(600);
    act(() => handleRef.current?.revealLatest());
    flush();
    expect(scroll.scrollTop).toBe(1400);
  });
  it.each(['before resize', 'after resize'] as const)(
    'preserves reading when browser shrink clamp emits scroll %s',
    (order) => {
      height = 1200;
      render();
      flush();
      scroll.scrollTop = 900;
      act(() => scroll.dispatchEvent(new Event('scroll')));
      height = 900;
      scroll.scrollTop = 700;
      if (order === 'after resize') {
        act(() => resize());
        flush();
      }
      act(() => scroll.dispatchEvent(new Event('scroll')));
      if (order === 'before resize') {
        act(() => resize());
        flush();
      }
      height = 1200;
      act(() => resize());
      flush();
      expect(scroll.scrollTop).toBe(700);
      // A subsequent user return to the end must still restore follow.
      scroll.scrollTop = 1000;
      act(() => scroll.dispatchEvent(new Event('scroll')));
      height = 1400;
      act(() => resize());
      flush();
      expect(scroll.scrollTop).toBe(1200);
    }
  );
  it('preserves a row offset through simultaneous head/tail geometry changes', () => {
    let top = 350;
    const row = document.createElement('div');
    row.dataset.timelineRowKey = 'anchor';
    content.append(row);
    row.getBoundingClientRect = () =>
      ({
        top: top - scroll.scrollTop,
        bottom: top - scroll.scrollTop + 300,
        height: 300,
      }) as DOMRect;
    props.rows = [{ kind: 'message-row', key: 'anchor', itemIndex: 0 } as TimelineRow];
    render();
    flush();
    scroll.scrollTop = 400;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    top += 150;
    height += 500;
    act(() => resize());
    flush();
    expect(scroll.scrollTop).toBe(550);
  });
  it('zero and hidden viewport stops frames; reveal reconciles once and stale handles are inert', () => {
    render();
    flush();
    const old = handleRef.current;
    client = 0;
    act(() => resize());
    expect(frames.size).toBe(0);
    expect(state.observationEnabled).toBe(false);
    client = 200;
    height = 1200;
    act(() => resize());
    flush();
    expect(scroll.scrollTop).toBe(1000);
    props = { ...props, identity: 'team:direct:2' };
    render();
    flush();
    scroll.scrollTop = 300;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    act(() => old?.revealLatest());
    flush();
    expect(scroll.scrollTop).toBe(300);
  });
  it('finishes initial placement once a hidden window becomes visible', () => {
    hidden = true;
    render();
    expect(scroll.scrollTop).toBe(0);
    expect(frames.size).toBe(0);
    expect(state.observationEnabled).toBe(false);

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(scroll.scrollTop).toBe(800);
    flush();
    expect(state.observationEnabled).toBe(true);
    expect(state.initialPending).toBe(false);
  });
  it('uses a bounded timer fallback when a visible Electron window suspends animation frames', async () => {
    vi.useFakeTimers();
    try {
      render();
      expect(state.observationEnabled).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(state.observationEnabled).toBe(true);
      expect(state.initialPending).toBe(false);
      expect(frames.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('restores the reading anchor after hidden geometry changes', () => {
    let top = 350;
    const row = document.createElement('div');
    row.dataset.timelineRowKey = 'anchor';
    content.append(row);
    row.getBoundingClientRect = () =>
      ({
        top: top - scroll.scrollTop,
        bottom: top - scroll.scrollTop + 300,
        height: 300,
      }) as DOMRect;
    props.rows = [{ kind: 'message-row', key: 'anchor', itemIndex: 0 } as TimelineRow];
    render();
    flush();
    scroll.scrollTop = 400;
    act(() => scroll.dispatchEvent(new Event('scroll')));

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    top += 150;
    height += 500;
    act(() => resize());
    expect(frames.size).toBe(0);
    expect(state.observationEnabled).toBe(false);

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    flush();
    expect(scroll.scrollTop).toBe(550);
    expect(state.observationEnabled).toBe(true);
  });
  it('gates the first nonempty page even after an empty state has settled', () => {
    render(); flush();
    expect(state.observationEnabled).toBe(true);
    props = { ...props, rows: [{ kind: 'message-row', key: 'first', itemIndex: 0 } as TimelineRow] };
    height = 1800; render();
    expect(state.observationEnabled).toBe(false);
    expect(state.initialPending).toBe(true);
    expect(scroll.scrollTop).toBe(1600);
    flush(); expect(state.observationEnabled).toBe(true);
  });
  it('keeps off-range seek observation closed without adding scroll margin twice', () => {
    const row = document.createElement('div'); row.dataset.timelineRowKey = 'anchor'; content.append(row);
    row.getBoundingClientRect = () => ({ top: 350 - scroll.scrollTop, bottom: 650 - scroll.scrollTop, height: 300 } as DOMRect);
    props.rows = [{ kind: 'message-row', key: 'anchor', itemIndex: 0 } as TimelineRow];
    render(); flush();
    scroll.scrollTop = 400; act(() => scroll.dispatchEvent(new Event('scroll')));
    row.remove();
    (props.virtualizer as unknown as { options: { scrollMargin: number } }).options = {
      scrollMargin: 65,
    };
    props = { ...props, virtual: true, rows: [...props.rows] }; render();
    expect(state.observationEnabled).toBe(false);
    expect(scroll.scrollTop).toBe(350);
    act(() => scroll.dispatchEvent(new Event('scroll')));
    expect(state.observationEnabled).toBe(false);
    flush(); expect(state.observationEnabled).toBe(true);
  });
});
