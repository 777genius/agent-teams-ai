import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  realpath,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertEmptyCleanupState } from '../../scripts/e2e/opencode-diagnostics/startup-cleanup.mjs';
const fixture = new URL('../../scripts/e2e/opencode-diagnostics/fixture.cjs', import.meta.url);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cleanup-fixture-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(fixture, path.join(root, 'fixture.cjs'));
  await writeFile(path.join(root, 'scenario'), 'startup-cleanup');
  await mkdir(path.join(root, 'cleanup-control'));
  const dir = path.join(root, 'tmp', 'claude-team-opencode-bridge');
  await mkdir(dir, { recursive: true });
  const requestId = `opencode-startup-cleanup-${randomUUID()}`;
  const input = path.join(dir, `opencode-command-${requestId}.json`);
  const output = input + '.output.json';
  const now = Date.now();
  const request = {
    schemaVersion: 1,
    requestId,
    command: 'opencode.cleanupStartupHosts',
    cwd: 'not-an-executable-working-directory',
    startedAt: new Date(now).toISOString(),
    timeoutMs: 10000,
    body: {
      reason: 'startup',
      mode: 'stale',
      staleAgeMs: 300000,
      leaseStaleAgeMs: 86400000,
      preflightLeaseStaleAgeMs: 360000,
      deadlineUnixMs: now + 10000,
    },
  };
  await writeFile(input, JSON.stringify(request));
  const args = ['runtime', 'opencode-command', '--json', '--input', input, '--output', output];
  const run = (argv = args, role = 'orchestrator') => {
    const child = spawn(process.execPath, [path.join(root, 'fixture.cjs'), role, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout }));
    });
    return { done };
  };
  const events = async () =>
    (await readFile(path.join(root, 'calls.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const waitAccepted = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await events()).some((e) => e.event === 'accepted')) return;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await pause(20);
    }
    assert.fail('No accepted synthetic request');
  };
  const release = async (coverage, id = requestId) => {
    const file = path.join(root, 'cleanup-control', id + '.release.json');
    await writeFile(file + '.tmp', JSON.stringify({ requestId: id, coverage }));
    await rename(file + '.tmp', file);
  };
  return { root, input, output, request, args, run, events, waitAccepted, release };
}
for (const coverage of ['partial', 'complete'])
  test(`held ${coverage} response and correlated normal exit`, async (t) => {
    const f = await setup(t);
    const child = f.run();
    await f.waitAccepted();
    await f.release('complete', `opencode-startup-cleanup-${randomUUID()}`);
    await pause(150);
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
    assert.equal((await f.events()).filter((e) => e.event === 'accepted').length, 1);
    await f.release(coverage);
    assert.equal((await child.done).code, 0);
    const response = JSON.parse(await readFile(f.output, 'utf8'));
    assert.deepEqual(response, {
      ok: true,
      schemaVersion: 1,
      requestId: f.request.requestId,
      command: f.request.command,
      completedAt: response.completedAt,
      durationMs: 1,
      runtime: {
        providerId: 'opencode',
        binaryPath: null,
        binaryFingerprint: null,
        version: null,
        capabilitySnapshotId: null,
      },
      diagnostics: [],
      data: {
        cleaned: 0,
        remaining: 0,
        hosts: [],
        diagnostics: coverage === 'partial' ? ['Fixture terminal partial coverage'] : [],
        startupCleanup: { completion: 'drained', coverage, survivingPids: [] },
      },
    });
    assert.equal(new Date(response.completedAt).toISOString(), response.completedAt);
    const events = (await f.events()).filter((e) => e.requestId);
    assert.deepEqual(
      events.map((e) => e.event),
      ['accepted', 'response-written', 'exit']
    );
    assert(events.every((e) => e.pid === events[0].pid && e.requestId === f.request.requestId));
    assert.deepEqual(events[1].response, response);
    assert.equal(events[2].code, 0);
    assert.equal((await f.run().done).code, 64, 'duplicate request refused');
  });
