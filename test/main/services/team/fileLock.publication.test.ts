// @vitest-environment node
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const appModule = path.join(root, 'src/main/services/team/fileLock.ts');
const controllerModule = path.join(root, 'agent-teams-controller/src/internal/fileLock.js');
const fixture = path.join(root, 'test/main/services/team/fixtures/fileLockProcess.cjs');
const controller = createRequire(import.meta.url)(controllerModule) as {
  withFileLockSync: typeof withFileLockSync;
};
const options = { acquireTimeoutMs: 25, retryIntervalMs: 1, staleTimeoutMs: 1 };
let dir: string;
let resource: string;
let children: ChildProcess[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file lock Unicode 雪 '));
  resource = path.join(dir, 'shared data 雪.json');
  children = [];
});
afterEach(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = exited(child);
        child.kill('SIGKILL');
        await done;
      }
    })
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
async function paused(phase: string, implementation = 'sync') {
  const control = fs.mkdtempSync(path.join(dir, 'control '));
  const child = spawn(
    process.execPath,
    [
      fixture,
      implementation === 'controller' ? controllerModule : appModule,
      resource,
      control,
      implementation,
      phase,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(control, 'paused.json'))) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(
        `Child failed to reach ${phase}: ${stderr} ${fs.existsSync(path.join(control, 'error.json')) ? fs.readFileSync(path.join(control, 'error.json'), 'utf8') : ''}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(JSON.parse(fs.readFileSync(path.join(control, 'paused.json'), 'utf8')).point).toBe(phase);
  return {
    child,
    control,
    resume: () => fs.writeFileSync(path.join(control, 'resume'), ''),
    kill: async () => {
      const done = exited(child);
      child.kill('SIGKILL');
      await done;
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    },
  };
}
function completeCanonical(phase: string) {
  const lock = `${resource}.lock`;
  if (fs.existsSync(lock))
    expect(fs.readFileSync(lock, 'utf8')).toMatch(/^\d+\n\d+\n[a-f0-9-]{36}\n$/);
  const gate = `${lock}-transition-v2`;
  if (fs.existsSync(gate)) {
    const entries = fs.readdirSync(gate);
    expect(entries).toHaveLength(
      ['gate-token-unlink-after', 'gate-rmdir-before'].includes(phase) ? 0 : 1
    );
    for (const entry of entries) {
      expect(entry).toMatch(/^owner-\d+-[a-f0-9-]{36}$/);
      expect(fs.readFileSync(path.join(gate, entry), 'utf8')).toMatch(
        /^file-lock-transition-v2\n\d+\n[a-f0-9-]{36}\n$/
      );
    }
  }
}
async function futureAcquisition() {
  const options = { acquireTimeoutMs: 2000, retryIntervalMs: 2, staleTimeoutMs: 1 };
  expect(withFileLockSync(resource, () => 'sync', options)).toBe('sync');
  expect(await withFileLock(resource, async () => 'async', options)).toBe('async');
  expect(controller.withFileLockSync(resource, () => 'controller', options)).toBe('controller');
  expect(fs.existsSync(`${resource}.lock`)).toBe(false);
  expect(fs.existsSync(`${resource}.lock-transition-v2`)).toBe(false);
}

const phases = [
  'gate-candidate-created',
  'gate-candidate-opened',
  'gate-candidate-partial',
  'gate-candidate-closed',
  'gate-publish-before',
  'gate-publish-after',
  'data-candidate-opened',
  'data-candidate-partial',
  'data-candidate-closed',
  'data-publish-before',
  'data-publish-after',
  'gate-token-unlink-before',
  'gate-token-unlink-after',
  'gate-rmdir-before',
  'gate-rmdir-after',
  'callback',
  'data-unlink-before',
  'data-unlink-after',
];

it('publishes child control records only after their complete write and close', async () => {
  const control = fs.mkdtempSync(path.join(dir, 'control records '));
  fs.writeFileSync(path.join(control, 'resume'), '');
  const records = ['entered', 'paused.json', 'error.json'];
  const observations: { record: string; visibleAtOpen: boolean; visibleDuringWrite: boolean }[] =
    [];
  const nativeRequire = createRequire(import.meta.url);
  const fixtureFs = {
    ...nativeRequire('node:fs'),
    writeFileSync: (name: string, data: string, options?: { flag?: string }) => {
      const record = records.find(
        (entry) =>
          name === path.join(control, entry) || name.startsWith(`${path.join(control, entry)}.`)
      );
      if (!record) throw new Error(`Unexpected fixture write: ${name}`);
      const canonical = path.join(control, record);
      // Observe the native open/truncate and incomplete-write windows. This
      // rejects direct canonical writes deterministically, without parse retries.
      const fd = fs.openSync(name, options?.flag ?? 'w');
      try {
        const visibleAtOpen = fs.existsSync(canonical);
        fs.writeSync(fd, data.slice(0, 1));
        observations.push({
          record,
          visibleAtOpen,
          visibleDuringWrite: fs.existsSync(canonical),
        });
        fs.writeSync(fd, data.slice(1));
      } finally {
        fs.closeSync(fd);
      }
    },
    renameSync: (from: string, to: string) => {
      // A canonical record becomes observable only with all bytes already present.
      const complete = fs.readFileSync(from, 'utf8');
      if (to.endsWith('.json')) JSON.parse(complete);
      else expect(complete).toBe('yes');
      fs.renameSync(from, to);
    },
  };
  const childProcess = {
    argv: ['', '', 'fixture-module', resource, control, 'controller', 'callback'],
    pid: process.pid,
    exitCode: 0,
  };
  await runInNewContext(fs.readFileSync(fixture, 'utf8'), {
    require: (name: string) => {
      if (name === 'node:fs') return fixtureFs;
      if (name === 'node:module') return { syncBuiltinESMExports: () => {} };
      if (name === 'fixture-module')
        return {
          withFileLockSync: (_resource: string, callback: () => void) => {
            callback();
            throw new Error('fixture failure');
          },
        };
      return nativeRequire(name);
    },
    process: childProcess,
    Buffer,
  });
  expect(observations).toEqual(
    records.map((record) => ({
      record,
      visibleAtOpen: false,
      visibleDuringWrite: false,
    }))
  );
  expect(fs.readFileSync(path.join(control, 'entered'), 'utf8')).toBe('yes');
  expect(JSON.parse(fs.readFileSync(path.join(control, 'paused.json'), 'utf8'))).toEqual({
    point: 'callback',
    pid: process.pid,
  });
  expect(JSON.parse(fs.readFileSync(path.join(control, 'error.json'), 'utf8'))).toEqual({
    message: 'fixture failure',
  });
  expect(childProcess.exitCode).toBe(1);
  expect(fs.readdirSync(control).sort()).toEqual([...records, 'resume'].sort());
});

describe.each(['sync', 'async', 'controller'])('%s process publication', (implementation) => {
  it.each(phases)('recovers after actual kill at %s, without wiping candidates', async (phase) => {
    const owner = await paused(phase, implementation);
    completeCanonical(phase);
    await owner.kill();
    await futureAcquisition();
  });
});

it.each(['data-unlink-before', 'data-unlink-after'])(
  'recovers a killed data reclaimer at %s',
  async (phase) => {
    const dead = await paused('callback');
    await dead.kill();
    const reclaimer = await paused(phase);
    await reclaimer.kill();
    await futureAcquisition();
  }
);
it.each([
  'gate-token-unlink-before',
  'gate-token-unlink-after',
  'gate-rmdir-before',
  'gate-rmdir-after',
])('recovers a killed gate reclaimer at %s', async (phase) => {
  const dead = await paused('gate-publish-after');
  await dead.kill();
  const reclaimer = await paused(phase);
  await reclaimer.kill();
  await futureAcquisition();
});

it.each(['sync', 'controller'])(
  'excludes app and controller while %s holds an aged callback',
  async (implementation) => {
    const owner = await paused('callback', implementation);
    const lock = `${resource}.lock`;
    const content = fs.readFileSync(lock, 'utf8');
    fs.writeFileSync(lock, content.replace(content.split('\n')[1], '0'));
    expect(() =>
      withFileLockSync(
        resource,
        () => {
          throw new Error('overlap');
        },
        options
      )
    ).toThrow('File lock timeout');
    expect(() =>
      controller.withFileLockSync(
        resource,
        () => {
          throw new Error('overlap');
        },
        options
      )
    ).toThrow('File lock timeout');
    await expect(
      withFileLock(
        resource,
        async () => {
          throw new Error('overlap');
        },
        options
      )
    ).rejects.toThrow('File lock timeout');
    owner.resume();
    await exited(owner.child);
    expect(owner.child.exitCode).toBe(0);
    await futureAcquisition();
  }
);

it('protects a live reclaimer paused immediately before data unlink', async () => {
  const dead = await paused('callback');
  await dead.kill();
  const reclaimer = await paused('data-unlink-before');
  expect(() => controller.withFileLockSync(resource, () => {}, options)).toThrow(
    'File lock timeout'
  );
  await expect(withFileLock(resource, async () => {}, options)).rejects.toThrow(
    'File lock timeout'
  );
  reclaimer.resume();
  await exited(reclaimer.child);
  expect(reclaimer.child.exitCode).toBe(0);
  await futureAcquisition();
});

it.each(['gate-token-unlink-before', 'gate-rmdir-before'])(
  'a delayed dead-gate remover at %s cannot remove a successor token',
  async (phase) => {
    const dead = await paused('gate-publish-after');
    await dead.kill();
    const old = await paused(phase);
    const successor = await paused('gate-publish-after', 'controller');
    const gate = `${resource}.lock-transition-v2`;
    const entries = fs.readdirSync(gate);
    old.resume();
    await exited(old.child);
    expect(old.child.exitCode).toBe(1); // It times out behind the live successor.
    expect(
      JSON.parse(fs.readFileSync(path.join(old.control, 'error.json'), 'utf8')).message
    ).toContain('File lock timeout');
    expect(fs.readdirSync(gate)).toEqual(entries);
    successor.resume();
    await exited(successor.child);
    expect(successor.child.exitCode).toBe(0);
    await futureAcquisition();
  }
);

it('a releasing owner paused before rmdir preserves a successor gate', async () => {
  const old = await paused('gate-rmdir-before');
  const successor = await paused('gate-publish-after', 'controller');
  const gate = `${resource}.lock-transition-v2`;
  const entries = fs.readdirSync(gate);
  old.resume();
  await exited(old.child);
  expect(old.child.exitCode).toBe(0);
  expect(fs.readdirSync(gate)).toEqual(entries);
  successor.resume();
  await exited(successor.child);
  expect(successor.child.exitCode).toBe(0);
  await futureAcquisition();
});

it('a paused private gate publisher cannot replace a successor callback owner', async () => {
  const old = await paused('gate-publish-before');
  const successor = await paused('callback', 'controller');
  const bytes = fs.readFileSync(`${resource}.lock`, 'utf8');
  old.resume();
  await exited(old.child);
  expect(old.child.exitCode).toBe(1);
  expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe(bytes);
  successor.resume();
  await exited(successor.child);
  expect(successor.child.exitCode).toBe(0);
  await futureAcquisition();
});

it('a paused initialized data publisher retains its live gate until publication', async () => {
  const owner = await paused('data-publish-before');
  expect(() => controller.withFileLockSync(resource, () => {}, options)).toThrow(
    'File lock timeout'
  );
  await expect(withFileLock(resource, async () => {}, options)).rejects.toThrow(
    'File lock timeout'
  );
  owner.resume();
  await exited(owner.child);
  expect(owner.child.exitCode).toBe(0);
  await futureAcquisition();
});

it('a releasing owner paused after data unlink cannot release the successor', async () => {
  const old = await paused('data-unlink-after');
  const successor = await paused('callback', 'controller');
  const bytes = fs.readFileSync(`${resource}.lock`, 'utf8');
  old.resume();
  await exited(old.child);
  expect(old.child.exitCode).toBe(0);
  expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe(bytes);
  expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
  successor.resume();
  await exited(successor.child);
  expect(successor.child.exitCode).toBe(0);
  await futureAcquisition();
});
