import {
  OPENCODE_RUNTIME_GET_STATUS,
  OPENCODE_RUNTIME_INSTALL,
  OPENCODE_RUNTIME_INVALIDATE_STATUS,
} from '@preload/constants/ipcChannels';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeOpenCodeRuntimeHandlers,
  registerOpenCodeRuntimeHandlers,
} from './openCodeRuntime';

import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { OpenCodeRuntimeInstallerService } from '@main/services';
import type { OpenCodeRuntimeStatus } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const selected = vi.hoisted(() => ({
  native: undefined as
    | { readOpenCodeRuntimeStatus?(): Promise<OpenCodeRuntimeStatus | null> }
    | undefined,
  current: (() => true) as (() => boolean) | null,
  sources: undefined as CapturedRuntimeSources | undefined,
  sourceCaptures: vi.fn(),
}));
vi.mock('./agentBackend', () => ({
  getDesktopProviderStatusPort: () => selected.native,
  captureDesktopStatusRequest: () => selected.current,
  captureDesktopRuntimeSources: () => {
    selected.sourceCaptures();
    return selected.sources ? Promise.resolve(selected.sources) : undefined;
  },
}));
afterEach(() => {
  selected.native = undefined;
  selected.current = () => true;
  selected.sources = undefined;
  selected.sourceCaptures.mockClear();
  vi.restoreAllMocks();
});

function statusFixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, mode?: unknown) => unknown>();
  const legacy: OpenCodeRuntimeStatus = {
    installed: false,
    source: 'path',
    state: 'failed',
    version: '2.777.777 (TEST sentinel)',
  };
  const getStatus = vi.fn(async () => legacy);
  const getReadinessStatus = vi.fn(async (): Promise<OpenCodeRuntimeStatus> => legacy);
  const install = vi.fn();
  const invalidateStatusCache = vi.fn();
  initializeOpenCodeRuntimeHandlers({
    getStatus, getReadinessStatus, install, invalidateStatusCache,
  } as unknown as OpenCodeRuntimeInstallerService);
  registerOpenCodeRuntimeHandlers({
    handle: (name: string, handler: (event: IpcMainInvokeEvent, mode?: unknown) => unknown) =>
      handlers.set(name, handler),
  } as unknown as IpcMain);
  return {
    getStatus,
    getReadinessStatus,
    install,
    invalidateStatusCache,
    legacy,
    invoke: () => handlers.get(OPENCODE_RUNTIME_GET_STATUS)!({} as IpcMainInvokeEvent),
    invalidate: (mode?: unknown) =>
      handlers.get(OPENCODE_RUNTIME_INVALIDATE_STATUS)!({} as IpcMainInvokeEvent, mode),
  };
}

const ready: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'captured-host',
  state: 'ready',
  version: '2.1.4',
  v2Support: 'ready',
};

type SourceSummary = Awaited<ReturnType<CapturedRuntimeSources['current']>>;
function sourceFixture() {
  const summary: SourceSummary = {
    sourceId: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    profileId: 'runtime-source:' + 'b'.repeat(64),
    configRevision: 'runtime-source:' + 'b'.repeat(64),
    sourceKind: 'captured',
    nativeGeneration: 'v2',
    engineVersion: '2.1.4',
    configurationCurrent: true,
    preferencesDigest: 'c'.repeat(64),
  };
  const sources: CapturedRuntimeSources = {
    current: vi.fn(async () => ({ ...summary })),
    retained: vi.fn(async () => []),
    publish: vi.fn(async () => { throw new Error('TEST unexpected publication'); }),
    refreshConfiguration: vi.fn(async () => { throw new Error('TEST unexpected refresh'); }),
    recover: vi.fn(async () => null),
    lookup: vi.fn(async () => null),
  };
  const status: OpenCodeRuntimeStatus = {
    ...ready, engineVersion: '2.1.4', sourceRevision: summary.revision,
  };
  const read = vi.fn(async () => status);
  selected.native = { readOpenCodeRuntimeStatus: read };
  selected.sources = sources;
  return { summary, sources, status, read };
}
function v1SourceFixture() {
  const original = sourceFixture();
  const summary: SourceSummary = {
    sourceId: original.summary.sourceId,
    revision: original.summary.revision,
    profileId: 'TEST-v1-captured-profile',
    configRevision: 'TEST-v1-captured-config',
    sourceKind: 'captured',
    nativeGeneration: 'v1',
  };
  const status: OpenCodeRuntimeStatus = {
    installed: true, source: 'captured-host', state: 'ready',
    nativeGeneration: 'v1', sourceRevision: summary.revision,
  };
  vi.mocked(original.sources.current).mockImplementation(async () => ({ ...summary }));
  original.read.mockResolvedValue(status);
  return { ...original, summary, status };
}
function expectNoSourceMutation(sources: CapturedRuntimeSources) {
  expect(sources.publish).not.toHaveBeenCalled();
  expect(sources.refreshConfiguration).not.toHaveBeenCalled();
  expect(sources.recover).not.toHaveBeenCalled();
  expect(sources.lookup).not.toHaveBeenCalled();
  expect(sources.retained).not.toHaveBeenCalled();
}

