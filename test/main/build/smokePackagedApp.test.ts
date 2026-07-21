// @vitest-environment node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface SmokePackagedAppInternals {
  getInternalStorageVerificationError(userDataDir: string, log: string): string | null;
  terminateChild(
    child: { exitCode: number | null; signalCode: string | null; kill: () => void },
    exitPromise: Promise<unknown>,
    platform: string
  ): Promise<void>;
  waitForProcessClose(
    child: { exitCode: number | null; signalCode: string | null },
    exitPromise: Promise<unknown>,
    timeoutMs: number
  ): Promise<boolean>;
}

interface SmokePackagedAppModule {
  default?: { _internal?: SmokePackagedAppInternals };
  _internal?: SmokePackagedAppInternals;
}

const requireFromTest: (id: string) => unknown = createRequire(import.meta.url);
const smokePackagedApp = requireFromTest(
  '../../../scripts/electron-builder/smokePackagedApp.cjs'
) as SmokePackagedAppModule;
const smokePackagedAppInternals =
  smokePackagedApp._internal ?? smokePackagedApp.default?._internal;
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
    const child = { exitCode: null, signalCode: null };

    const closed = waitForProcessClose(child, exitPromise, 1_000);
    resolveExit({ code: 0, signal: null });

    await expect(closed).resolves.toBe(true);
  });

  it('reports shutdown timeout instead of treating it as success', async () => {
    vi.useFakeTimers();
    try {
      const exitPromise = new Promise(() => undefined);
      const child = {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      };

      const termination = terminateChild(child, exitPromise, 'linux');
      const rejection = expect(termination).rejects.toThrow('Timed out after 5000ms');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenNthCalledWith(1);
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
