// @vitest-environment node
import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import { ExternalAgentRunService } from '@features/external-agent-connection/main/ExternalAgentRunService';
import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectionInfoV1,
  ExternalAgentRunRequest,
} from '@features/external-agent-connection/contracts';
import type { PreparedExternalAgentRun } from '@features/external-agent-connection/main/ExternalAgentRunService';
import type { CliProviderStatus } from '@shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const context = new BoundControlContext('sandbox-native-run', '/sandbox/native-run-root');
  const connection: ConnectionInfoV1 = {
    schemaVersion: 1,
    context: context.snapshot(),
    appVersion: 'test',
    profileFingerprint: 'test-profile',
    observedAt: new Date().toISOString(),
    mcp: {
      status: 'ready',
      transport: 'httpStream',
      url: 'http://127.0.0.1:41000/mcp',
      generation: 1,
    },
    control: { status: 'ready' },
    cdp: {
      status: 'disabled',
      httpOrigin: null,
      browserWsUrl: null,
      rendererTargetId: null,
      rendererWsUrl: null,
      targetGeneration: 0,
    },
    capabilities: {
      draftCreation: true,
      configurationEdit: true,
      reversibleTrash: true,
      rendererControl: false,
    },
    errorCode: null,
    reason: null,
    recovery: null,
  };
  const provider: CliProviderStatus = {
    providerId: 'anthropic',
    displayName: 'Claude',
    supported: true,
    authenticated: true,
    authMethod: 'subscription',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models: [],
    canLoginFromUi: false,
    capabilities: {
      oneShot: true,
      teamLaunch: false,
      extensions: {
        skills: { status: 'unsupported', ownership: 'provider-scoped' },
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'unsupported', ownership: 'provider-scoped' },
      },
    },
  };
  const result = deferred<{ successful: boolean }>();
  const runtime: PreparedExternalAgentRun = {
    launch: vi.fn(() => result.promise),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const deps = {
    getAvailability: vi.fn(async () => ({ codex: true, anthropic: true })),
    getConnectionInfo: vi.fn(async () => ({ ...connection, context: context.snapshot() })),
    withExpectedContext: async <T>(
      expected: ExternalAgentRunRequest['expectedContext'],
      operation: () => Promise<T>
    ) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    getProviderStatus: vi.fn(async (): Promise<CliProviderStatus | null> => provider),
    prepare: vi.fn(async () => runtime),
  };
  const service = new ExternalAgentRunService(deps);
  const request: ExternalAgentRunRequest = {
    providerId: 'anthropic',
    task: 'Create one sandbox marketing draft',
    expectedContext: connection.context,
  };
  return { service, request, runtime, result, deps, context, provider };
}

