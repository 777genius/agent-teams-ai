// @vitest-environment node

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface StopChildOptions {
  platform?: string;
  killProcessTree?: (pid: number) => Promise<void>;
  closeGraceMs?: number;
  forceCloseGraceMs?: number;
}

interface OpenCodeLivePreflightTestHooks {
  __opencodeLivePreflightTestHooks: {
    stopChild(child: FakeChild, options?: StopChildOptions): Promise<void>;
    taskkillProcessTree(pid: number): Promise<void>;
  };
}

const runOnPosix = process.platform === 'win32' ? it.skip : it;

describe('opencode live preflight cleanup', () => {
  let tempDir = '';
  const originalSystemRoot = process.env.SystemRoot;
  const originalTaskkillArgsPath = process.env.FAKE_TASKKILL_ARGS_PATH;

  afterEach(async () => {
    restoreEnvValue('SystemRoot', originalSystemRoot);
    restoreEnvValue('FAKE_TASKKILL_ARGS_PATH', originalTaskkillArgsPath);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('waits for child close after Windows process-tree cleanup', async () => {
    const { stopChild } = (await loadTestHooks()).__opencodeLivePreflightTestHooks;
    const child = new FakeChild({ pid: 1234 });
    const killProcessTree = vi.fn(() => {
      child.signalCode = 'SIGTERM';
      child.emit('close');
      return Promise.resolve();
    });

    await stopChild(child, {
      closeGraceMs: 5,
      forceCloseGraceMs: 5,
      killProcessTree,
      platform: 'win32',
    });

    expect(killProcessTree).toHaveBeenCalledWith(1234);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('detaches pipes when Windows process-tree cleanup and direct kill both fail to close', async () => {
    const { stopChild } = (await loadTestHooks()).__opencodeLivePreflightTestHooks;
    const child = new FakeChild({ pid: 5678 });
    const killProcessTree = vi.fn(() => Promise.resolve());

    await stopChild(child, {
      closeGraceMs: 1,
      forceCloseGraceMs: 1,
      killProcessTree,
      platform: 'win32',
    });

    expect(killProcessTree).toHaveBeenCalledWith(5678);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  runOnPosix('invokes taskkill.exe with process-tree flags', async () => {
    const { taskkillProcessTree } = (await loadTestHooks()).__opencodeLivePreflightTestHooks;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-taskkill-test-'));
    const system32Dir = path.join(tempDir, 'System32');
    const taskkillArgsPath = path.join(tempDir, 'taskkill-args.txt');

    await fs.mkdir(system32Dir, { recursive: true });
    await writeExecutable(path.join(system32Dir, 'taskkill.exe'), fakeTaskkillScript());
    process.env.SystemRoot = tempDir;
    process.env.FAKE_TASKKILL_ARGS_PATH = taskkillArgsPath;

    await taskkillProcessTree(4242);

    await expect(fs.readFile(taskkillArgsPath, 'utf8')).resolves.toBe('/T /F /PID 4242\n');
  });
});

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly stderr = { destroy: vi.fn() };
  readonly stdout = { destroy: vi.fn() };
  readonly unref = vi.fn();
  exitCode: number | null = null;
  killed = false;
  pid: number;
  signalCode: string | null = null;

  constructor(input: { pid: number }) {
    super();
    this.pid = input.pid;
    this.kill.mockImplementation((signal: string) => {
      this.killed = true;
      return signal === 'SIGKILL';
    });
  }
}

async function loadTestHooks(): Promise<OpenCodeLivePreflightTestHooks> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/lib/opencode-live-preflight.mjs')
  ).href;
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as OpenCodeLivePreflightTestHooks;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf8');
  // eslint-disable-next-line sonarjs/file-permissions -- The taskkill fixture must be executable for child_process.spawn.
  await fs.chmod(filePath, 0o755);
}

function fakeTaskkillScript(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');

fs.writeFileSync(process.env.FAKE_TASKKILL_ARGS_PATH, process.argv.slice(2).join(' ') + '\\n');
process.exit(0);
`;
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
