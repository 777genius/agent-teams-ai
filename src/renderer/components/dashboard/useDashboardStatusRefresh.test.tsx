import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useDashboardStatusRefresh } from './useDashboardStatusRefresh';

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
