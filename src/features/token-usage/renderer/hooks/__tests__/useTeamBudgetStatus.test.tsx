import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { useTeamBudgetStatus } from '../useTeamBudgetStatus';

import type { TokenUsageBudgetStatusDto } from '../../../contracts';

const bus = vi.hoisted(() => ({
  listener: null as ((status: TokenUsageBudgetStatusDto) => void) | null,
  resolveRead: null as ((status: TokenUsageBudgetStatusDto) => void) | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    tokenUsage: {
      getBudgetStatus: () => new Promise<TokenUsageBudgetStatusDto>((resolve) => {
        bus.resolveRead = resolve;
      }),
      onBudgetStatusChanged: (listener: (status: TokenUsageBudgetStatusDto) => void) => {
        bus.listener = listener;
        return () => { bus.listener = null; };
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
  return <output>{value?.statusOrder?.epoch ?? 'empty'}:{value?.statusOrder?.sequence ?? 0}</output>;
}

describe('team budget event ordering', () => {
  it('does not roll back the card after a late GET or retired app epoch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => bus.listener?.(status('before-restart', 7)));
      expect(container.textContent).toBe('before-restart:7');
      await act(async () => bus.listener?.(status('after-restart', 1)));
      expect(container.textContent).toBe('after-restart:1');
      await act(async () => bus.listener?.(status('before-restart', 8)));
      expect(container.textContent).toBe('after-restart:1');
      await act(async () => bus.resolveRead?.(status('before-restart', 6)));
      expect(container.textContent).toBe('after-restart:1');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      bus.listener = null;
      bus.resolveRead = null;
      vi.unstubAllGlobals();
    }
  });
});
