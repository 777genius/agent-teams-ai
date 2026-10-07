import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectPackagedDecision } from './packaged-ci-cli.mts';
import { assertFullPackagedGate, classifyPackagedPr, readRawDiff } from './packaged-ci-policy.mts';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
function raw(
  status: string,
  paths: string[],
  oldMode = status === 'A' ? '000000' : '100644',
  newMode = status === 'D' ? '000000' : '100644'
): string {
  return `:${oldMode} ${newMode} ${oldMode === '000000' ? '0'.repeat(40) : baseSha} ${newMode === '000000' ? '0'.repeat(40) : headSha} ${status}\0${paths.join('\0')}\0`;
}
const safeDiff = raw('M', ['src/main/ipc/window.ts']);
function event(overrides: Record<string, unknown> = {}) {
  return {
    action: 'synchronize',
    pull_request: { draft: true, labels: [], base: { sha: baseSha }, head: { sha: headSha } },
    ...overrides,
  };
}

// This contract turns red if ordinary source/test work loses APP or packaging inputs gain it.
test('draft regular source/test changes may accompany the existing window trigger', () => {
  for (const diff of [
    safeDiff,
    safeDiff + raw('M', ['src/main/index.ts']) + raw('A', ['test/window.test.ts']),
    safeDiff + raw('D', ['test/obsolete.ts']),
    safeDiff + raw('R100', ['src/main/old.ts', 'test/renamed.ts']),
    raw('M', ['src/renderer/main.tsx'], '100644', '100755'),
  ])
    assert.equal(classifyPackagedPr('pull_request', event(), diff).scope, 'app');
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.github/workflows/electron-packaged-ci.yml',
    'scripts/electron-builder/afterPack.cjs',
    'scripts/postinstall-electron.cjs',
    'scripts/ci/packaged-ci-policy.mts',
    'tsconfig.json',
    'resources/icon.svg',
    'src/renderer/assets/participant-avatars/avatar.svg',
    'src/shared/utils/posthogBuildPolicy.ts',
    'src/shared/utils/sentryBuildPolicy.ts',
    'src/shared/utils/sentryArtifactInventory.ts',
    'src/native/addon.node',
    'src/runtime/agent.bin',
    'test/fixture.wasm',
    'src/settings.json',
    'src/vite.config.ts',
    'src/config/runtime.ts',
    'src/unknown.extension',
    'unknown/file.ts',
  ]) {
    assert.equal(
      classifyPackagedPr('pull_request', event(), safeDiff + raw('M', [path])).scope,
      'full',
      path
    );
  }
  for (const sensitive of [
    'src/shared/utils/sentryBuildPolicy.ts',
    'src/renderer/assets/participant-avatars/avatar.svg',
  ]) {
    for (const paths of [
      [sensitive, 'src/main/renamed.ts'],
      ['src/main/old.ts', sensitive],
    ]) {
      assert.equal(
        classifyPackagedPr('pull_request', event(), safeDiff + raw('R100', paths)).scope,
        'full',
        paths.join(' -> ')
      );
    }
  }
});

test('case aliases cannot bypass packaging inputs while ordinary component names remain APP', () => {
  assert.equal(
    classifyPackagedPr('pull_request', event(), safeDiff + raw('M', ['src/main/MyComponent.ts']))
      .scope,
    'app'
  );
  for (const path of ['SRC/main/MyComponent.ts', 'src/main/MyComponent.TS']) {
    assert.equal(
      classifyPackagedPr('pull_request', event(), safeDiff + raw('M', [path])).scope,
      'full'
    );
  }
  for (const alias of [
    'src/shared/utils/POSTHOGbuildPolicy.ts',
    'src/shared/utils/SENTRYbuildPolicy.ts',
    'src/shared/utils/sENTRYArtifactInventory.ts',
    'src/renderer/assets/PARTICIPANT-AVATARS/avatar.svg',
    'src/CONFIG/runtime.ts',
    'test/Resources/data.ts',
    'src/Scripts/build.ts',
  ]) {
    for (const status of ['A', 'M', 'D']) {
      assert.equal(
        classifyPackagedPr('pull_request', event(), safeDiff + raw(status, [alias])).scope,
        'full',
        `${status} ${alias}`
      );
    }
    for (const paths of [
      [alias, 'src/main/renamed.ts'],
      ['src/main/old.ts', alias],
    ]) {
      assert.equal(
        classifyPackagedPr('pull_request', event(), safeDiff + raw('R100', paths)).scope,
        'full',
        paths.join(' -> ')
      );
    }
  }
});

