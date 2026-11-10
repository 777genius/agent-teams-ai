import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScopeWarningBanner } from '@renderer/components/team/review/ScopeWarningBanner';

import type { TaskScopeConfidence } from '@shared/types';

describe('ScopeWarningBanner', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function renderBanner(params: {
    confidence: TaskScopeConfidence;
    sourceKind?: 'ledger' | 'legacy';
    warnings?: string[];
  }): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ScopeWarningBanner, {
          warnings: params.warnings ?? [],
          confidence: params.confidence,
          sourceKind: params.sourceKind,
        })
      );
      await Promise.resolve();
    });

    return {
      host,
      cleanup: async () => {
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
      },
    };
  }

  it('uses ledger wording instead of legacy boundary wording for ledger changes', async () => {
    const { host, cleanup } = await renderBanner({
      sourceKind: 'ledger',
      confidence: {
        tier: 2,
        label: 'medium',
        reason: 'Snapshot event with metadata-only reviewability',
      },
    });

    expect(host.textContent).toContain('Changes captured with limited reviewability');
    expect(host.textContent).toContain('Mixed reviewability');
    expect(host.textContent).not.toContain('End boundary estimated');
    expect(host.textContent).not.toContain('Start boundary estimated');

    await cleanup();
  });

  it('uses work-interval wording for legacy interval-scoped task changes', async () => {
    const { host, cleanup } = await renderBanner({
      sourceKind: 'legacy',
      confidence: {
        tier: 2,
        label: 'medium',
        reason: 'Scoped by persisted task workIntervals (timestamp-based)',
      },
      warnings: ['Task start boundary missing - scoped by persisted workIntervals timestamps.'],
    });

    expect(host.textContent).toContain('Scoped by persisted work interval');
    expect(host.textContent).toContain('Interval scoped');
    expect(host.textContent).not.toContain('End boundary estimated');

    await cleanup();
  });
});
