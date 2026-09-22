// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TmuxStatusSourceAdapter } from '../TmuxStatusSourceAdapter';

import type { TmuxAutoInstallCapability, TmuxStatus } from '@features/tmux-installer/contracts';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(async () => {}),
}));

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: vi.fn(() => ({})),
}));

const baseCapability: TmuxAutoInstallCapability = {
  supported: true,
  strategy: 'homebrew',
  packageManagerLabel: 'Homebrew',
  requiresTerminalInput: false,
  requiresAdmin: false,
  requiresRestart: false,
  mayOpenExternalWindow: false,
  reasonIfUnsupported: null,
  manualHints: [],
};

describe('TmuxStatusSourceAdapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not reuse or recache a stale in-flight probe after invalidateStatus()', async () => {
    const childProcess = await import('node:child_process');
    type ExecFileCallback = (
      error: Error | null,
      stdout: string | Buffer,
      stderr: string | Buffer
    ) => void;
    const firstCallbackRef: { current: ExecFileCallback | null } = {
      current: null,
    };

    const execFileMock = vi.mocked(childProcess.execFile);
    execFileMock.mockImplementation(((
      _command: string,
      _args: readonly string[] | null | undefined,
      _options: unknown,
      callback: ExecFileCallback
    ) => {
      if (!firstCallbackRef.current) {
        firstCallbackRef.current = callback;
        return {} as never;
      }

      callback(null, 'tmux second\n', '');
      return {} as never;
    }) as never);

    const invalidateOptionalFeatureProbeCache = vi.fn();
    const adapter = new TmuxStatusSourceAdapter(
      {
        resolve: vi.fn(async () => ({ platform: 'darwin', nativeSupported: true })),
      } as never,
      {
        resolveTmuxBinary: vi.fn(async () => '/usr/bin/tmux'),
      } as never,
      {
        resolve: vi.fn(async () => ({
          capability: baseCapability,
          command: null,
          retryWithUpdateCommand: null,
        })),
        buildStatusDetail: vi.fn(
          ({ effective }: { effective: TmuxStatus['effective'] }) => effective.detail
        ),
      } as never,
      { invalidateOptionalFeatureProbeCache } as never
    );

    const firstStatusPromise = adapter.getStatus();
    adapter.invalidateStatus();
    expect(invalidateOptionalFeatureProbeCache).toHaveBeenCalledOnce();
    const secondStatus = await adapter.getStatus();

    expect(secondStatus.host.version).toBe('tmux second');

    firstCallbackRef.current?.(null, 'tmux first\n', '');
    await firstStatusPromise;
    await Promise.resolve();

    const cachedStatus = await adapter.getStatus();
    expect(cachedStatus.host.version).toBe('tmux second');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