test('unsupported file types, raw headers and ambiguous paths require FULL', () => {
  for (const diff of [
    '',
    safeDiff.slice(0, -1),
    safeDiff + safeDiff,
    'M\0src/main/ipc/window.ts\0',
    raw('M100', ['src/main/file.ts']),
    raw('R999', ['src/old.ts', 'src/new.ts']),
    raw('R100', ['src/old.ts']),
    raw('A', ['src/new.ts'], '100644', '100644'),
    raw('D', ['src/old.ts'], '100644', '100644'),
    raw('M', ['src/a.ts'], '000000', '100644'),
    raw('M', ['src/a.ts'], '100644', '000000'),
    raw('M', ['src/a.ts'], '100664', '100644'),
    raw('A', ['src/link.ts'], '000000', '120000'),
    raw('D', ['src/submodule.ts'], '160000', '000000'),
    raw('R100', ['src/old.ts', 'src/new.ts'], '120000', '100644'),
    raw('M', ['src/a.ts']).replace(baseSha, 'abc1234'),
    raw('M', ['src/a.ts']).replace(headSha, '0'.repeat(40)),
    raw('C100', ['src/a.ts', 'src/b.ts']),
    ...['T', 'U', 'X', 'B'].map((status) => raw(status, ['src/a.ts'])),
    ...[
      'src/../file.ts',
      'src/./file.ts',
      'src//file.ts',
      '/src/file.ts',
      'src/new\nname.ts',
      'src/new\tname.ts',
      'src/new\\name.ts',
    ].map((path) => raw('M', [path])),
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

test('raw NUL parsing keeps both rename filenames without trimming spaces', () => {
  assert.deepEqual(readRawDiff(raw('R100', ['src/old name.ts', 'test/new name.ts']))?.[0]?.paths, [
    'src/old name.ts',
    'test/new name.ts',
  ]);
  assert.equal(readRawDiff(raw('R100', ['src/old.ts'])), undefined);
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
  function commit(paths = ['src', 'test']): string {
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      assert.match(git(['var', identity]), /^iliya <iliyazelenkog@gmail\.com> /);
    }
    if (paths.length) git(['add', ...paths]);
    git(['commit', '-m', 'test: packaged policy fixture']);
    return git(['rev-parse', 'HEAD']);
  }
  try {
    git(['init', '--quiet']);
    mkdirSync(join(cwd, 'src/main/ipc'), { recursive: true });
    mkdirSync(join(cwd, 'test'), { recursive: true });
    const path = join(cwd, 'src/main/ipc/window.ts');
    writeFileSync(path, 'first\n');
    writeFileSync(join(cwd, 'test/obsolete.ts'), 'obsolete\n');
    writeFileSync(join(cwd, 'src/main/old.ts'), 'stable rename content\n');
    const base = commit();
    writeFileSync(path, 'second\n');
    writeFileSync(join(cwd, 'src/main/added.ts'), 'new source\n');
    writeFileSync(join(cwd, 'test/added.test.ts'), 'new test\n');
    rmSync(join(cwd, 'test/obsolete.ts'));
    renameSync(join(cwd, 'src/main/old.ts'), join(cwd, 'test/renamed.ts'));
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
    git(['checkout', '--detach', base]);
    mkdirSync(join(cwd, 'resources'), { recursive: true });
    writeFileSync(join(cwd, 'resources/base-only.txt'), 'base branch advanced independently\n');
    payload.pull_request.base.sha = commit(['resources']);
    git(['checkout', '--detach', head]);
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'app', 'diff must start at merge-base');
    const link = join(cwd, 'src/main/link.ts');
    symlinkSync('ipc/window.ts', link);
    payload.pull_request.head.sha = commit();
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'full', 'source symlink must stay full');
    rmSync(link);
    git(['add', 'src', 'test']);
    git(['update-index', '--add', '--cacheinfo', `160000,${head},src/main/submodule.ts`]);
    payload.pull_request.head.sha = commit([]);
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    assert.equal(collectPackagedDecision(env, cwd).scope, 'full', 'source gitlink must stay full');
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
