// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface SmokePackagedAppInternals {
  getInternalStorageVerificationError(userDataDir: string, log: string): string | null;
  terminateChild(
    child: { pid?: number; exitCode: number | null; signalCode: string | null; kill: () => void },
    closePromise: Promise<unknown>,
    platform: string
  ): Promise<void>;
  waitForProcessClose(closePromise: Promise<unknown>, timeoutMs: number): Promise<boolean>;
}

interface SmokePackagedAppModule {
  default?: { _internal?: SmokePackagedAppInternals };
  _internal?: SmokePackagedAppInternals;
}

const requireFromTest: (id: string) => unknown = createRequire(import.meta.url);
const smokePackagedApp = requireFromTest(
  '../../../scripts/electron-builder/smokePackagedApp.cjs'
) as SmokePackagedAppModule;
const smokePackagedAppInternals = smokePackagedApp._internal ?? smokePackagedApp.default?._internal;
if (!smokePackagedAppInternals) {
  throw new Error('smokePackagedApp internals were not exported');
}
const { getInternalStorageVerificationError, terminateChild, waitForProcessClose } =
  smokePackagedAppInternals;

describe('smokePackagedApp internal storage verification', () => {
  it('accepts an app.db file with the SQLite format header', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-storage-test-'));
    try {
      const storageDir = path.join(userDataDir, 'storage');
      fs.mkdirSync(storageDir);
      fs.writeFileSync(path.join(storageDir, 'app.db'), Buffer.from('SQLite format 3\0payload'));

      expect(getInternalStorageVerificationError(userDataDir, 'renderer did-finish-load')).toBe(
        null
      );
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('rejects a missing app.db file', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-storage-test-'));
    try {
      expect(getInternalStorageVerificationError(userDataDir, '')).toContain(
        'SQLite database was not created'
      );
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('rejects a file without the SQLite format header', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-storage-test-'));
    try {
      const storageDir = path.join(userDataDir, 'storage');
      fs.mkdirSync(storageDir);
      fs.writeFileSync(path.join(storageDir, 'app.db'), 'not sqlite');

      expect(getInternalStorageVerificationError(userDataDir, '')).toContain(
        'invalid SQLite header'
      );
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('rejects the internal-storage JSON fallback warning even with a valid database', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-storage-test-'));
    try {
      const storageDir = path.join(userDataDir, 'storage');
      fs.mkdirSync(storageDir);
      fs.writeFileSync(path.join(storageDir, 'app.db'), Buffer.from('SQLite format 3\0payload'));

      expect(
        getInternalStorageVerificationError(
          userDataDir,
          'internal-storage sqlite backend unavailable; falling back to JSON stores for this session'
        )
      ).toBe('Detected internal-storage SQLite fallback warning');
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe('smokePackagedApp shutdown handling', () => {
  it('reports successful process closure before the timeout', async () => {
    let resolveExit!: (value: unknown) => void;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const closed = waitForProcessClose(exitPromise, 1_000);
    resolveExit({ code: 0, signal: null });

    await expect(closed).resolves.toBe(true);
  });

  it('reports shutdown timeout instead of treating it as success', async () => {
    vi.useFakeTimers();
    try {
      const exitPromise = new Promise(() => undefined);
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = {
        pid: 12345,
        exitCode: 0,
        signalCode: null,
        kill: vi.fn(),
      };

      const termination = terminateChild(child, exitPromise, 'linux');
      const rejection = expect(termination).rejects.toThrow('Timed out after 5000ms');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
      expect(signal).toHaveBeenCalledTimes(2);
      expect(signal).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
      expect(signal).toHaveBeenNthCalledWith(2, -12345, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe.skipIf(process.platform === 'win32')('smokePackagedApp POSIX process cleanup', () => {
  const scriptPath = path.resolve(
    import.meta.dirname,
    '../../../scripts/electron-builder/smokePackagedApp.cjs'
  );
  const fixturePath = path.resolve(import.meta.dirname, 'fixtures/packaged-smoke-process-TEST.cjs');

  it.each(['normal', 'retained-pipes', 'already-exited', 'silent-descendant'])(
    'closes %s fixture and lets its Node harness exit',
    (mode) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-process-TEST-'));
      try {
        const output = execFileSync(process.execPath, [fixturePath, mode, scriptPath], {
          cwd: sandbox,
          encoding: 'utf8',
          timeout: 4_000,
        });
        expect(output).toContain('cleanup verified: close=true');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );

  it.each(['success', 'early-exit', 'timeout', 'failure-pattern', 'failure-and-cleanup-error'])(
    'cleans inherited pipes on the full harness %s path',
    (mode) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-harness-TEST-'));
      try {
        const fixtureSource = `#!${process.execPath}
          const fs = require('node:fs');
          const path = require('node:path');
          const userDataDir = process.argv.find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
          fs.mkdirSync(path.join(userDataDir, 'storage'));
          fs.writeFileSync(path.join(userDataDir, 'storage/app.db'), Buffer.from('SQLite format 3\\0'));
          const child = require('node:child_process').spawn(process.execPath, ['-e',
            "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(1), 6000); process.send('ready'); process.disconnect();"
          ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
          child.once('message', () => {
            if (${JSON.stringify(mode)} === 'early-exit') process.exit(2);
            if (${JSON.stringify(mode)} === 'success') console.log('renderer did-finish-load');
            if (${JSON.stringify(mode)}.startsWith('failure-')) console.log('MODULE_NOT_FOUND');
          });
          setTimeout(() => process.exit(1), 6000);
        `;
        fs.writeFileSync(path.join(sandbox, 'agent-teams-ai'), fixtureSource, { mode: 0o755 });
        const nodeArgs = [scriptPath, sandbox, 'linux'];
        if (mode === 'failure-and-cleanup-error') {
          const hookPath = path.join(sandbox, 'cleanup-error-TEST.cjs');
          fs.writeFileSync(
            hookPath,
            `
            const kill = process.kill;
            process.kill = function(pid, signal) {
              const result = kill.call(this, pid, signal);
              // Deliver the real owned-group cleanup before injecting a diagnostic failure.
              if (signal === 'SIGKILL') throw new Error('TEST cleanup failure');
              return result;
            };
          `
          );
          nodeArgs.unshift('--require', hookPath);
        }
        const result = spawnSync(process.execPath, nodeArgs, {
          cwd: sandbox,
          encoding: 'utf8',
          timeout: 5_000,
          env: {
            ...process.env,
            TMPDIR: sandbox,
            PACKAGED_SMOKE_TIMEOUT_MS: '2000',
            PACKAGED_SMOKE_STABLE_MS: '0',
            PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '100',
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(mode === 'success' ? 0 : 1);
        const failureReasons: Record<string, string> = {
          'early-exit': 'Packaged app exited before startup completed: code=2',
          timeout: 'Timed out after 2000ms waiting for packaged startup',
          'failure-pattern': 'Detected startup failure pattern',
          'failure-and-cleanup-error': 'Detected startup failure pattern',
        };
        if (mode !== 'success') expect(result.stderr).toContain(failureReasons[mode]);
        if (mode === 'failure-and-cleanup-error') {
          expect(result.stderr).toContain('TEST cleanup failure');
        } else {
          expect(result.stdout).toContain('stdio closed');
        }
        expect(result.stdout.includes('[smokePackagedApp] OK')).toBe(mode === 'success');
        if (mode === 'success') {
          expect(result.stdout.indexOf('stdio closed')).toBeLessThan(
            result.stdout.indexOf('[smokePackagedApp] OK')
          );
        }
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );

  it('reports a failed executable spawn through cleanup without claiming success', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-spawn-TEST-'));
    try {
      fs.writeFileSync(
        path.join(sandbox, 'agent-teams-ai'),
        '#!/nonexistent-packaged-smoke-TEST-interpreter\n',
        { mode: 0o755 }
      );
      const result = spawnSync(process.execPath, [scriptPath, sandbox, 'linux'], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 4_000,
        env: { ...process.env, PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '100' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ENOENT');
      expect(result.stdout).toContain('stdio closed');
      expect(result.stdout).not.toContain('[smokePackagedApp] OK');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
