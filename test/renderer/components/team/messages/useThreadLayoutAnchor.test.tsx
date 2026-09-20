import React, { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { useThreadLayoutAnchor } from '@renderer/components/team/messages/useThreadLayoutAnchor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnchorController = ReturnType<typeof useThreadLayoutAnchor>;

function Harness({ onController }: { onController: (controller: AnchorController) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const controller = useThreadLayoutAnchor(scrollRef, 'atlas-hq:direct:alice');
  useEffect(() => {
    onController(controller);
  });
  return (
    <div ref={scrollRef} data-testid="scroll">
      <div data-timeline-row-key="message-1" data-testid="row" />
    </div>
  );
}

describe('useThreadLayoutAnchor', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    frames.clear();
    nextFrameId = 1;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const runNextFrame = async (): Promise<void> => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('expected a queued animation frame');
    frames.delete(entry[0]);
    await act(async () => entry[1](performance.now()));
  };

  it('corrects a moved row within the bounded frame budget and re-enables observation', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let controller: AnchorController | null = null;
    const getController = (): AnchorController => {
      if (!controller) throw new Error('controller was not captured');
      return controller;
    };
    let rowBaseTop = 10;

    await act(async () => {
      root.render(<Harness onController={(next) => (controller = next)} />);
    });
    const scroll = host.querySelector<HTMLElement>('[data-testid="scroll"]')!;
    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!;
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({ top: rowBaseTop - scroll.scrollTop, bottom: rowBaseTop - scroll.scrollTop + 20 }) as DOMRect;

    await act(async () => getController().beginLayoutTransition());
    expect(getController().observationEnabled).toBe(false);
    rowBaseTop = 30;

    await runNextFrame();
    expect(scroll.scrollTop).toBe(20);
    await runNextFrame();
    expect(getController().observationEnabled).toBe(true);
    expect(scroll.style.getPropertyValue('overflow-anchor')).toBe('');

    await act(async () => root.unmount());
  });

  it('cancels pending corrections on local user scroll input', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let controller: AnchorController | null = null;
    const getController = (): AnchorController => {
      if (!controller) throw new Error('controller was not captured');
      return controller;
    };

    await act(async () => {
      root.render(<Harness onController={(next) => (controller = next)} />);
    });
    const scroll = host.querySelector<HTMLElement>('[data-testid="scroll"]')!;
    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!;
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: 10, bottom: 30 }) as DOMRect;

    await act(async () => getController().beginLayoutTransition());
    expect(frames.size).toBe(1);
    await act(async () => scroll.dispatchEvent(new WheelEvent('wheel')));

    expect(getController().observationEnabled).toBe(true);
    expect(frames.size).toBe(0);
    expect(scroll.style.getPropertyValue('overflow-anchor')).toBe('');

    await act(async () => root.unmount());
  });
});
