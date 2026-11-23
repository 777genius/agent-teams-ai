import '@features/localization/renderer/composition/createI18nextInstance';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ExternalAgentConfirmationDialog } from '@features/external-agent-connection/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ExternalAgentConfirmation,
  ExternalAgentConnectionApi,
} from '@features/external-agent-connection/contracts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('external agent confirmation dialog', () => {
  it('recovers a pending confirmation if main handlers were not ready at mount', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const api: ExternalAgentConnectionApi = {
      getConnectionInfo: vi.fn(),
      retryConnection: vi.fn(),
      getPendingConfirmation: vi
        .fn()
        .mockRejectedValueOnce(new Error('not ready'))
        .mockResolvedValueOnce({ id: 'pending', agentName: 'Claude Code' }),
      onConfirmation: () => () => undefined,
      dismissConfirmation: vi.fn(async () => undefined),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ExternalAgentConfirmationDialog api={api} />));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(document.body.textContent).toContain('Claude Code reached this app through MCP');
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it('shows a client-reported connection and dismisses the matching pending request', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let notify: ((value: ExternalAgentConfirmation | null) => void) | undefined;
    const dismiss = vi.fn(async () => undefined);
    const api: ExternalAgentConnectionApi = {
      getConnectionInfo: vi.fn(),
      retryConnection: vi.fn(),
      getPendingConfirmation: vi.fn(async () => null),
      dismissConfirmation: dismiss,
      onConfirmation: (callback) => {
        notify = callback;
        return () => {
          notify = undefined;
        };
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ExternalAgentConfirmationDialog api={api} />));
    expect(document.body.textContent).not.toContain('Agent connected to this app');
    await act(async () => notify?.({ id: 'sandbox-event', agentName: 'Codex', cdpVerified: true }));
    expect(document.body.textContent).toContain('Agent connected to this app');
    expect(document.body.textContent).toContain(
      'Codex reports it connected to both MCP and the interface'
    );
    expect(document.body.textContent).toContain('client reports its name and CDP verification');
    await act(async () => notify?.(null));
    expect(document.body.textContent).not.toContain('Agent connected to this app');
    await act(async () => notify?.({ id: 'sandbox-event', agentName: 'Codex', cdpVerified: true }));
    const done = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Done'
    );
    expect(done).toBeDefined();
    await act(async () => done!.click());
    expect(dismiss).toHaveBeenCalledWith('sandbox-event');
    await act(async () => root.unmount());
    expect(notify).toBeUndefined();
  });
});
