import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useWorkspaceTrustStatus } from '@features/workspace-trust/renderer';
import {
  getWorkspaceTrustDisplayStatus,
  shouldShowWorkspaceTrustLaunchNotice,
} from '@features/workspace-trust/renderer/view-models/workspaceTrustLaunchNotice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  api: { workspaceTrust: { getLaunchStatus: vi.fn(), getProjectStatus: vi.fn() } },
  source: {} as Record<string, unknown>,
}));
vi.mock('@renderer/api', () => ({ api: mock.api }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mock.source) => unknown) => selector(mock.source),
}));

describe('provider-aware trust display', () => {
  it.each([
    ['trusted', 'launch_scoped', false],
    ['trusted', 'disabled', false],
    ['disabled', 'not_applicable', false],
    ['untrusted', 'disabled', true],
    ['unknown', 'launch_scoped', false],
    ['trusted', 'unknown', false],
    ['trusted', 'trusted', false],
  ])('projects %s + %s conservatively', (anthropic, codex, visible) => {
    const status = getWorkspaceTrustDisplayStatus(
      {
        providers: [
          { providerId: 'anthropic', status: anthropic },
          { providerId: 'codex', status: codex },
        ],
      },
      ['anthropic', 'codex']
    );
    expect(shouldShowWorkspaceTrustLaunchNotice(status)).toBe(visible);
  });

  it.each([
    null,
    {},
    { providers: null },
    { providers: [] },
    { providers: [null, { providerId: 'other', status: 'trusted' }] },
    { providers: [{ providerId: 'anthropic', status: 'trusted' }] },
    { providers: [{ providerId: 'codex', status: 'trusted' }] },
    {
      providers: [
        { providerId: 'codex', status: 'disabled' },
        { providerId: 'codex', status: 'disabled' },
      ],
    },
  ])('never suppresses missing or malformed Codex evidence: %j', (result) => {
    expect(getWorkspaceTrustDisplayStatus(result, ['codex'])).toBe('unknown');
  });
});