it('selected Host V2 status cannot be replaced by a global CLI sentinel', async () => {
  const f = statusFixture();
  const readOpenCodeRuntimeStatus = vi.fn(async () => ready);
  selected.native = { readOpenCodeRuntimeStatus };
  await expect(f.invoke()).resolves.toEqual({ success: true, data: ready });
  expect(readOpenCodeRuntimeStatus).toHaveBeenCalledOnce();
  expect(f.getStatus).not.toHaveBeenCalled();

  const s = sourceFixture();
  await expect(f.invalidate('cache-only')).resolves.toEqual({ success: true, data: undefined });
  expect(f.invalidateStatusCache).toHaveBeenCalledTimes(1);
  expect(selected.sourceCaptures).not.toHaveBeenCalled();
  expect(s.sources.current).not.toHaveBeenCalled();
  expect(f.getReadinessStatus).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  expectNoSourceMutation(s.sources);

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await expect(f.invalidate('refresh')).resolves.toMatchObject({ success: false });
  selected.current = () => false;
  await expect(f.invalidate('cache-only')).resolves.toMatchObject({ success: false });
  expect(f.invalidateStatusCache).toHaveBeenCalledTimes(1);
  expect(selected.sourceCaptures).not.toHaveBeenCalled();
  selected.current = () => true;
  await expect(f.invalidate()).resolves.toEqual({
    success: false,
    error: 'OpenCode installation could not be confirmed.',
  });
  expect(f.invalidateStatusCache).toHaveBeenCalledTimes(2);
  expect(selected.sourceCaptures).toHaveBeenCalledTimes(1);
  expect(s.sources.current).toHaveBeenCalledTimes(1);
  expect(s.sources.recover).toHaveBeenCalledTimes(1);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(1);
  expect(f.install).not.toHaveBeenCalled();
  expect(s.sources.publish).not.toHaveBeenCalled();
  expect(s.sources.refreshConfiguration).not.toHaveBeenCalled();
  expect(s.sources.lookup).not.toHaveBeenCalled();
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('unselected Host preserves installer status while selected native V1 requires its own evidence', async () => {
  const f = statusFixture();
  await expect(f.invoke()).resolves.toEqual({ success: true, data: f.legacy });
  selected.native = { readOpenCodeRuntimeStatus: async () => null };
  await expect(f.invoke()).resolves.toEqual({
    success: false,
    error: 'Native runtime status could not be confirmed',
  });
  const captured: OpenCodeRuntimeStatus = {
    installed: true,
    source: 'captured-host',
    state: 'ready',
    nativeGeneration: 'v1',
  };
  selected.native = { readOpenCodeRuntimeStatus: async () => captured };
  await expect(f.invoke()).resolves.toEqual({ success: true, data: captured });
  expect(f.getStatus).toHaveBeenCalledTimes(1);

  expect(f.getReadinessStatus).not.toHaveBeenCalled();
  const s = v1SourceFixture();
  expect(s.summary.configurationCurrent).toBeUndefined();
  const cases: [OpenCodeRuntimeStatus, OpenCodeRuntimeStatus['v1Maintenance']][] = [
    [
      { installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' },
      { installed: false, source: 'missing', state: 'idle' },
    ],
    [
      { installed: true, source: 'path', state: 'ready', version: '1.19.4' },
      { installed: true, source: 'path', state: 'ready', version: '1.19.4' },
    ],
  ];
  for (const [stock, maintenance] of cases) {
    f.getReadinessStatus.mockResolvedValueOnce(stock);
    await expect(f.invoke()).resolves.toEqual({
      success: true, data: { ...s.status, v1Maintenance: maintenance },
    });
  }
  expect(s.read).toHaveBeenCalledTimes(2);
  expect(s.sources.current).toHaveBeenCalledTimes(4);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(2);
  expect(f.getStatus).toHaveBeenCalledTimes(1);
  expect(f.install).not.toHaveBeenCalled();
  expectNoSourceMutation(s.sources);

  selected.sources = undefined;
  await expect(f.invoke()).resolves.toEqual({ success: true, data: s.status });
  selected.sources = s.sources;
  const published: OpenCodeRuntimeStatus = { ...s.status, source: 'path', version: '1.19.4' };
  s.read.mockResolvedValueOnce(published);
  await expect(f.invoke()).resolves.toEqual({ success: true, data: published });
  expect(s.sources.current).toHaveBeenCalledTimes(4);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(2);
  expect(f.getStatus).toHaveBeenCalledTimes(1);
  expectNoSourceMutation(s.sources);
});

it('failed or absent native runtime evidence never falls back to a global CLI', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = statusFixture();
  selected.native = {};
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  selected.native = {
    readOpenCodeRuntimeStatus: async () => {
      throw new Error('Native runtime identity is unavailable');
    },
  };
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(f.getStatus).not.toHaveBeenCalled();
  expect(f.getReadinessStatus).not.toHaveBeenCalled();
});

it('native runtime status requires the original sender and rejects a changed context after the read', async () => {
  const f = statusFixture();
  const readOpenCodeRuntimeStatus = vi.fn(async () => ready);
  selected.native = { readOpenCodeRuntimeStatus };
  selected.current = null;
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(readOpenCodeRuntimeStatus).not.toHaveBeenCalled();
  let current = true;
  selected.current = () => current;
  readOpenCodeRuntimeStatus.mockImplementationOnce(async () => {
    current = false;
    return ready;
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('the V1 native response is also discarded if the captured context changes while it is read', async () => {
  const f = statusFixture();
  let current = true;
  selected.current = () => current;
  selected.native = {
    readOpenCodeRuntimeStatus: async () => {
      current = false;
      return { installed: true, source: 'captured-host', state: 'ready', nativeGeneration: 'v1' };
    },
  };
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(f.getStatus).not.toHaveBeenCalled();

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  current = true;
  const s = v1SourceFixture();
  const unqualified: OpenCodeRuntimeStatus[] = [
    { installed: false, source: 'path', state: 'failed', error: 'TEST failed version' },
    { installed: true, source: 'path', state: 'ready', version: '2.3.0' },
    { installed: false, source: 'missing', state: 'idle', ignoredOverride: {
      binaryPath: '/TEST/ignored', envName: 'TEST_OVERRIDE', version: null, reason: 'TEST invalid',
    } },
  ];
  for (const stock of unqualified) {
    f.getReadinessStatus.mockResolvedValueOnce(stock);
    await expect(f.invoke()).resolves.toEqual({ success: true, data: s.status });
  }
  f.getReadinessStatus.mockRejectedValueOnce(new Error('TEST optional discovery unavailable'));
  await expect(f.invoke()).resolves.toEqual({ success: true, data: s.status });
  expect(s.sources.current).toHaveBeenCalledTimes(8);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(4);
  expectNoSourceMutation(s.sources);

  const changed = v1SourceFixture();
  f.getReadinessStatus.mockImplementationOnce(async () => {
    changed.summary.configRevision = 'TEST-replaced-config';
    return { installed: false, source: 'missing', state: 'idle' };
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(changed.sources.current).toHaveBeenCalledTimes(2);
  expectNoSourceMutation(changed.sources);

  const changedAfterFailure = v1SourceFixture();
  f.getReadinessStatus.mockImplementationOnce(async () => {
    changedAfterFailure.summary.preferencesDigest = 'd'.repeat(64);
    throw new Error('TEST optional failure after original source changed');
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(changedAfterFailure.sources.current).toHaveBeenCalledTimes(2);
  expectNoSourceMutation(changedAfterFailure.sources);

  const foreground = v1SourceFixture();
  f.getReadinessStatus.mockImplementationOnce(async () => {
    current = false;
    throw new Error('TEST optional failure after foreground changed');
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(foreground.sources.current).toHaveBeenCalledTimes(2);
  expectNoSourceMutation(foreground.sources);

  current = true;
  const mismatched = v1SourceFixture();
  mismatched.summary.revision = 'd'.repeat(64);
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(mismatched.sources.current).toHaveBeenCalledTimes(1);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(7);
  expect(f.getStatus).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  expectNoSourceMutation(mismatched.sources);
});

it('adds only qualified CLI maintenance beside the original selected engine', async () => {
  const f = statusFixture();
  const s = sourceFixture();
  const cases: [OpenCodeRuntimeStatus, OpenCodeRuntimeStatus['v2Maintenance']][] = [
    [
      { installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' },
      { kind: 'missing', engineVersion: '2.1.4' },
    ],
    [
      { installed: true, source: 'path', state: 'idle', version: '2.0.21',
        compatibleV2Version: '2.1.4', v2Support: 'required', error: 'TEST missing support' },
      { kind: 'installed', cliVersion: '2.0.21', engineVersion: '2.1.4', support: 'required' },
    ],
    [
      { installed: true, source: 'app-managed', state: 'ready', version: '2.3.0',
        compatibleV2Version: '2.1.4', v2Support: 'ready' },
      { kind: 'installed', cliVersion: '2.3.0', engineVersion: '2.1.4', support: 'ready' },
    ],
  ];
  for (const [stock, maintenance] of cases) {
    f.getReadinessStatus.mockResolvedValueOnce(stock);
    await expect(f.invoke()).resolves.toEqual({
      success: true, data: { ...s.status, v2Maintenance: maintenance },
    });
  }
  expect(s.read).toHaveBeenCalledTimes(3);
  expect(s.sources.current).toHaveBeenCalledTimes(6);
  expect(f.getReadinessStatus).toHaveBeenCalledTimes(3);
  expect(f.getStatus).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  expectNoSourceMutation(s.sources);
});

it('keeps native readiness when optional discovery fails or does not prove a compatible CLI', async () => {
  const f = statusFixture();
  const s = sourceFixture();
  const rejected: OpenCodeRuntimeStatus[] = [
    { installed: false, source: 'override', state: 'failed', error: 'TEST broken override' },
    { installed: false, source: 'path', state: 'failed', error: 'TEST failed version' },
    { installed: false, source: 'missing', state: 'idle', ignoredOverride: {
      binaryPath: '/TEST/missing-override', envName: 'TEST_OVERRIDE', version: null, reason: 'TEST missing',
    } },
    { installed: true, source: 'path', state: 'ready', version: '1.19.4' },
    { installed: true, source: 'path', state: 'ready', version: '2.3.0',
      compatibleV2Version: '2.9.9', v2Support: 'ready' },
    { installed: true, source: 'path', state: 'failed', version: '2.0.21',
      compatibleV2Version: '2.1.4', v2Support: 'ready' },
  ];
  for (const stock of rejected) {
    f.getReadinessStatus.mockResolvedValueOnce(stock);
    await expect(f.invoke()).resolves.toEqual({ success: true, data: s.status });
  }
  f.getReadinessStatus.mockRejectedValueOnce(new Error('TEST discovery unavailable'));
  await expect(f.invoke()).resolves.toEqual({ success: true, data: s.status });
  expect(s.sources.current).toHaveBeenCalledTimes(2 * (rejected.length + 1));
  expect(f.getStatus).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  expectNoSourceMutation(s.sources);
});

it('never attaches maintenance to a replacement source or a changed original foreground', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = statusFixture();
  const changes: [keyof SourceSummary, unknown][] = [
    ['sourceId', 'd'.repeat(64)], ['revision', 'd'.repeat(64)], ['profileId', 'TEST replacement'],
    ['configRevision', 'TEST replacement'], ['sourceKind', 'path'], ['nativeGeneration', 'v1'],
    ['cliVersion', '2.0.21'], ['engineVersion', '2.9.9'], ['configurationCurrent', false],
    ['preferencesDigest', 'd'.repeat(64)],
  ];
  for (const [field, value] of changes) {
    const s = sourceFixture();
    f.getReadinessStatus.mockImplementationOnce(async () => {
      Object.assign(s.summary, { [field]: value });
      return { installed: false, source: 'missing', state: 'idle' };
    });
    await expect(f.invoke()).resolves.toMatchObject({ success: false });
    expect(s.sources.current).toHaveBeenCalledTimes(2);
    expectNoSourceMutation(s.sources);
  }
  const changed = sourceFixture();
  f.getReadinessStatus.mockImplementationOnce(async () => {
    changed.summary.preferencesDigest = 'd'.repeat(64);
    throw new Error('TEST optional discovery failure after source changed');
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(changed.sources.current).toHaveBeenCalledTimes(2);
  expectNoSourceMutation(changed.sources);
  const s = sourceFixture();
  let current = true;
  selected.current = () => current;
  f.getReadinessStatus.mockImplementationOnce(async () => {
    current = false;
    throw new Error('TEST optional discovery failure after foreground changed');
  });
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  expect(s.sources.current).toHaveBeenCalledTimes(2);
  expectNoSourceMutation(s.sources);
  expect(f.install).not.toHaveBeenCalled();
  expect(f.getStatus).not.toHaveBeenCalled();
});

it('requires original current configuration and matching native revision before discovery', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = statusFixture();
  const s = sourceFixture();
  s.summary.revision = 'd'.repeat(64);
  await expect(f.invoke()).resolves.toMatchObject({ success: false });
  const published = sourceFixture();
  published.summary.cliVersion = '2.0.21';
  await expect(f.invoke()).resolves.toEqual({ success: true, data: published.status });
  const stale = sourceFixture();
  stale.summary.configurationCurrent = false;
  await expect(f.invoke()).resolves.toEqual({ success: true, data: stale.status });
  const failed = sourceFixture();
  failed.status.state = 'failed';
  await expect(f.invoke()).resolves.toEqual({ success: true, data: failed.status });
  expect(failed.sources.current).not.toHaveBeenCalled();
  expect(f.getReadinessStatus).not.toHaveBeenCalled();
  expect(f.getStatus).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  for (const entry of [s, published, stale, failed]) expectNoSourceMutation(entry.sources);
});

describe('OpenCode runtime install IPC', () => {
  it('forwards the generation and rejects unsupported caller fields before installation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, options?: unknown) => unknown>();
    const install = vi
      .fn()
      .mockResolvedValue({ installed: false, source: 'missing', state: 'idle' });
    initializeOpenCodeRuntimeHandlers({ install } as unknown as OpenCodeRuntimeInstallerService);
    registerOpenCodeRuntimeHandlers({
      handle: (name: string, handler: (event: IpcMainInvokeEvent, options?: unknown) => unknown) =>
        handlers.set(name, handler),
    } as unknown as IpcMain);
    const invoke = handlers.get(OPENCODE_RUNTIME_INSTALL)!;
    await expect(invoke({} as IpcMainInvokeEvent, { generation: 'v2' })).resolves.toMatchObject({
      success: true,
    });
    expect(install).toHaveBeenCalledWith({ generation: 'v2' });
    await expect(
      invoke({} as IpcMainInvokeEvent, { generation: 'nightly' })
    ).resolves.toMatchObject({ success: false });
    await expect(invoke({} as IpcMainInvokeEvent, { binaryPath: '/other' })).resolves.toMatchObject(
      { success: false }
    );
    expect(install).toHaveBeenCalledTimes(1);
  });
});
