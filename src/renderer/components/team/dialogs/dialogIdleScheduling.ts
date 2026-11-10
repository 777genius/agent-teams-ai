type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export interface ScheduledIdleHandle {
  kind: 'idle' | 'timeout';
  id: number;
}

export function scheduleIdle(cb: () => void): ScheduledIdleHandle {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return { kind: 'idle', id: idleWindow.requestIdleCallback(cb, { timeout: 2000 }) };
  }
  return { kind: 'timeout', id: window.setTimeout(cb, 0) };
}

function cancelScheduledIdle(handle: ScheduledIdleHandle | null): void {
  if (!handle) return;
  if (handle.kind === 'idle') {
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.cancelIdleCallback === 'function') {
      idleWindow.cancelIdleCallback(handle.id);
    }
    return;
  }
  window.clearTimeout(handle.id);
}

export function cancelScheduledIdleSet(handles: Set<ScheduledIdleHandle>): void {
  for (const handle of handles) {
    cancelScheduledIdle(handle);
  }
  handles.clear();
}
