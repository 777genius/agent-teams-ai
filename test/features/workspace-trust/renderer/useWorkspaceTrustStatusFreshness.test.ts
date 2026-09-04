import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { useWorkspaceTrustStatus } from '@features/workspace-trust/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustProjectStatusResult } from '@features/workspace-trust/contracts';

const transport = vi.hoisted(() => ({
  workspaceTrust: { getProjectStatus: vi.fn() } as
    | { getProjectStatus: ReturnType<typeof vi.fn> }
    | undefined,
}));
vi.mock('@renderer/api', () => ({ api: transport }));

describe('workspace trust request freshness', () => {
  let root: ReturnType<typeof createRoot>;
  let enabled: boolean;
  let projectPath: string;
  let status: ReturnType<typeof useWorkspaceTrustStatus>;
  let resolveRequests: ((result: WorkspaceTrustProjectStatusResult) => void)[];

  function Probe() {
    status = useWorkspaceTrustStatus({ enabled, projectPath });
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
  const dispatch = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
  const resolve = (index: number, next: WorkspaceTrustProjectStatusResult['status']) =>
    act(async () => {
      resolveRequests[index]({ status: next });
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    enabled = true;
    projectPath = '/tmp/trust-sandbox-a';
    resolveRequests = [];
    transport.workspaceTrust = {
      getProjectStatus: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise<WorkspaceTrustProjectStatusResult>((resolveRequest) =>
              resolveRequests.push(resolveRequest)
            )
        ),
    };
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not show cached trust after closing and reopening the same project', async () => {
    await render();
    await dispatch();
    await resolve(0, 'trusted');
    expect(status!).toBe('trusted');
    enabled = false;
    await render();
    expect(status!).toBe('disabled');
    enabled = true;
    await render();
    expect(status!).toBe('checking');
    await dispatch();
    await resolve(1, 'untrusted');
    expect(status!).toBe('untrusted');
    expect(transport.workspaceTrust!.getProjectStatus).toHaveBeenCalledTimes(2);
  });

  it('fences cached and late results when switching A to B and back to A', async () => {
    await render();
    await dispatch();
    await resolve(0, 'trusted');
    projectPath = '/tmp/trust-sandbox-b';
    await render();
    expect(status!).toBe('checking');
    await dispatch();
    projectPath = '/tmp/trust-sandbox-a';
    await render();
    expect(status!).toBe('checking');
    await dispatch();
    await resolve(2, 'unknown');
    await resolve(1, 'untrusted');
    expect(status!).toBe('unknown');
    expect(
      transport.workspaceTrust!.getProjectStatus.mock.calls.map(([input]) => input.projectPath)
    ).toEqual(['/tmp/trust-sandbox-a', '/tmp/trust-sandbox-b', '/tmp/trust-sandbox-a']);
  });

  it('ignores an earlier same-project response after reopen', async () => {
    await render();
    await dispatch();
    enabled = false;
    await render();
    enabled = true;
    await render();
    await dispatch();
    await resolve(1, 'trusted');
    await resolve(0, 'untrusted');
    expect(status!).toBe('trusted');
  });

  it('normalizes whitespace without recreating a request and cancels disabled work', async () => {
    await render();
    projectPath = ' /tmp/trust-sandbox-a  ';
    await render();
    await dispatch();
    await resolve(0, 'trusted');
    expect(status!).toBe('trusted');
    expect(transport.workspaceTrust!.getProjectStatus).toHaveBeenCalledTimes(1);
    projectPath = '/tmp/trust-sandbox-b';
    await render();
    enabled = false;
    await render();
    await dispatch();
    expect(status!).toBe('disabled');
    expect(transport.workspaceTrust!.getProjectStatus).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable or rejected status reads as unknown, not untrusted', async () => {
    transport.workspaceTrust = undefined;
    await render();
    expect(status!).toBe('unknown');
    transport.workspaceTrust = {
      getProjectStatus: vi.fn().mockRejectedValue(new Error('unavailable')),
    };
    projectPath = '/tmp/trust-sandbox-b';
    await render();
    await dispatch();
    expect(status!).toBe('unknown');
  });
});
