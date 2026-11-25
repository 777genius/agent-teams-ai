import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamBudgetProgress } from '../TeamBudgetProgress';

import type { TokenUsageBudgetStatusDto } from '../../../contracts';
import type { Root } from 'react-dom/client';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const status = (input?: { stale?: boolean; value?: number; policy?: 'notify' | 'block_launch' | 'stop_team' }): TokenUsageBudgetStatusDto => ({
  period: { key: '2026-11', from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', timeZone: 'UTC' },
  computedAt: '2026-11-25T00:00:00Z',
  stale: input?.stale ?? false,
  degraded: false,
  notificationPolicy: { enabled: true, nativeToasts: false },
  options: [],
  targets: [{
    scope: 'team', id: 'team:alpha', label: 'alpha', thresholds: [80, 100],
    notificationsEnabled: true, onExceeded: input?.policy,
    metrics: [{
      metric: 'apiEquivalentCostUsd',
      value: input?.value ?? 18,
      limit: 20,
      percent: ((input?.value ?? 18) / 20) * 100,
      remaining: 2,
      incomplete: false,
    }],
  }],
});

describe('team budget card', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it('shows a budget on its own team but not on unrelated cards', async () => {
    await act(async () => root.render(<TeamBudgetProgress teamName="alpha" status={status()} />));
    expect(container.textContent).toContain('$18.00 / $20.00');
    await act(async () => root.render(<TeamBudgetProgress teamName="beta" status={status()} />));
    expect(container.textContent).toBe('');
  });
  it('distinguishes a stop policy from an uncertain stale status', async () => {
    await act(async () => root.render(<TeamBudgetProgress teamName="alpha" status={status({ policy: 'stop_team', value: 22 })} />));
    expect(container.textContent).toContain('teamCardBlocked');
    await act(async () => root.render(<TeamBudgetProgress teamName="alpha" status={status({ policy: 'stop_team', value: 22, stale: true })} />));
    expect(container.textContent).toContain('teamCardUnknown');
    expect(container.querySelector('.bg-emerald-500\\/70')).toBeNull();
  });
});
