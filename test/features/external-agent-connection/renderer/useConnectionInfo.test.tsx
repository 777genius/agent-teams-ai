import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useConnectionInfo } from '@features/external-agent-connection/renderer/useConnectionInfo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionInfoV1 } from '@features/external-agent-connection/contracts';

function connection(status: 'starting' | 'ready'): ConnectionInfoV1 {
  return {
    schemaVersion: 1,
    context: {
      appInstanceId: 'sandbox-app',
      dataRootFingerprint: 'sandbox-root',
      connectionGeneration: 1,
    },
    appVersion: 'test',
    profileFingerprint: 'sandbox',
    observedAt: '2026-10-07T12:00:00.000Z',
    mcp: {
      status,
      transport: 'httpStream',
      url: status === 'ready' ? 'http://127.0.0.1:43001/mcp' : null,
      generation: 1,
    },
    control: { status },
    cdp: {
      status: 'disabled',
      httpOrigin: null,
      browserWsUrl: null,
      rendererTargetId: null,
      rendererWsUrl: null,
      targetGeneration: 0,
    },
    capabilities: { draftCreation: status === 'ready', rendererControl: false },
    errorCode: null,
    reason: null,
    recovery: null,
  };
}

describe('connection discovery request ordering', () => {
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['ready', 'error'] as const)(
    'keeps the retry %s result when an older passive read completes and resumes polling',
    async (outcome) => {
      let finishRead!: (info: ConnectionInfoV1) => void;
      let finishRetry!: (info: ConnectionInfoV1) => void;
      let failRetry!: (cause: Error) => void;
      const pendingRead = new Promise<ConnectionInfoV1>((resolve) => {
        finishRead = resolve;
      });
      const pendingRetry = new Promise<ConnectionInfoV1>((resolve, reject) => {
        finishRetry = resolve;
        failRetry = reject;
      });
      const api = {
        getConnectionInfo: vi
          .fn()
          .mockReturnValueOnce(pendingRead)
          .mockResolvedValue(connection('ready')),
        retryConnection: vi.fn().mockReturnValue(pendingRetry),
      };
      function Probe(): React.JSX.Element {
        const state = useConnectionInfo(api, true);
        return createElement(
          'div',
          null,
          createElement('output', null, state.error ?? state.info?.mcp.status ?? 'loading'),
          createElement(
            'button',
            { onClick: () => void state.retry() },
            state.retrying ? 'retrying' : 'retry'
          )
        );
      }
      await act(async () => root.render(createElement(Probe)));
      await act(async () => host.querySelector('button')!.click());
      expect(host.querySelector('button')?.textContent).toBe('retrying');
      await act(async () => {
        if (outcome === 'ready') finishRetry(connection('ready'));
        else failRetry(new Error('Owned retry failed'));
      });
      const expected = outcome === 'ready' ? 'ready' : 'Owned retry failed';
      expect(host.querySelector('output')?.textContent).toBe(expected);
      await act(async () => finishRead(connection('starting')));
      expect(host.querySelector('output')?.textContent).toBe(expected);
      expect(host.querySelector('button')?.textContent).toBe('retry');
      await act(async () => vi.advanceTimersByTimeAsync(4999));
      expect(api.getConnectionInfo).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(api.getConnectionInfo).toHaveBeenCalledTimes(2);
      expect(host.querySelector('output')?.textContent).toBe('ready');
    }
  );
});
