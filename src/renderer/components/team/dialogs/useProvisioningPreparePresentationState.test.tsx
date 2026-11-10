import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProvisioningPreparePresentationState } from './useProvisioningPreparePresentationState';

import type { ProvisioningPrepareState } from './provisioningProviderChecks';

const StateProbe = ({
  state,
  open = true,
}: {
  state: ProvisioningPrepareState;
  open?: boolean;
}): React.JSX.Element => {
  return <span>{useProvisioningPreparePresentationState(state, open)}</span>;
};

describe('useProvisioningPreparePresentationState', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('does not expose a transient failure that settles successfully', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<StateProbe state="failed" />));
    expect(host.textContent).toBe('loading');

    await act(async () => vi.advanceTimersByTimeAsync(199));
    expect(host.textContent).toBe('loading');
    act(() => root.render(<StateProbe state="ready" />));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.textContent).toBe('ready');

    act(() => root.unmount());
  });

  it('shows a failure once it remains stable', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<StateProbe state="failed" />));

    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(host.textContent).toBe('failed');
    act(() => root.unmount());
  });

  it('starts a fresh grace period after the dialog is reopened', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<StateProbe state="failed" />));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(host.textContent).toBe('failed');

    act(() => root.render(<StateProbe state="failed" open={false} />));
    act(() => root.render(<StateProbe state="failed" />));
    expect(host.textContent).toBe('loading');
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(host.textContent).toBe('failed');

    act(() => root.unmount());
  });
});
