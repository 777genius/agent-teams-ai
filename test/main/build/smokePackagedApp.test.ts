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
  isUnexpectedLeaderExit(
    exit: { code: number | null; signal: string | null; beforeCleanup: boolean } | null,
    platform: string
  ): boolean;
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
const {
  getInternalStorageVerificationError,
  terminateChild,
  waitForProcessClose,
  isUnexpectedLeaderExit,
} = smokePackagedAppInternals;

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
  it('rejects a fatal POSIX exit without misclassifying forced Windows cleanup', () => {
    expect(
      isUnexpectedLeaderExit({ code: null, signal: 'SIGILL', beforeCleanup: false }, 'linux')
    ).toBe(true);
    expect(
      isUnexpectedLeaderExit({ code: 1, signal: null, beforeCleanup: false }, 'win32')
    ).toBe(false);
    expect(
      isUnexpectedLeaderExit({ code: 1, signal: null, beforeCleanup: true }, 'win32')
    ).toBe(true);
  });

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

  it.each(['normal', 'retained-pipes', 'already-exited', 'silent-descendant', 'delayed-kill'])(
    'closes %s fixture and lets its Node harness exit',
    (mode) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-process-TEST-'));
      try {
        const output = execFileSync(process.execPath, [fixturePath, mode, scriptPath], {
          cwd: sandbox,
          encoding: 'utf8',
          timeout: 8_000,
        });
        expect(output).toContain('cleanup verified: close=true');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );

  it.each([
    'success',
    'early-exit',
    'timeout',
    'failure-pattern',
    'renderer-crash',
    'failure-and-cleanup-error',
  ])('cleans inherited pipes on the full harness %s path', (mode) => {
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
            if (['success', 'renderer-crash'].includes(${JSON.stringify(mode)})) console.log('renderer did-finish-load');
            if (${JSON.stringify(mode)} === 'renderer-crash') {
              setTimeout(() => console.error('Renderer process gone: crashed'), 100);
            }
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
        timeout: 8_000,
        env: {
          ...process.env,
          TMPDIR: sandbox,
          PACKAGED_SMOKE_TIMEOUT_MS: '2000',
          PACKAGED_SMOKE_STABLE_MS: mode === 'renderer-crash' ? '400' : '0',
          PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '2000',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === 'success' ? 0 : 1);
      const failureReasons: Record<string, string> = {
        'early-exit': 'Packaged app exited before startup completed: code=2',
        timeout: 'Timed out after 2000ms waiting for packaged startup',
        'failure-pattern': 'Detected startup failure pattern',
        'renderer-crash': 'Detected startup failure pattern',
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
  });

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
        timeout: 8_000,
        env: { ...process.env, PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '2000' },
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

describe.skipIf(process.platform === 'win32')('packaged smoke child isolation', () => {
  // A poisoned inherited root or preload must fail before the fake package can
  // produce the same readiness/storage or MCP handshake consumed in production.
  it.each([
    ['App', 'valid'],
    ['App', 'invalid'],
    ['Mcp', 'valid'],
    ['Mcp', 'invalid'],
  ])(
    'isolates the %s child with a %s contract and removes its sandbox after close',
    (kind, contract) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-isolation-TEST-'));
      try {
        const poison = path.join(sandbox, 'inherited-TEST');
        fs.mkdirSync(poison);
        const evidence = path.join(sandbox, 'evidence.json');
        const preloadMarker = path.join(sandbox, 'preload-ran');
        const preload = path.join(sandbox, 'preload-TEST.cjs');
        fs.writeFileSync(
          preload,
          `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');`
        );
        // Poison after the harness Node has started, so its own startup is safe.
        const hook = path.join(sandbox, 'poison-env-TEST.cjs');
        fs.writeFileSync(
          hook,
          `Object.assign(process.env, ${JSON.stringify({
            HOME: poison,
            USERPROFILE: poison,
            CLAUDE_CONFIG_DIR: poison,
            AGENT_TEAMS_ELECTRON_USER_DATA_DIR: poison,
            AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: poison,
            AGENT_TEAMS_MCP_CLAUDE_DIR: poison,
            AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: `--require ${preload}`,
            Node_Options: `--require ${preload}`,
            Electron_Run_As_Node: '1',
            Agent_Teams_Electron_User_Data_Dir: poison,
            Agent_Teams_Electron_Claude_Root: poison,
            Agent_Teams_Mcp_Claude_Dir: poison,
            Claude_Config_Dir: poison,
          })});`
        );
        const resources = path.join(sandbox, 'resources', 'mcp-server');
        fs.mkdirSync(resources, { recursive: true });
        fs.writeFileSync(path.join(resources, 'index.js'), '// TEST server placeholder');
        fs.writeFileSync(
          path.join(sandbox, 'agent-teams-ai'),
          `#!${process.execPath}
        const fs = require('node:fs');
        const path = require('node:path');
        const assert = require('node:assert/strict');
        const root = process.cwd();
        try {
          assert.notEqual(root, fs.realpathSync(${JSON.stringify(sandbox)}), 'cwd must be fresh TEST sandbox');
          for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR',
            'AGENT_TEAMS_ELECTRON_USER_DATA_DIR', 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
            'AGENT_TEAMS_MCP_CLAUDE_DIR']) {
            const resolved = fs.realpathSync(process.env[key]);
            const relative = path.relative(root, resolved);
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), key + ' must stay inside sandbox');
            assert.ok(fs.statSync(resolved).isDirectory(), key + ' directory must exist');
          }
          assert.ok(fs.existsSync(path.join(root, '.test-only')), 'explicit TEST marker');
          assert.equal(process.env.HOME, process.env.USERPROFILE);
          assert.equal(process.env.CLAUDE_CONFIG_DIR, process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT);
          assert.equal(process.env.CLAUDE_CONFIG_DIR, process.env.AGENT_TEAMS_MCP_CLAUDE_DIR);
          assert.equal(process.env.PATH, ${JSON.stringify(process.env.PATH)}, 'preserve executable search path');
          for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR',
            'AGENT_TEAMS_ELECTRON_USER_DATA_DIR', 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
            'AGENT_TEAMS_MCP_CLAUDE_DIR', 'AGENT_TEAMS_MCP_TRANSPORT']) {
            assert.deepEqual(Object.keys(process.env).filter(name => name.toUpperCase() === key), [key], key + ' must have no case aliases');
          }
          assert.deepEqual(Object.keys(process.env).filter(key => key.toUpperCase() === 'NODE_OPTIONS'), [], 'no inherited preloads regardless of case');
          assert.deepEqual(Object.keys(process.env).filter(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), ${kind === 'Mcp' ? "['ELECTRON_RUN_AS_NODE']" : '[]'}, 'no inherited run-as-node aliases');
          assert.equal(process.env.ELECTRON_RUN_AS_NODE, ${kind === 'Mcp' ? "'1'" : 'undefined'});
          assert.equal(process.env.AGENT_TEAMS_MCP_TRANSPORT, 'stdio');
          fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ root }));
        } catch (error) { console.error('TEST isolation failure: ' + error.message); process.exit(9); }
        if (${JSON.stringify(kind)} === 'App') {
          const userData = process.argv.find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
          assert.equal(userData, process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR);
          fs.mkdirSync(path.join(userData, 'storage'));
          fs.writeFileSync(path.join(userData, 'storage/app.db'), Buffer.from(${contract === 'valid' ? "'SQLite format 3\\0'" : "'TEST invalid storage'"}));
          console.log('renderer did-finish-load');
          setInterval(() => {}, 1000);
        } else {
          require('node:readline').createInterface({input: process.stdin}).on('line', line => {
            const request = JSON.parse(line);
            if (!request.id) return;
            const result = request.method === 'initialize'
              ? { protocolVersion: '2024-11-05' }
              : { tools: ${contract === 'valid' ? "[{ name: 'TEST-only-tool' }]" : '[]'} };
            console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
          });
        }
      `,
          { mode: 0o755 }
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TMPDIR: sandbox,
          PACKAGED_SMOKE_TIMEOUT_MS: '2000',
          PACKAGED_SMOKE_STABLE_MS: '0',
          PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '2000',
        };
        delete env.NODE_OPTIONS;
        const script = path.resolve(
          import.meta.dirname,
          `../../../scripts/electron-builder/smokePackaged${kind}.cjs`
        );
        const result = spawnSync(process.execPath, ['--require', hook, script, sandbox, 'linux'], {
          cwd: sandbox,
          env,
          encoding: 'utf8',
          timeout: 8_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.stdout + result.stderr).not.toContain('TEST isolation failure');
        expect(result.status).toBe(contract === 'valid' ? 0 : 1);
        expect(result.stdout.includes(`[smokePackaged${kind}] OK`)).toBe(contract === 'valid');
        if (contract === 'invalid') {
          expect(result.stderr).toContain(
            kind === 'App' ? 'invalid SQLite header' : 'tools/list failed'
          );
        }
        const { root } = JSON.parse(fs.readFileSync(evidence, 'utf8')) as { root: string };
        expect(fs.existsSync(root)).toBe(false);
        expect(fs.existsSync(preloadMarker)).toBe(false);
        expect(fs.readdirSync(poison)).toEqual([]);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );
});
