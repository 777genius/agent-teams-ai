import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { HostWorktreeGit } from '../dist/adapters/worktrees/HostWorktreeGit.js';
import { materializeWorktree } from '../dist/team-launch/materializeWorktree.js';
import type {
  LaunchWorktreeCapturePort,
  LaunchWorktreePlan,
  LaunchWorktreeReceipt,
} from '../dist/team-launch/worktreeContracts.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-owned-worktree-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'TEST repository with spaces');
  const owned = join(root, 'TEST owner');
  mkdirSync(repo);
  mkdirSync(owned);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'iliya');
  git(repo, 'config', 'user.email', 'iliyazelenkog@gmail.com');
  writeFileSync(join(repo, 'tracked.txt'), 'original committed bytes\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'TEST original');
  const adapter = new HostWorktreeGit(owned);
  const input = {
    baseCwd: repo,
    teamId: 'TEST-team',
    slot: { kind: 'member' as const, name: 'alice' },
  };
  return { root, repo, owned, adapter, input };
}
function capture(plan: LaunchWorktreePlan, receipt?: LaunchWorktreeReceipt) {
  let record: { plan: LaunchWorktreePlan; receipt?: LaunchWorktreeReceipt } = receipt
    ? { plan, receipt }
    : { plan };
  const transitions: string[] = [];
  const port: LaunchWorktreeCapturePort = {
    read: () => structuredClone(record),
    assertCurrent() {},
    write(next, expected) {
      assert.deepEqual(
        record.receipt,
        expected,
        'the existing launch fence compares the previous receipt'
      );
      assert.equal(
        next.planDigest,
        new HostWorktreeGit(join(plan.targetPath, '..')).digest(record.plan)
      );
      if (next.state === 'reserved' || next.state === 'attempted') {
        assert.equal(lstatSync(next.target.path).ino, next.target.inode);
        assert.equal(
          existsSync(join(next.target.path, '.git')),
          false,
          'receipt precedes Git worktree creation'
        );
      }
      transitions.push(next.state);
      record = { plan, receipt: structuredClone(next) };
    },
  };
  return { port, transitions, read: () => structuredClone(record) };
}

test('durable original plan precedes Git and pins the captured commit despite base advancing', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  writeFileSync(join(f.repo, 'tracked.txt'), 'new base commit\n');
  git(f.repo, 'commit', '-am', 'TEST base moved');
  const c = capture(plan);
  const binding = await materializeWorktree(plan, f.adapter, c.port);
  assert.deepEqual(c.transitions, ['reserved', 'attempted', 'completed']);
  assert.equal(git(binding.target.path, 'rev-parse', 'HEAD'), plan.capturedCommit);
  assert.equal(
    readFileSync(join(binding.target.path, 'tracked.txt'), 'utf8'),
    'original committed bytes\n'
  );
  assert.equal(readFileSync(join(f.repo, 'tracked.txt'), 'utf8'), 'new base commit\n');
  assert.equal(binding.target.inode, lstatSync(binding.target.path).ino);
  const replay = await materializeWorktree(plan, new HostWorktreeGit(f.owned), c.port);
  assert.deepEqual(replay, binding);
  assert.deepEqual(
    c.transitions,
    ['reserved', 'attempted', 'completed'],
    'ACK loss replay performs no new transition'
  );
});

test('fresh named and member relaunch preserve current commit, staged bytes and untracked bytes', async (t) => {
  const f = fixture(t);
  for (const kind of ['named', 'member'] as const) {
    const input = { ...f.input, slot: { kind, name: 'retained slot' } };
    const first = await f.adapter.plan(input);
    const binding = await materializeWorktree(first, f.adapter, capture(first).port);
    const cwd = binding.target.path;
    writeFileSync(join(cwd, 'tracked.txt'), 'member committed progress\n');
    git(cwd, 'commit', '-am', 'TEST member progress');
    const memberCommit = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'tracked.txt'), 'member staged progress\n');
    git(cwd, 'add', 'tracked.txt');
    writeFileSync(join(cwd, 'scratch file.txt'), 'untracked prior bytes\0with binary\n');
    const status = git(cwd, 'status', '--porcelain=v1');
    const restarted = new HostWorktreeGit(f.owned);
    const second = await restarted.plan({ ...input, previous: binding });
    assert.equal(second.targetPath, first.targetPath);
    assert.equal(second.proof.head, memberCommit);
    assert.notEqual(second.proof.dirtyDigest, first.proof.dirtyDigest);
    const c = capture(second);
    assert.deepEqual(await materializeWorktree(second, restarted, c.port), binding);
    assert.deepEqual(c.transitions, ['completed']);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), memberCommit);
    assert.equal(git(cwd, 'status', '--porcelain=v1'), status);
    assert.equal(readFileSync(join(cwd, 'tracked.txt'), 'utf8'), 'member staged progress\n');
    assert.equal(
      readFileSync(join(cwd, 'scratch file.txt'), 'utf8'),
      'untracked prior bytes\0with binary\n'
    );
    assert.equal(lstatSync(cwd).ino, binding.target.inode);
  }
});