const mutations = {
  'extra flag': (f) => f.args.push('--refresh'),
  'duplicate flag': (f) => f.args.splice(2, 0, '--json'),
  'wrong flag order': (f) => {
    f.args[3] = '--output';
  },
  'wrong output': (f) => {
    f.args[6] += '.other';
  },
  traversal: (f) => {
    f.args[4] = path.dirname(f.input) + path.sep + '..' + path.sep + path.basename(f.input);
  },
  UNC: (f) => {
    f.args[4] = '\\\\server\\share\\input.json';
  },
  ADS: (f) => {
    f.args[4] += ':stream';
  },
  'other command': (f) => {
    f.request.command = 'opencode.launchTeam';
  },
  'other schema': (f) => {
    f.request.schemaVersion = 2;
  },
  'bad correlation': (f) => {
    f.request.requestId += '-wrong';
  },
  'extra envelope': (f) => {
    f.request.stateChanging = true;
  },
  'bad timestamp': (f) => {
    f.request.startedAt = 'yesterday';
  },
  'over budget': (f) => {
    f.request.timeoutMs = 120001;
  },
  'deadline mismatch': (f) => {
    f.request.body.deadlineUnixMs += 5000;
  },
  'force body': (f) => {
    f.request.body.mode = 'force';
  },
  'extra host data': (f) => {
    f.request.body.hosts = [];
  },
  'wrong lease': (f) => {
    f.request.body.leaseStaleAgeMs = 1;
  },
  'wrong preflight lease': (f) => {
    f.request.body.preflightLeaseStaleAgeMs = 1;
  },
  'wrong age': (f) => {
    f.request.body.staleAgeMs = 0;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`refuses ${name}`, async (t) => {
    const f = await setup(t);
    mutate(f);
    await writeFile(f.input, JSON.stringify(f.request));
    assert.equal((await f.run().done).code, 64);
    const events = await f.events();
    assert(events.some((e) => e.event === 'refused'));
    assert(!events.some((e) => e.event === 'accepted'));
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  });
test('junction/symlink ancestor escape refused', async (t) => {
  const f = await setup(t);
  const original = path.dirname(f.input);
  const elsewhere = path.join(f.root, 'elsewhere');
  await rename(original, elsewhere);
  await symlink(elsewhere, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run().done).code, 64);
  assert(!(await f.events()).some((e) => e.event === 'accepted'));
});
test('invalid release refuses without response', async (t) => {
  const f = await setup(t);
  const child = f.run();
  await f.waitAccepted();
  await f.release('unknown');
  assert.equal((await child.done).code, 64);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
test('default refusals and read-only answers preserved', async (t) => {
  const f = await setup(t);
  for (const role of ['opencode', 'orchestrator']) {
    assert.equal((await f.run(['--version'], role).done).code, 0);
    assert.equal((await f.run(['run', 'hello'], role).done).code, 64);
    assert.equal((await f.run(['team', 'launch'], role).done).code, 64);
  }
  assert.equal((await f.run(f.args, 'opencode').done).code, 64);
  for (const args of [
    ['auth', 'status'],
    ['runtime', 'status'],
    ['runtime', 'providers', 'directory', '--runtime', 'opencode', '--json'],
    ['runtime', 'providers', 'models', '--runtime', 'opencode', '--json', '--provider', 'opencode'],
  ]) {
    const result = await f.run(args).done;
    assert.equal(result.code, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
  await writeFile(path.join(f.root, 'scenario'), 'ready');
  assert.equal((await f.run().done).code, 64);
});
test('empty state assertion detects session/team/task files', async (t) => {
  const f = await setup(t);
  await assertEmptyCleanupState(f.root);
  await mkdir(path.join(f.root, 'home/.claude/tasks'), { recursive: true });
  await writeFile(path.join(f.root, 'home/.claude/tasks/task.json'), '{}');
  await assert.rejects(assertEmptyCleanupState(f.root), /Unexpected team\/task\/session/);
});
test('release content must correlate with accepted request', async (t) => {
  const f = await setup(t);
  const child = f.run();
  await f.waitAccepted();
  await writeFile(
    path.join(f.root, 'cleanup-control', f.request.requestId + '.release.json'),
    JSON.stringify({ requestId: 'different-request', coverage: 'complete' })
  );
  assert.equal((await child.done).code, 64);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
test('output symlink refused without touching target', async (t) => {
  const f = await setup(t);
  const target = path.join(f.root, 'protected');
  await writeFile(target, 'unchanged');
  try {
    await symlink(target, f.output, 'file');
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') {
      t.skip('File symlink privilege unavailable; junction test remains required');
      return;
    }
    throw e;
  }
  assert.equal((await f.run().done).code, 64);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
test('empty team creation and linked state ancestors fail isolation proof', async (t) => {
  const f = await setup(t);
  const teams = path.join(f.root, 'home/.claude/teams');
  await mkdir(path.join(teams, 'unexpected-team'), { recursive: true });
  await assert.rejects(assertEmptyCleanupState(f.root), /Unexpected team\/task\/session/);
  await rm(path.join(teams, 'unexpected-team'), { recursive: true });
  await assertEmptyCleanupState(f.root);
  const elsewhere = path.join(f.root, 'state-elsewhere');
  await rename(path.join(f.root, 'home/.claude'), elsewhere);
  await symlink(
    elsewhere,
    path.join(f.root, 'home/.claude'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(assertEmptyCleanupState(f.root), /Unexpected team\/task\/session/);
});