describe('provider-aware trust request lifecycle', () => {
  let root: ReturnType<typeof createRoot>;
  let providerIds: string[];
  let enabled: boolean;
  let status: ReturnType<typeof useWorkspaceTrustStatus>;
  let requests: { resolve: (result: unknown) => void; reject: (error: Error) => void }[];
  function Probe() {
    status = useWorkspaceTrustStatus({ enabled, projectPath: '/tmp/trust-sandbox', providerIds });
    return null;
  }
  const render = () => act(async () => root.render(createElement(Probe)));
  const advance = (ms = 120) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const resolve = (index: number, providerId: string, next: string) =>
    act(async () => {
      requests[index].resolve({ providers: [{ providerId, status: next }] });
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mock.source = {};
    enabled = true;
    providerIds = ['codex'];
    requests = [];
    mock.api.workspaceTrust.getProjectStatus.mockReset().mockResolvedValue({ status: 'trusted' });
    mock.api.workspaceTrust.getLaunchStatus = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          requests.push({ resolve, reject });
        })
    );
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('filters and deduplicates providers without requests on roster reorder', async () => {
    providerIds = ['codex', 'opencode', 'anthropic', 'codex'];
    await render();
    await advance();
    expect(mock.api.workspaceTrust.getLaunchStatus).toHaveBeenCalledWith({
      projectPath: '/tmp/trust-sandbox',
      providerIds: ['anthropic', 'codex'],
    });
    providerIds = ['anthropic', 'codex', 'opencode'];
    await render();
    await advance();
    expect(requests).toHaveLength(1);
  });

  it('does not request unsupported-only, disabled or empty selections', async () => {
    for (const providers of [['opencode', 'gemini'], [], ['codex']]) {
      providerIds = providers;
      enabled = providers[0] !== 'codex';
      await render();
      await advance();
      expect(status!).toBe('disabled');
    }
    expect(requests).toHaveLength(0);
  });

  it('fences provider A-B-A and ignores stale trusted results', async () => {
    providerIds = ['anthropic'];
    await render();
    await advance();
    providerIds = ['codex'];
    await render();
    await advance();
    providerIds = ['anthropic'];
    await render();
    await advance();
    expect(status!).toBe('checking');
    await resolve(2, 'anthropic', 'untrusted');
    await resolve(0, 'anthropic', 'trusted');
    await resolve(1, 'codex', 'disabled');
    expect(status!).toBe('untrusted');
  });

  it('ends checking after two seconds and ignores late success without retrying', async () => {
    await render();
    await advance(1_999);
    expect(status!).toBe('checking');
    await advance(1);
    expect(status!).toBe('unknown');
    await resolve(0, 'codex', 'disabled');
    await advance(5_000);
    expect(status!).toBe('unknown');
    expect(requests).toHaveLength(1);
  });

  it.each([{ appConfig: { general: { claudeRootPath: '/tmp/alternate-test-config' } } }])(
    'invalidates source changes: %j',
    async (source) => {
      await render();
      await advance();
      await resolve(0, 'codex', 'disabled');
      mock.source = source;
      await render();
      expect(status!).toBe('checking');
      await advance();
      await resolve(1, 'codex', 'launch_scoped');
      expect(status!).toBe('launch_scoped');
    }
  );

  it('keeps legacy evidence Anthropic-only', async () => {
    mock.api.workspaceTrust.getLaunchStatus = undefined as never;
    await render();
    await advance();
    expect(status!).toBe('unknown');
    expect(mock.api.workspaceTrust.getProjectStatus).not.toHaveBeenCalled();
    providerIds = ['anthropic'];
    await render();
    await advance();
    expect(status!).toBe('trusted');
    providerIds = ['anthropic', 'codex'];
    await render();
    await advance();
    expect(status!).toBe('unknown');
    expect(mock.api.workspaceTrust.getProjectStatus).toHaveBeenCalledTimes(1);
  });

  it('handles synchronous transport errors and rejects after cleanup safely', async () => {
    mock.api.workspaceTrust.getLaunchStatus.mockImplementationOnce(() => {
      throw new Error('old bridge');
    });
    await render();
    await advance();
    expect(status!).toBe('unknown');
    enabled = false;
    await render();
    enabled = true;
    await render();
    await advance();
    enabled = false;
    await render();
    await act(async () => requests[0].reject(new Error('closed')));
    expect(status!).toBe('disabled');
  });

  it.each([
    { activeContextId: 'ssh:test' },
    { connectionMode: 'ssh' },
    { activeContextId: 'local', isContextSwitching: true },
  ])('does not use legacy local reads for remote or switching context: %j', async (source) => {
    providerIds = ['anthropic'];
    mock.source = source;
    mock.api.workspaceTrust.getLaunchStatus = undefined as never;
    await render();
    await advance();
    expect(status!).toBe('unknown');
    expect(mock.api.workspaceTrust.getProjectStatus).not.toHaveBeenCalled();
  });

  it.each([
    { activeContextId: 'ssh:test' },
    { connectionMode: 'ssh', connectedHost: 'test-host', connectionState: 'connected' },
    { activeContextId: 'local', isContextSwitching: true, targetContextId: 'local' },
  ])('fences all transports during remote or switching context: %j', async (source) => {
    providerIds = ['anthropic'];
    await render();
    await advance();
    mock.source = source;
    await render();
    await advance();
    await resolve(0, 'anthropic', 'trusted');
    expect(status!).toBe('unknown');
    expect(mock.api.workspaceTrust.getLaunchStatus).toHaveBeenCalledTimes(1);
    expect(mock.api.workspaceTrust.getProjectStatus).not.toHaveBeenCalled();
    mock.source = { activeContextId: 'local' };
    await render();
    expect(status!).toBe('checking');
    await advance();
    expect(mock.api.workspaceTrust.getLaunchStatus).toHaveBeenCalledTimes(2);
  });

  it('cleans timers and ignores rejection after unmount', async () => {
    await render();
    await advance();
    await act(async () => root.unmount());
    await act(async () => requests[0].reject(new Error('unmounted')));
    expect(vi.getTimerCount()).toBe(0);
  });
});
