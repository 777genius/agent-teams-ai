import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEdgeScroll,
  observeEdgeDrag,
} from '../../../src/features/task-folders/renderer/adapters/edgeScroll';

describe('task-folders edge scroll drag coordinates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replaces a stopped descendant dragover with its center coordinate before another RAF advance', () => {
    const container = document.createElement('div');
    const row = document.createElement('div');
    container.append(row);
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 200 } as DOMRect);

    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const runFrames = (time: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    };
    const edge = createEdgeScroll(container);
    const isActive = vi.fn(() => true);
    const stopObserving = observeEdgeDrag(container, edge, isActive);
    let descendantStoppedDragover = false;
    let dragoverReachedContainerBubble = false;
    row.addEventListener('dragover', (event) => {
      descendantStoppedDragover = true;
      event.stopPropagation();
    });
    container.addEventListener('dragover', () => {
      dragoverReachedContainerBubble = true;
    });
    const dispatch = (target: HTMLElement, type: string, clientY: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));

    dispatch(row, 'dragenter', 199);
    runFrames(0);
    runFrames(100);
    const edgeScrollTop = container.scrollTop;
    expect(edgeScrollTop).toBeGreaterThan(0);

    dispatch(row, 'dragover', 100);
    expect(descendantStoppedDragover).toBe(true);
    expect(dragoverReachedContainerBubble).toBe(false);
    runFrames(1000);
    runFrames(1100);
    expect(container.scrollTop).toBe(edgeScrollTop);

    stopObserving();
    edge.stop();
    container.scrollTop = 0;
    dispatch(row, 'dragenter', 199);
    runFrames(1200);
    runFrames(1300);
    expect(container.scrollTop).toBe(0);
    expect(isActive).toHaveBeenCalled();
  });
});
