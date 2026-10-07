import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectPackagedDecision } from './packaged-ci-cli.mts';
import {
  assertFullPackagedGate,
  classifyPackagedPr,
  readNameStatus,
} from './packaged-ci-policy.mts';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const safeDiff = 'M\0src/main/ipc/window.ts\0';
function event(overrides: Record<string, unknown> = {}) {
  return {
    action: 'synchronize',
    pull_request: { draft: true, labels: [], base: { sha: baseSha }, head: { sha: headSha } },
    ...overrides,
  };
}

// These tests turn red if any unsupported change or uncertain evidence gets the app lane.
test('only draft modifications in the initial IPC allowlist get app smoke', () => {
  assert.equal(classifyPackagedPr('pull_request', event(), safeDiff).scope, 'app');
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.github/workflows/electron-packaged-ci.yml',
    'scripts/electron-builder/afterPack.cjs',
    'scripts/postinstall-electron.cjs',
    'scripts/ci/packaged-ci-policy.mts',
    'tsconfig.json',
    'src/main/index.ts',
    'unknown\nfile.ts',
  ]) {
    assert.equal(
      classifyPackagedPr('pull_request', event(), `${safeDiff}M\0${path}\0`).scope,
      'full',
      path
    );
  }
  for (const diff of [
    '',
    'M\0src/main/ipc/window.ts',
    'M\0',
    'M100\0src/main/ipc/window.ts\0',
    `${safeDiff}${safeDiff}`,
    'diff --git a/window.ts b/window.ts\0',
    'A\0src/main/ipc/window.ts\0',
    'D\0src/main/ipc/window.ts\0',
    'T\0src/main/ipc/window.ts\0',
    'R100\0old.ts\0src/main/ipc/window.ts\0',
    'R100\0src/main/ipc/window.ts\0new.ts\0',
    'C100\0old.ts\0src/main/ipc/window.ts\0',
    'M\0src/main/ipc/window.ts\n\0',
  ])
    assert.equal(
      classifyPackagedPr('pull_request', event(), diff).scope,
      'full',
      JSON.stringify(diff)
    );
  assert.equal(classifyPackagedPr('pull_request', event()).scope, 'full');
});

test('review, force-full label and malformed headers always require full verification', () => {
  const draftPr = event().pull_request;
  for (const payload of [
    undefined,
    {},
    event({ action: 'closed' }),
    event({ action: 'ready_for_review' }),
    event({ pull_request: { ...draftPr, draft: false } }),
    event({ pull_request: { ...draftPr, draft: 'true' } }),
    event({ pull_request: { ...draftPr, labels: [{ name: 'ci:full' }] } }),
    event({ pull_request: { ...draftPr, labels: [null] } }),
    event({ pull_request: { ...draftPr, head: { sha: '--unsafe' } } }),
  ])
    assert.equal(classifyPackagedPr('pull_request', payload, safeDiff).scope, 'full');
  assert.equal(classifyPackagedPr('push', event(), safeDiff).scope, 'full');
  for (const action of ['labeled', 'unlabeled']) {
    assert.equal(classifyPackagedPr('pull_request', event({ action }), safeDiff).scope, 'app');
  }
});

test('title/body edits skip work; base or ambiguous edits must verify code', () => {
  for (const changes of [
    { title: { from: 'old' } },
    { body: { from: '' } },
    { body: { from: null } },
    {
      title: { from: 'old' },
      body: { from: 'old' },
    },
  ]) {
    assert.deepEqual(classifyPackagedPr('pull_request', event({ action: 'edited', changes })), {
      scope: 'full',
      run: false,
      reason: 'title/body edit only',
    });
  }
  for (const changes of [
    undefined,
    {},
    { title: {} },
    { title: { from: null } },
    { body: {} },
    { body: { from: null }, base: null },
    { base: { ref: { from: 'main' } } },
    {
      title: { from: 'old' },
      base: { ref: { from: 'main' } },
    },
    { title: { from: 'old' }, unknown: {} },
  ]) {
    const result = classifyPackagedPr(
      'pull_request',
      event({ action: 'edited', changes }),
      safeDiff
    );
    assert.equal(result.scope, 'full');
    assert.equal(result.run, true);
  }
});

test('NUL parsing preserves filenames and both sides of a rename', () => {
  assert.deepEqual(readNameStatus('R100\0old\nname.ts\0new\tname.ts\0'), [
    { status: 'R100', paths: ['old\nname.ts', 'new\tname.ts'] },
  ]);
  assert.equal(readNameStatus('R100\0old.ts\0'), undefined);
});

test('a green intermediate matrix can never make the final gate green', () => {
  const valid = { scope: 'full', scopeResult: 'success', packagedResult: 'success' };
  assert.doesNotThrow(() => assertFullPackagedGate(valid));
  assert.throws(() => assertFullPackagedGate({ ...valid, scope: 'app' }));
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.throws(() => assertFullPackagedGate({ ...valid, scopeResult: result }));
    assert.throws(() => assertFullPackagedGate({ ...valid, packagedResult: result }));
  }
  assert.throws(() => assertFullPackagedGate({ ...valid, scope: undefined }));
  const cli = fileURLToPath(new URL('./packaged-ci-cli.mts', import.meta.url));
  assert.notEqual(
    spawnSync(process.execPath, [cli, 'gate'], {
      env: {
        ...process.env,
        PACKAGED_SCOPE: 'app',
        SCOPE_RESULT: 'success',
        PACKAGED_RESULT: 'success',
      },
      encoding: 'utf8',
    }).status,
    0
  );
});

test('CLI uses exact local git evidence and falls back to full after git/event failures', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'packaged-ci-test-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'iliya',
    GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
    GIT_COMMITTER_NAME: 'iliya',
    GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(cwd, 'event.json'),
  };
  function git(args: string[]): string {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function commit(): string {
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      assert.match(git(['var', identity]), /^iliya <iliyazelenkog@gmail\.com> /);
    }
    git(['add', 'src']);
    git(['commit', '-m', 'test: packaged policy fixture']);
    return git(['rev-parse', 'HEAD']);
  }
  try {
    git(['init', '--quiet']);
    mkdirSync(join(cwd, 'src/main/ipc'), { recursive: true });
    const path = join(cwd, 'src/main/ipc/window.ts');
    writeFileSync(path, 'first\n');
    const base = commit();
    writeFileSync(path, 'second\n');
    const head = commit();
    const payload = event({
      pull_request: {
        ...event().pull_request,
        base: { sha: base },
        head: { sha: head },
      },
    });
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'app');
    assert.equal(collectPackagedDecision(env, join(cwd, 'src')).scope, 'app');
    renameSync(path, join(cwd, 'src/main/ipc/new\nname.ts'));
    payload.pull_request.head.sha = commit();
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'full');
    payload.pull_request.head.sha = '0'.repeat(40);
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'full');
    writeFileSync(env.GITHUB_EVENT_PATH, '{invalid');
    assert.equal(collectPackagedDecision(env, cwd).scope, 'full');
    assert.equal(collectPackagedDecision({ ...env, GITHUB_EVENT_PATH: '' }, cwd).scope, 'full');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