describe('native prompt run lifecycle', () => {
  it('rejects stale app/root/generation before native preparation can spawn', async () => {
    const s = setup();
    await s.context.closeAdmission();
    s.context.rebind('/sandbox/new-root');
    await s.service.start(s.request);
    expect(await s.service.getSnapshot()).toBeNull();
    expect(s.deps.prepare).not.toHaveBeenCalled();
    expect(s.runtime.launch).not.toHaveBeenCalled();
  });

  it('reserves before async readiness and cancels late preparation without a launch', async () => {
    const s = setup();
    const prepared = deferred<PreparedExternalAgentRun>();
    s.deps.prepare.mockReturnValue(prepared.promise);
    const started = await s.service.start(s.request);
    await expect(s.service.start(s.request)).rejects.toThrow('already active');
    await vi.waitFor(() => expect(s.deps.prepare).toHaveBeenCalledOnce());
    await s.service.cancel({ runId: started.runId });
    await vi.waitFor(async () => expect((await s.service.getSnapshot())?.status).toBe('cancelled'));
    prepared.resolve(s.runtime);
    await vi.waitFor(() => expect(s.runtime.dispose).toHaveBeenCalledOnce());
    expect(s.runtime.launch).not.toHaveBeenCalled();
  });

  it('denies non-authoritative/authenticated readiness even when the provider is detected', async () => {
    const s = setup();
    s.provider.statusCheckOutcome = 'pending';
    await s.service.start(s.request);
    await vi.waitFor(async () => expect((await s.service.getSnapshot())?.status).toBe('failed'));
    expect(s.runtime.launch).not.toHaveBeenCalled();
  });

  it('disposes resources when cancellation wins the preparation promise adoption microtask', async () => {
    const s = setup();
    const prepared = deferred<PreparedExternalAgentRun>();
    s.deps.prepare.mockReturnValue(prepared.promise);
    const started = await s.service.start(s.request);
    await vi.waitFor(() => expect(s.deps.prepare).toHaveBeenCalledOnce());
    prepared.resolve(s.runtime);
    queueMicrotask(() => {
      void s.service.cancel({ runId: started.runId });
    });
    await vi.waitFor(async () => expect((await s.service.getSnapshot())?.status).toBe('cancelled'));
    expect(s.runtime.dispose).toHaveBeenCalledOnce();
    expect(s.runtime.launch).not.toHaveBeenCalled();
  });

  it('rechecks readiness after preparation and does not borrow teamLaunch/catalog authority', async () => {
    const s = setup();
    s.deps.prepare.mockImplementation(async () => {
      s.provider.authenticated = false;
      return s.runtime;
    });
    await s.service.start(s.request);
    await vi.waitFor(async () => expect((await s.service.getSnapshot())?.status).toBe('failed'));
    expect(s.runtime.launch).not.toHaveBeenCalled();
    expect(s.runtime.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the exact task immutable, completes truthful output and ignores an older run cancel', async () => {
    const s = setup();
    const started = await s.service.start(s.request);
    s.request.task = 'A different edited request';
    await vi.waitFor(() => expect(s.runtime.launch).toHaveBeenCalledOnce());
    const launch = vi.mocked(s.runtime.launch).mock.calls[0];
    expect(launch[0]).toContain('Create one sandbox marketing draft');
    expect(launch[0]).not.toContain('A different edited request');
    launch[1]('{"type":"assistant","message":"Saved sandbox draft"}');
    s.result.resolve({ successful: true });
    await vi.waitFor(async () => expect((await s.service.getSnapshot())?.status).toBe('completed'));
    expect((await s.service.getSnapshot())?.logs).toContain('Saved sandbox draft');
    expect((await s.service.getSnapshot())?.task).toBe('Create one sandbox marketing draft');
    const newer = await s.service.start(s.request);
    await s.service.cancel({ runId: started.runId });
    expect((await s.service.getSnapshot())?.runId).toBe(newer.runId);
    expect(s.runtime.stop).not.toHaveBeenCalled();
    await s.service.shutdown();
    const sameRoot = await s.service.getSnapshot();
    expect(sameRoot?.runId).toBe(newer.runId);
    // An unsuccessful switch that leaves authority unchanged must not purge history.
    expect((await s.service.getSnapshot())?.runId).toBe(sameRoot?.runId);
    await s.context.closeAdmission();
    s.context.rebind('/sandbox/other-native-run-root');
    expect(await s.service.getSnapshot()).toBeNull();
  });

  it('cancels a hung readiness request without preventing shutdown', async () => {
    const s = setup();
    s.deps.getProviderStatus.mockReturnValue(new Promise(() => {}));
    await s.service.start(s.request);
    await vi.waitFor(() => expect(s.deps.getProviderStatus).toHaveBeenCalled());
    await s.service.shutdown();
    expect((await s.service.getSnapshot())?.status).toBe('cancelled');
    expect(s.runtime.launch).not.toHaveBeenCalled();
  });

  it('stops an owned run before hiding it when transport generation invalidates snapshot recovery', async () => {
    const s = setup();
    await s.service.start(s.request);
    await vi.waitFor(() => expect(s.runtime.launch).toHaveBeenCalledOnce());
    s.context.transportReplaced();
    expect(await s.service.getSnapshot()).toBeNull();
    expect(s.runtime.stop).toHaveBeenCalledOnce();
    expect(s.runtime.dispose).toHaveBeenCalledOnce();
    s.request.expectedContext = s.context.snapshot();
    await expect(s.service.start(s.request)).resolves.toMatchObject({ status: 'preparing' });
    await s.service.shutdown();
  });
});