test('foreign same slot branch/path are held without adopting or changing bytes', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  git(f.repo, 'branch', plan.branch);
  await assert.rejects(
    f.adapter.plan(f.input),
    (error) =>
      error instanceof TeamLaunchError &&
      error.code === 'hold' &&
      error.reason === 'unrecorded-worktree-or-branch-exists'
  );
  assert.equal(existsSync(plan.targetPath), false);
  git(f.repo, 'branch', '-d', plan.branch);
  mkdirSync(plan.targetPath);
  writeFileSync(join(plan.targetPath, 'foreign.txt'), 'foreign bytes');
  await assert.rejects(f.adapter.plan(f.input), /unrecorded-worktree-or-branch-exists/);
  assert.equal(readFileSync(join(plan.targetPath, 'foreign.txt'), 'utf8'), 'foreign bytes');
  assert.equal(git(f.repo, 'branch', '--list', plan.branch), '');
});

test('attempted creation without terminal receipt holds; recorded completion recovers exact original binding', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  const c = capture(plan);
  const binding = await materializeWorktree(plan, f.adapter, c.port);
  const completed = c.read().receipt!;
  const uncertain = capture(plan, {
    planDigest: completed.planDigest,
    state: 'attempted',
    target: completed.target,
  });
  await assert.rejects(
    materializeWorktree(plan, f.adapter, uncertain.port),
    /creation-outcome-uncertain/
  );
  assert.deepEqual(uncertain.transitions, []);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 2);
  assert.deepEqual(
    await materializeWorktree(plan, f.adapter, capture(plan, completed).port),
    binding
  );
});

test('changed workspace after reuse capture holds and preserves the new bytes', async (t) => {
  const f = fixture(t);
  const first = await f.adapter.plan(f.input);
  const binding = await materializeWorktree(first, f.adapter, capture(first).port);
  const second = await f.adapter.plan({ ...f.input, previous: binding });
  writeFileSync(join(binding.target.path, 'tracked.txt'), 'changed after capture');
  const c = capture(second);
  await assert.rejects(
    materializeWorktree(second, f.adapter, c.port),
    /workspace-changed-since-capture/
  );
  assert.deepEqual(c.transitions, []);
  assert.equal(
    readFileSync(join(binding.target.path, 'tracked.txt'), 'utf8'),
    'changed after capture'
  );
});

test('foreign completion binding and replaced owned inode cannot authorize reuse', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  const binding = await materializeWorktree(plan, f.adapter, capture(plan).port);
  const fake = { ...binding, slotId: 'a'.repeat(64) };
  await assert.rejects(
    f.adapter.plan({ ...f.input, previous: fake }),
    /previous-owned-slot-mismatch/
  );
  await assert.rejects(
    f.adapter.inspect(plan, {
      ...binding,
      target: { ...binding.target, inode: binding.target.inode + 1 },
    }),
    /owned-worktree-identity-changed/
  );
  assert.equal(git(binding.target.path, 'rev-parse', 'HEAD'), plan.capturedCommit);
});

test('Git status is read-only for plain, unborn and committed TEST directories', async (t) => {
  const f = fixture(t);
  const plain = join(f.root, 'TEST plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'keep.txt'), 'do not stage or commit');
  assert.equal((await f.adapter.getStatus('relative')).reason, 'invalid_project_path');
  assert.equal((await f.adapter.getStatus(plain)).reason, 'not_git_repo');
  assert.equal(existsSync(join(plain, '.git')), false);
  git(plain, 'init', '-b', 'main');
  const unborn = await f.adapter.getStatus(plain);
  assert.equal(unborn.reason, 'missing_head');
  assert.equal(unborn.isGitRepo, true);
  assert.equal(unborn.canUseWorktrees, false);
  assert.equal(git(plain, 'ls-files'), '');
  assert.equal(readFileSync(join(plain, 'keep.txt'), 'utf8'), 'do not stage or commit');
  const committed = await f.adapter.getStatus(f.repo);
  assert.equal(committed.rootPath, f.repo);
  assert.equal(committed.branch, 'main');
  assert.equal(committed.canUseWorktrees, true);
});

test('authority is checked after asynchronous Git reads immediately before creation', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  const c = capture(plan);
  let checks = 0;
  c.port.assertCurrent = () => {
    checks++;
    if (checks === 3) throw new Error('TEST authority changed during Git reads');
  };
  await assert.rejects(materializeWorktree(plan, f.adapter, c.port), /TEST authority changed/);
  assert.deepEqual(c.transitions, ['reserved', 'attempted']);
  assert.equal(existsSync(join(plan.targetPath, '.git')), false);
  assert.equal(git(f.repo, 'branch', '--list', plan.branch), '');
  await assert.rejects(materializeWorktree(plan, f.adapter, c.port), /creation-outcome-uncertain/);
});

test('reserved-before-attempt crash resumes the original inode and rejects a different captured plan', async (t) => {
  const f = fixture(t);
  const plan = await f.adapter.plan(f.input);
  const target = f.adapter.reserve(plan);
  const reserved = { planDigest: f.adapter.digest(plan), state: 'reserved' as const, target };
  const c = capture(plan, reserved);
  await assert.rejects(
    materializeWorktree({ ...plan, capturedCommit: 'a'.repeat(40) }, f.adapter, c.port),
    /capture-plan-changed/
  );
  assert.equal(git(f.repo, 'branch', '--list', plan.branch), '');
  const binding = await materializeWorktree(plan, new HostWorktreeGit(f.owned), c.port);
  assert.equal(binding.target.inode, target.inode);
  assert.deepEqual(c.transitions, ['attempted', 'completed']);
});
