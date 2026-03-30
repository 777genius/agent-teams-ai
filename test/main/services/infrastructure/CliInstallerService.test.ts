import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing service
vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    execCli: vi.fn().mockRejectedValue(new Error('execCli not configured')),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn((cb: () => void) => cb()),
      destroy: vi.fn(),
      on: vi.fn(),
    })),
    promises: {
      ...actual.promises,
      chmod: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return {
    ...actual,
    default: {
      ...actual,
      get: vi.fn(),
    },
  };
});

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    default: {
      ...actual,
      get: vi.fn(),
    },
  };
});

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn(),
    clearCache: vi.fn(),
  },
}));

import {
  CliInstallerService,
  isVersionOlder,
  normalizeVersion,
} from '@main/services/infrastructure/CliInstallerService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli } from '@main/utils/childProcess';

/**
 * Helper: allow expected console.error/warn calls in tests where service logs errors.
 * The test setup asserts no unexpected console.error/warn, so we re-spy to capture them.
 */
function allowConsoleLogs(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('CliInstallerService', () => {
  let service: CliInstallerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CliInstallerService();
  });

  describe('getStatus', () => {
    it('returns not installed when binary is not found', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(null);

      const status = await service.getStatus();

      expect(status.installed).toBe(false);
      expect(status.installedVersion).toBeNull();
      expect(status.binaryPath).toBeNull();
      expect(status.updateAvailable).toBe(false);
    });

    it('returns installed when binary exists', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      const status = await service.getStatus();

      expect(status.installed).toBe(true);
      expect(status.binaryPath).toBe('/usr/local/bin/claude');
      // Version will be null because execFile is mocked to no-op
      // and latestVersion will be null because fetch is mocked
    });

    it('handles spawn EINVAL when binary path contains non-ASCII by falling back', async () => {
      allowConsoleLogs();
      const fakePath = 'C:\\Users\\Алексей\\AppData\\Roaming\\npm\\claude.cmd';
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(fakePath);

      // execCli handles the EINVAL → shell fallback internally;
      // here we just verify the service delegates to execCli correctly.
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' }) // --version
        .mockResolvedValueOnce({ stdout: '{}', stderr: '' }); // auth status

      const status = await service.getStatus();
      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.3.4');
      expect(execCli).toHaveBeenCalledWith(
        fakePath,
        ['--version'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('treats auth as logged in when JSON is embedded after stdout noise', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'notice: something\n{"loggedIn":true,"authMethod":"oauth_token"}\n',
          stderr: '',
        });

      const status = await service.getStatus();
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('oauth_token');
    });
  });

  describe('install mutex', () => {
    it('prevents concurrent installations', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // Start first install (will fail on fetch — that's fine for mutex test)
      const promise1 = service.install();
      // Start second install immediately — should get "already in progress"
      const promise2 = service.install();

      await Promise.allSettled([promise1, promise2]);

      // Second call should send "already in progress" error
      const progressCalls = mockWindow.webContents.send.mock.calls;
      const errorCalls = progressCalls.filter(
        (call: unknown[]) =>
          (call[0] as string) === 'cliInstaller:progress' &&
          (call[1] as { type: string; error?: string }).type === 'error' &&
          (call[1] as { type: string; error?: string }).error?.includes('already in progress')
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('resets mutex after install completes (even on failure)', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // First install will fail (no network mock)
      await service.install();

      // After failure, mutex should be released — second install should start checking
      mockWindow.webContents.send.mockClear();
      await service.install();

      const checkingCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string) === 'cliInstaller:progress' &&
          (call[1] as { type: string }).type === 'checking'
      );
      expect(checkingCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('setMainWindow', () => {
    it('accepts null to clear window reference', () => {
      service.setMainWindow(null);
      expect(true).toBe(true);
    });

    it('accepts a BrowserWindow instance', () => {
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);
      expect(true).toBe(true);
    });
  });

  describe('normalizeVersion', () => {
    it('extracts semver from "claude --version" output', () => {
      expect(normalizeVersion('2.1.34 (Claude Code)\n')).toBe('2.1.34');
      expect(normalizeVersion('2.1.59 (Claude Code)')).toBe('2.1.59');
    });

    it('handles plain version strings', () => {
      expect(normalizeVersion('2.1.59')).toBe('2.1.59');
      expect(normalizeVersion('  2.1.59  ')).toBe('2.1.59');
    });

    it('strips v prefix', () => {
      expect(normalizeVersion('v2.1.59')).toBe('2.1.59');
      expect(normalizeVersion('v2.1.59\n')).toBe('2.1.59');
    });

    it('returns trimmed input when no semver found', () => {
      expect(normalizeVersion('unknown')).toBe('unknown');
      expect(normalizeVersion('  beta  ')).toBe('beta');
    });
  });

  describe('isVersionOlder', () => {
    it('returns true when installed is older', () => {
      expect(isVersionOlder('2.1.34', '2.1.59')).toBe(true);
      expect(isVersionOlder('1.0.0', '2.0.0')).toBe(true);
      expect(isVersionOlder('2.0.0', '2.1.0')).toBe(true);
      expect(isVersionOlder('2.1.0', '2.1.1')).toBe(true);
    });

    it('returns false when versions are equal', () => {
      expect(isVersionOlder('2.1.59', '2.1.59')).toBe(false);
      expect(isVersionOlder('1.0.0', '1.0.0')).toBe(false);
    });

    it('returns false when installed is newer', () => {
      expect(isVersionOlder('2.1.59', '2.1.34')).toBe(false);
      expect(isVersionOlder('3.0.0', '2.9.99')).toBe(false);
      expect(isVersionOlder('2.2.0', '2.1.59')).toBe(false);
    });

    it('handles numeric comparison correctly (not lexicographic)', () => {
      // "2.10.0" > "2.9.0" numerically (but "10" < "9" lexicographically)
      expect(isVersionOlder('2.9.0', '2.10.0')).toBe(true);
      expect(isVersionOlder('2.10.0', '2.9.0')).toBe(false);
    });

    it('handles different segment counts', () => {
      expect(isVersionOlder('2.1', '2.1.1')).toBe(true);
      expect(isVersionOlder('2.1.1', '2.1')).toBe(false);
      expect(isVersionOlder('2.1', '2.1.0')).toBe(false); // 2.1 == 2.1.0
    });
  });

  describe('getStatus timeout', () => {
    it('returns partial result when gatherStatus hangs', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      // ClaudeBinaryResolver.resolve() never settles — simulates thread pool exhaustion
      vi.mocked(ClaudeBinaryResolver.resolve).mockReturnValue(new Promise(() => {}));

      const statusPromise = service.getStatus();

      // Advance past GET_STATUS_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Should return the default (partial) result — not hang forever
      expect(status.installed).toBe(false);
      expect(status.installedVersion).toBeNull();
      expect(status.binaryPath).toBeNull();

      vi.useRealTimers();
    });

    it('returns full result when gatherStatus completes before timeout', async () => {
      allowConsoleLogs();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0 (Claude Code)', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"api_key"}',
          stderr: '',
        });

      const status = await service.getStatus();

      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.5.0');
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('api_key');
    });
  });

  describe('auth parallelism', () => {
    let httpsGet: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Reset execCli mock queue (clearAllMocks doesn't clear mockResolvedValueOnce queue)
      vi.mocked(execCli).mockReset();
      vi.mocked(execCli).mockRejectedValue(new Error('execCli not configured'));

      // Get reference to the mocked https.get for per-test control
      const httpsModule = await import('https');
      httpsGet = vi.mocked(httpsModule.default.get);
    });

    afterEach(() => {
      // Reset https.get so it doesn't leak into subsequent test groups
      httpsGet.mockReset();
      vi.useRealTimers();
    });

    it('auth is not blocked by slow GCS fetch', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version resolves immediately, auth resolves immediately
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0 (Claude Code)', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"api_key"}',
          stderr: '',
        });

      // GCS never responds — simulates slow/hanging network.
      // Returns proper req-like object so httpsGetFollowRedirects doesn't crash,
      // but never fires the response callback.
      httpsGet.mockImplementation(() => ({
        setTimeout: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
      }));

      const statusPromise = service.getStatus();

      // Advance past GET_STATUS_TIMEOUT_MS (30s) — GCS still hanging,
      // but auth already wrote its result to `r` directly
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Auth succeeded even though GCS is hanging
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('api_key');
      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.5.0');
    });

    it('auth retry works when first attempt fails', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version ok, auth attempt 1 fails, auth attempt 2 succeeds
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0', stderr: '' })
        .mockRejectedValueOnce(new Error('ENOENT stale lock'))
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"oauth"}',
          stderr: '',
        });

      const statusPromise = service.getStatus();

      // Advance past retry delay (1.5s) + auth timeout + outer timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('oauth');
    });

    it('auth times out independently when both attempts hang', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version ok, auth hangs forever (never resolves)
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0', stderr: '' })
        .mockReturnValue(new Promise(() => {}));

      const statusPromise = service.getStatus();

      // Advance past AUTH_TOTAL_TIMEOUT_MS (15s) and GET_STATUS_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Auth timed out independently → stays false
      expect(status.authLoggedIn).toBe(false);
      expect(status.authMethod).toBeNull();
      // Version was populated before auth started
      expect(status.installedVersion).toBe('2.5.0');
    });
  });

  describe('sendProgress with destroyed window', () => {
    it('does not throw when window is destroyed', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => true,
        webContents: { send: vi.fn(), isDestroyed: () => true },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // install() triggers sendProgress — should not throw even with destroyed window
      await service.install();

      // send should NOT have been called because window is destroyed
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
