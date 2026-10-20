// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DefaultProcessLedger } from '../../../scripts/e2e/anthropic-compatible-status/packaged-default-processes.ts';
import {
  assertNaturalPtyResult,
  containedDirectory,
  containedFile,
  deliveryIdentity,
  nativeTargets,
  provePty,
  runtimeEnvironment,
  serverIdentity,
  stagedFile,
} from '../../../scripts/electron-builder/smokePackagedRuntime.ts';

// These are assertion/containment fixtures. Real native execution is mandatory
// in the five-platform packaged pipeline and cannot be proven by these files.
function fixture(run: (root: string) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-smoke-TEST-')));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('bundled runtime smoke contract', () => {
  it('refuses a previously observed live child before any success-finalization signal', async () => {
    vi.useFakeTimers();
    const ledger = new DefaultProcessLedger();
    const known = { pid: 2147483647, parent: 1, birth: '2026-10-20T00:00:00.000Z' };
    ledger.observed.set(`${known.pid}:${known.birth}`, known);
    let signalled = false;
    const census = vi.spyOn(ledger, 'sample').mockImplementation(() => (signalled ? [] : [known]));
    // Test-only view of the retained identity signal method; no OS/PID operation.
    const signal = vi
      .spyOn(ledger as unknown as { signal(identity: typeof known): void }, 'signal')
      .mockImplementation(() => {
        signalled = true;
      });
    try {
      const refused = expect(ledger.stop({ requireQuiet: true })).rejects.toThrow(
        'Owned processes did not settle naturally'
      );
      void refused.catch(() => {});
      await vi.runAllTimersAsync();
      await refused;
      expect(census).toHaveBeenCalledTimes(1);
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
      census.mockRestore();
      vi.useRealTimers();
    }
  });
  it('keeps the canonical runtime directory inside its enclosing bundle', () =>
    fixture((root) => {
      const bundle = path.join(root, 'bundle'),
        outside = path.join(root, 'outside');
      fs.mkdirSync(path.join(bundle, 'resources/runtime'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'runtime'), { recursive: true });
      expect(containedDirectory(bundle, path.join(bundle, 'resources/runtime'))).toBe(
        path.join(bundle, 'resources/runtime')
      );
      fs.rmSync(path.join(bundle, 'resources'), { recursive: true });
      fs.symlinkSync(
        outside,
        path.join(bundle, 'resources'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      expect(() => containedDirectory(bundle, path.join(bundle, 'resources/runtime'))).toThrow(
        'escaped its root'
      );
    }));
  it('binds retained bundled bytes to staged bytes and rejects changes', () =>
    fixture((root) => {
      const bundled = path.join(root, 'bundled'),
        staged = path.join(root, 'staged');
      fs.mkdirSync(bundled);
      fs.mkdirSync(staged);
      fs.writeFileSync(path.join(bundled, 'bun'), 'fixture bytes');
      fs.writeFileSync(path.join(staged, 'bun'), 'fixture bytes');
      expect(stagedFile(bundled, staged, 'bun').sha256).toMatch(/^[a-f0-9]{64}$/);
      fs.writeFileSync(path.join(bundled, 'bun'), 'changed bytes');
      expect(() => stagedFile(bundled, staged, 'bun')).toThrow('differs from staged bytes');
    }));

  it('rejects outside files, symlink leaves and symlink ancestor escapes', () =>
    fixture((root) => {
      const runtime = path.join(root, 'runtime'),
        outside = path.join(root, 'outside');
      fs.mkdirSync(runtime);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'entry'), 'outside fixture');
      expect(() => containedFile(runtime, path.join(outside, 'entry'))).toThrow('escaped its root');
      if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(outside, 'entry'), path.join(runtime, 'leaf'));
        fs.symlinkSync(outside, path.join(runtime, 'directory'));
        expect(() => containedFile(runtime, path.join(runtime, 'leaf'))).toThrow('not regular');
        expect(() => containedFile(runtime, path.join(runtime, 'directory/entry'))).toThrow(
          'escaped its root'
        );
      }
    }));

  it('uses the original package name for the floor alias and rejects graph substitution', () =>
    fixture((root) => {
      const floor = path.join(root, 'node_modules/@opencode/server-v2-floor');
      fs.mkdirSync(floor, { recursive: true });
      fs.writeFileSync(path.join(floor, 'process.js'), '// fixture entry');
      fs.writeFileSync(
        path.join(floor, 'package.json'),
        JSON.stringify({ name: '@opencode/server', version: '2.0.0' })
      );
      expect(
        serverIdentity(path.join(floor, 'process.js'), '@opencode/server-v2-floor', root).version
      ).toBe('2.0.0');
      expect(() =>
        serverIdentity(path.join(floor, 'process.js'), '@opencode/server', root)
      ).toThrow('Wrong server graph version');
      fs.writeFileSync(
        path.join(floor, 'package.json'),
        JSON.stringify({ name: '@opencode/server-v2-floor', version: '2.0.0' })
      );
      expect(() =>
        serverIdentity(path.join(floor, 'process.js'), '@opencode/server-v2-floor', root)
      ).toThrow('Unexpected package context');
    }));

  it('matches declared platform, architecture, pinned Bun and both physical digests', () => {
    const bun = 'a'.repeat(64),
      entry = 'b'.repeat(64);
    const value = {
      schema: 1,
      platform: 'win32',
      arch: 'arm64',
      bunVersion: '1.4.3',
      bunSha256: bun,
      entrySha256: entry,
    };
    expect(deliveryIdentity(value, 'win32', 'arm64', bun, entry)).toEqual(value);
    for (const patch of [
      { schema: 2 },
      { platform: 'linux' },
      { arch: 'x64' },
      { bunVersion: '1.3.11' },
      { bunSha256: entry },
      { entrySha256: bun },
    ]) {
      expect(() =>
        deliveryIdentity({ ...value, ...patch }, 'win32', 'arm64', bun, entry)
      ).toThrow();
    }
  });

  it('removes inherited hooks and native disabling overrides without changing PATH', () =>
    fixture((root) => {
      const env = runtimeEnvironment(
        {
          PATH: 'trusted-OS-fixture',
          NODE_OPTIONS: '--require poison',
          Node_Options: '--require poison',
          BUN_OPTIONS: '--preload poison',
          BUN_PTY_LIB: '/foreign/ffi',
          bun_pty_backend: 'foreign',
          MSGPACKR_NATIVE_ACCELERATION_DISABLED: '1',
          HOME: '/foreign/home',
          Home: '/foreign/home',
          TEMP: '/foreign/tmp',
          Electron_Run_As_Node: '1',
        },
        root
      );
      expect(env.PATH).toBe('trusted-OS-fixture');
      expect(env.HOME).toBe(root);
      expect(env.USERPROFILE).toBe(root);
      expect(env.TEMP).toBe(path.join(root, 'tmp'));
      expect(
        Object.keys(env).filter(
          (key) =>
            [
              'NODE_OPTIONS',
              'BUN_OPTIONS',
              'MSGPACKR_NATIVE_ACCELERATION_DISABLED',
              'ELECTRON_RUN_AS_NODE',
            ].includes(key.toUpperCase()) || key.toUpperCase().startsWith('BUN_PTY_')
        )
      ).toEqual([]);
      expect(Object.keys(env).filter((key) => key.toUpperCase() === 'HOME')).toEqual(['HOME']);
    }));

  it('does not count a timeout kill synthetic exit0, signal, missing marker or surviving child as success', () => {
    const natural = {
      output: 'owned-marker\r\n',
      marker: 'owned-marker',
      exitCode: 0,
      forcedCleanup: false,
      childGone: true,
    };
    expect(() => assertNaturalPtyResult(natural)).not.toThrow();
    for (const patch of [
      { forcedCleanup: true },
      { signal: 'SIGTERM' },
      { exitCode: 1 },
      { output: '' },
      { childGone: false },
    ]) {
      expect(() => assertNaturalPtyResult({ ...natural, ...patch })).toThrow();
    }
  });

  it('requires the independently verified ARM DLL instead of the x64 DLL', () => {
    expect(nativeTargets['win32-arm64']).toEqual({
      file: 'rust_pty_arm64.dll',
      sha256: '80c44d8cb5123b95494fdb785fe7e2716a5c1f9a57c5d890e469ffc046bddb98',
    });
    expect(nativeTargets['win32-arm64'].sha256).not.toBe(nativeTargets['win32-x64'].sha256);
    expect(Object.keys(nativeTargets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
  });

  it('releases a retired handle only after natural evidence and listener disposal', async () => {
    let dataDisposed = false,
      exitDisposed = false,
      naturalExit = false,
      released = false;
    const adapter = {
      spawn: (_file: string, args: string[]) => ({
        pid: 2147483647, // Assertion-only fake; no native process is represented.
        onData: (listener: (data: string) => void) => {
          const marker = args.join(' ').match(/owned-runtime-pty-[a-f0-9-]+/)![0];
          queueMicrotask(() => listener(marker));
          return {
            dispose: () => {
              dataDisposed = true;
            },
          };
        },
        onExit: (listener: (event: { exitCode: number }) => void) => {
          queueMicrotask(() => {
            naturalExit = true;
            listener({ exitCode: 0 });
          });
          return {
            dispose: () => {
              exitDisposed = true;
            },
          };
        },
        kill: () => {
          expect(naturalExit && dataDisposed && exitDisposed).toBe(true);
          released = true;
        },
      }),
    };
    const result = await provePty(adapter, os.tmpdir());
    expect(result.forcedCleanup).toBe(false);
    expect(result.postNaturalRelease).toBe(true);
    expect(released).toBe(true);
  });

  it('cannot qualify a synthetic kill exit0 after the natural deadline', async () => {
    vi.useFakeTimers();
    let killed = false,
      exit: ((event: { exitCode: number; signal?: string }) => void) | undefined;
    try {
      const pending = provePty(
        {
          spawn: () => ({
            pid: 2147483647,
            onData: () => ({ dispose() {} }),
            onExit: (listener) => {
              exit = listener;
              return { dispose() {} };
            },
            kill: () => {
              killed = true;
              exit?.({ exitCode: 0, signal: 'SIGTERM' });
            },
          }),
        },
        os.tmpdir()
      );
      const rejected = expect(pending).rejects.toThrow('PTY natural exit timed out');
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects excess PTY data arriving after natural exit while PID retirement is awaited', async () => {
    let data: ((chunk: string) => void) | undefined;
    const pending = provePty(
      {
        spawn: (_file, args) => ({
          pid: 2147483647,
          onData: (listener) => {
            data = listener;
            const marker = args.join(' ').match(/owned-runtime-pty-[a-f0-9-]+/)![0];
            queueMicrotask(() => listener(marker));
            return { dispose() {} };
          },
          onExit: (listener) => {
            queueMicrotask(() => {
              listener({ exitCode: 0 });
              queueMicrotask(() => data?.('x'.repeat(65537)));
            });
            return { dispose() {} };
          },
          kill() {},
        }),
      },
      os.tmpdir()
    );
    await expect(pending).rejects.toThrow('PTY output exceeded bound');
  });
});
