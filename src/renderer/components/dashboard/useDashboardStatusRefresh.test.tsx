import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useDashboardStatusRefresh } from './useDashboardStatusRefresh';

it('keeps the committed callback while a concurrent render is suspended', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const refresh = vi.fn();
  const suspendedRender = vi.fn();
  const pending = new Promise<void>(() => undefined);
  const Probe = ({ update }: { update: number }) => {
    useDashboardStatusRefresh(true, () => refresh(update));
    if (update === 1) {
      suspendedRender();
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- React Suspense requires a pending thenable to suspend this render.
      throw pending;
    }
    return null;
  };
  const render = (update: number) =>
    root.render(
      <React.Suspense fallback={null}>
        <Probe update={update} />
      </React.Suspense>
    );
  try {
    await act(async () => render(0));
    await act(async () => React.startTransition(() => render(1)));
    expect(suspendedRender).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    expect(refresh).toHaveBeenCalledExactlyOnceWith(0);
    await act(async () => render(2));
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    expect(refresh).toHaveBeenLastCalledWith(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('preserves the ten-minute timer across minute-level status updates', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const refresh = vi.fn();
  const Probe = ({ update }: { update: number }) => {
    useDashboardStatusRefresh(true, () => refresh(update));
    return null;
  };
  try {
    await act(async () => root.render(<Probe update={0} />));
    expect(refresh).not.toHaveBeenCalled();
    for (let minute = 1; minute <= 10; minute++) {
      await act(async () => vi.advanceTimersByTime(60_000));
      await act(async () => root.render(<Probe update={minute} />));
    }
    expect(refresh).toHaveBeenCalledExactlyOnceWith(9);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
