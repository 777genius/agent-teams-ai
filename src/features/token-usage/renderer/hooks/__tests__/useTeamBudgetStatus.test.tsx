import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { useTeamBudgetStatus } from '../useTeamBudgetStatus';

import type { TokenUsageBudgetStatusDto } from '../../../contracts';

const bus = vi.hoisted(() => ({
  listener: null as ((status: TokenUsageBudgetStatusDto) => void) | null,
  resolveRead: null as ((status: TokenUsageBudgetStatusDto) => void) | null,
  rejectRead: null as ((error: Error) => void) | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    tokenUsage: {
      getBudgetStatus: () =>
        new Promise<TokenUsageBudgetStatusDto>((resolve, reject) => {
          bus.resolveRead = resolve;
          bus.rejectRead = reject;
        }),
      onBudgetStatusChanged: (listener: (status: TokenUsageBudgetStatusDto) => void) => {
        bus.listener = listener;
        return () => {
          bus.listener = null;
        };
      },
    },
  },
}));

function status(epoch: string, sequence: number): TokenUsageBudgetStatusDto {
  return {
    statusOrder: { epoch, sequence },
    period: {
      key: '2026-11',
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      timeZone: 'UTC',
    },
    computedAt: '2026-11-25T00:00:00Z',
    stale: false,
    degraded: false,
    notificationPolicy: { enabled: false, nativeToasts: false },
    options: [],
    targets: [],
  };
}

function Probe(): React.JSX.Element {
  const value = useTeamBudgetStatus();
  return (
    <output>
      {value?.statusOrder?.epoch ?? 'empty'}:{value?.statusOrder?.sequence ?? 0}
    </output>
  );
}

async function withProbe(run: (container: HTMLElement) => Promise<void>): Promise<void> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    bus.listener = null;
    bus.resolveRead = null;
    bus.rejectRead = null;
    vi.unstubAllGlobals();
  }
}

const event = async (epoch: string, sequence: number): Promise<void> => {
  await act(async () => bus.listener?.(status(epoch, sequence)));
};
const read = async (epoch: string, sequence: number): Promise<void> => {
  await act(async () => bus.resolveRead?.(status(epoch, sequence)));
};

describe('team budget event ordering', () => {
  it('retries failed reads, retains buffered events and cancels retries on unmount', async () => {
    vi.useFakeTimers();
    try {
      await withProbe(async (container) => {
        await event('current', 7);
        await act(async () => bus.rejectRead?.(new Error('temporary read failure')));
        expect(container.textContent).toBe('empty:0');
        await act(async () => vi.advanceTimersByTimeAsync(250));
        await read('current', 6);
        expect(container.textContent).toBe('current:7');
        await event('next', 1);
        await act(async () => bus.rejectRead?.(new Error('temporary read failure')));
        expect(vi.getTimerCount()).toBe(1);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a newer event from the same epoch after a late initial GET', async () => {
    await withProbe(async (container) => {
      await event('current', 7);
      await read('current', 6);
      expect(container.textContent).toBe('current:7');
      await event('current', 5);
      expect(container.textContent).toBe('current:7');
    });
  });

  it('accepts a newer authoritative GET after an earlier producer event', async () => {
    await withProbe(async (container) => {
      await event('old', 7);
      await read('new', 1);
      expect(container.textContent).toBe('new:1');
      await read('new', 2);
      expect(container.textContent).toBe('new:2');
    });
  });

  it('does not replace a current GET with a delayed older producer event', async () => {
    await withProbe(async (container) => {
      await read('new', 1);
      await event('old', 8);
      expect(container.textContent).toBe('new:1');
      await read('new', 2);
      await event('new', 3);
      expect(container.textContent).toBe('new:3');
    });
  });

  it('refreshes again when a new producer event races with an older read', async () => {
    await withProbe(async (container) => {
      await event('new', 1);
      await read('old', 9);
      await read('new', 2);
      expect(container.textContent).toBe('new:2');
    });
  });
});
