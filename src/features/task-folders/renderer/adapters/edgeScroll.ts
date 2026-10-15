export interface EdgeScroll {
  over(y: number): void;
  stop(): void;
}

/** One RAF loop keeps scrolling even when the pointer stops producing dragover events. */
export function createEdgeScroll(container: HTMLElement): EdgeScroll {
  let pointer: number | undefined;
  let frame: number | undefined;
  let previous: number | undefined;
  const tick = (time: number): void => {
    if (pointer === undefined) return;
    const rect = container.getBoundingClientRect();
    const proximity =
      pointer < rect.top + 32
        ? -Math.min(1, Math.max(0, (rect.top + 32 - pointer) / 32))
        : pointer > rect.bottom - 32
          ? Math.min(1, Math.max(0, (pointer - rect.bottom + 32) / 32))
          : 0;
    const delta = previous === undefined ? 0 : Math.max(0, time - previous);
    previous = time;
    container.scrollTop = Math.max(
      0,
      Math.min(
        container.scrollHeight - container.clientHeight,
        container.scrollTop + (proximity * 480 * delta) / 1000
      )
    );
    frame = requestAnimationFrame(tick);
  };
  const stop = (): void => {
    pointer = undefined;
    previous = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  return {
    over(y) {
      pointer = y;
      if (frame === undefined) frame = requestAnimationFrame(tick);
    },
    stop,
  };
}

/** Capture coordinates before row handlers can stop native drag events from bubbling. */
export function observeEdgeDrag(
  container: HTMLElement,
  edge: Pick<EdgeScroll, 'over'>,
  isActive: () => boolean
): () => void {
  const track = (event: DragEvent): void => {
    if (isActive()) edge.over(event.clientY);
  };
  container.addEventListener('dragenter', track, true);
  container.addEventListener('dragover', track, true);
  return () => {
    container.removeEventListener('dragenter', track, true);
    container.removeEventListener('dragover', track, true);
  };
}
