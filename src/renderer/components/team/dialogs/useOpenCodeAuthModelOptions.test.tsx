import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePassiveOpenCodeAuthCatalogFreshness } from './useOpenCodeAuthModelOptions';

import type { TeamModelRuntimeProviderStatus } from '@renderer/utils/teamModelAvailability';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('passive OpenCode authentication catalog freshness', () => {
  it('stops hiding auth-required models when the catalog expires without another status update', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-27T10:00:00.000Z'));
    const staleAt = new Date(Date.now() + 1_000).toISOString();
    const status = {
      modelCatalog: { status: 'ready', staleAt },
    } as TeamModelRuntimeProviderStatus;
    const observed: boolean[] = [];
    const Probe = (): null => {
      observed.push(usePassiveOpenCodeAuthCatalogFreshness(status));
      return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => root.render(<Probe />));
    expect(observed.at(-1)).toBe(true);

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(observed.at(-1)).toBe(false);

    await act(async () => root.unmount());
  });
});
