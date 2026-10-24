import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChanges,
  collectChangeScope,
  isDmgDisplayOnly,
} from '../../scripts/ci/ci-change-scope.mts';
import { planFeedback, qualifyFull } from '../../scripts/ci/ci-feedback.mts';
const entry = (path: string, status = 'M') => ({ path, status });
const pkg = {
  scripts: { test: 'vitest' },
  build: { dmg: { iconSize: 100, window: { width: 660, height: 460 } } },
};
const before = JSON.stringify(pkg);
const after = JSON.stringify({ ...pkg, build: { dmg: { ...pkg.build.dmg, iconSize: 120 } } });
test('docs and DMG display edits select bounded tiers', () => {
  assert.equal(classifyChanges([entry('docs/install.md')]).scope, 'docs');
  assert.equal(
    classifyChanges([entry('resources/dmg/background.png'), entry('package.json')], before, after)
      .scope,
    'dmg'
  );
  assert.equal(classifyChanges([entry('src/renderer/components/ui/button.tsx')]).scope, 'source');
});
test('dependencies, signing, unsafe content paths and unknown edits fail closed', () => {
  for (const path of [
    'src/main/ipc/teams.ts',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    'src/renderer/store/teamSlice.ts',
    'resources/icon.png',
  ])
    assert.equal(classifyChanges([entry(path)]).scope, 'full');
  assert.equal(
    isDmgDisplayOnly(
      before,
      JSON.stringify({
        ...pkg,
        scripts: { test: 'echo hacked' },
        build: { dmg: { iconSize: 120 } },
      })
    ),
    false
  );
  assert.equal(
    isDmgDisplayOnly(
      before,
      JSON.stringify({ ...pkg, build: { dmg: { ...pkg.build.dmg, sign: false } } })
    ),
    false
  );
  assert.equal(
    isDmgDisplayOnly(
      before,
      JSON.stringify({
        ...pkg,
        build: {
          dmg: {
            contents: [
              { type: 'link', path: '/tmp', x: 1, y: 2 },
              { type: 'file', x: 3, y: 4 },
            ],
          },
        },
      })
    ),
    false
  );
  assert.equal(isDmgDisplayOnly('{', after), false);
});
test('mixed areas, renames, deletions and malformed paths select full', () => {
  for (const entries of [
    [entry('docs/a.md'), entry('scripts/a.mjs')],
    [entry('src/renderer/components/ui/button.tsx'), entry('resources/dmg/background.png')],
    [entry('docs/a.md', 'R100')],
    [entry('resources/dmg/background.png', 'D')],
    [entry('docs/../a.md')],
    [],
  ])
    assert.equal(classifyChanges(entries).scope, 'full');
  assert.equal(collectChangeScope({}).scope, 'full');
});
test('gate requires selected checks, successful plan and draft never qualifies', () => {
  const needs = {
    plan: {
      result: 'success',
      outputs: { scope: 'docs', full: 'true', metadata: 'false', reuse: 'false' },
    },
    focused: { result: 'success' },
  };
  assert.equal(qualifyFull(needs, 'true', 'false', '4').ok, true);
  assert.equal(
    qualifyFull({ ...needs, focused: { result: 'skipped' } }, 'true', 'false', '4').ok,
    false
  );
  assert.equal(qualifyFull({ plan: needs.plan }, 'true', 'false', '4').ok, false);
  assert.equal(
    qualifyFull({ ...needs, plan: { ...needs.plan, result: 'failure' } }, 'true', 'false', '4').ok,
    false
  );
  assert.equal(qualifyFull(needs, 'false', 'false', '4').ok, false);
});

test('every event reports the required qualification under its static name', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(
    yaml,
    /\n {2}full-qualification:\n {4}name: Full qualification\n {4}needs: \[[^\]]+\]\n {4}if: always\(\)\n/
  );
  assert.doesNotMatch(yaml, /Metadata qualification/);
});

test('repository-root, docs and GitHub community markdown are documentation', () => {
  for (const path of [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/RELEASE.md',
    'docs/nested/guide.md',
    '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/bug_report.md',
  ])
    assert.equal(classifyChanges([entry(path)]).scope, 'docs', path);
  for (const path of [
    'src/features/README.md',
    'landing/product-docs/index.md',
    'landing/README.md',
    'announcements/release/body.md',
    '.github/workflows/notes.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    'docs/release.json',
    'README.mdx',
  ])
    assert.equal(classifyChanges([entry(path)]).scope, 'full', path);
});

test('DMG qualification cannot pass without its macOS mounted fixture', () => {
  const plan = {
    result: 'success',
    outputs: { scope: 'dmg', full: 'true', metadata: 'false', reuse: 'false' },
  };
  const focused = { result: 'success' };
  assert.equal(qualifyFull({ plan, focused }, 'true', 'false', '4').ok, false);
  assert.equal(
    qualifyFull({ plan, focused, 'dmg-artwork': { result: 'skipped' } }, 'true', 'false', '4').ok,
    false
  );
  assert.equal(
    qualifyFull({ plan, focused, 'dmg-artwork': { result: 'success' } }, 'true', 'false', '4').ok,
    true
  );
});

test('classifier binds real git merge parents and rejects altered event, missing commits, labels and symlinks', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const cwd = mkdtempSync(join(tmpdir(), 'scope-git-fixture-'));
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'iliya',
    GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
    GIT_COMMITTER_NAME: 'iliya',
    GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: identity,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init');
    assert.match(git('var', 'GIT_AUTHOR_IDENT'), /^iliya <iliyazelenkog@gmail.com>/);
    assert.match(git('var', 'GIT_COMMITTER_IDENT'), /^iliya <iliyazelenkog@gmail.com>/);
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs/a.md'), 'old\n');
    git('add', '.');
    const base = git('commit-tree', git('write-tree'), '-m', 'fixture base');
    git('reset', '--hard', base);
    writeFileSync(join(cwd, 'docs/a.md'), 'new\n');
    git('add', '.');
    const head = git('commit-tree', git('write-tree'), '-p', base, '-m', 'fixture head');
    const merge = git(
      'commit-tree',
      git('write-tree'),
      '-p',
      base,
      '-p',
      head,
      '-m',
      'fixture merge'
    );
    git('reset', '--hard', merge);
    const eventFile = join(cwd, 'event.json');
    const payload = {
      action: 'synchronize',
      number: 1,
      repository: { full_name: '777genius/agent-teams-ai' },
      pull_request: {
        number: 1,
        state: 'open',
        draft: false,
        base: { sha: base, repo: { full_name: '777genius/agent-teams-ai' } },
        head: { sha: head },
      },
    };
    writeFileSync(eventFile, JSON.stringify(payload));
    const env = {
      GITHUB_REPOSITORY: '777genius/agent-teams-ai',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_SHA: merge,
    };
    assert.equal(collectChangeScope(env, cwd).scope, 'docs');
    // Title/body and label events keep the commits; any other edit or action stays full.
    const scopeFor = (fields: Record<string, unknown>) => {
      writeFileSync(eventFile, JSON.stringify({ ...payload, ...fields }));
      return collectChangeScope(env, cwd).scope;
    };
    assert.equal(scopeFor({ action: 'edited', changes: { body: { from: null } } }), 'docs');
    assert.equal(scopeFor({ action: 'edited', changes: { title: { from: 'Old' } } }), 'docs');
    assert.equal(
      scopeFor({ action: 'edited', changes: { base: { ref: { from: 'dev' } } } }),
      'full'
    );
    assert.equal(scopeFor({ action: 'edited', changes: {} }), 'full');
    assert.equal(scopeFor({ action: 'edited' }), 'full');
    assert.equal(scopeFor({ action: 'labeled' }), 'docs');
    assert.equal(scopeFor({ action: 'unlabeled' }), 'docs');
    assert.equal(
      scopeFor({
        action: 'labeled',
        pull_request: { ...payload.pull_request, labels: [{ name: 'ci:full' }] },
      }),
      'full'
    );
    assert.equal(scopeFor({ action: 'assigned' }), 'full');
    // Without reusable full evidence a title/body edit qualifies the same diff again.
    const repo = { id: 1, full_name: '777genius/agent-teams-ai' };
    const edited = {
      ...payload,
      action: 'edited',
      changes: { body: { from: null } },
      repository: repo,
      pull_request: {
        ...payload.pull_request,
        id: 2,
        title: 'docs: describe release check',
        body: 'Updated description',
        base: { sha: base, ref: 'main', repo },
        head: { sha: head, ref: 'docs/check', repo },
      },
    };
    const offline = () => Promise.reject(new Error('offline'));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      writeFileSync(eventFile, JSON.stringify(edited));
      const decision = await planFeedback(env, edited, offline);
      assert.deepEqual([decision.scope, decision.full, decision.metadata], ['docs', true, false]);
      const retarget = { ...edited, changes: { base: { ref: { from: 'dev' } } } };
      writeFileSync(eventFile, JSON.stringify(retarget));
      assert.equal((await planFeedback(env, retarget, offline)).scope, 'full');
    } finally {
      process.chdir(previousCwd);
    }
    writeFileSync(eventFile, JSON.stringify(payload));
    assert.equal(collectChangeScope({ ...env, GITHUB_SHA: head }, cwd).scope, 'full');
    writeFileSync(
      eventFile,
      JSON.stringify({
        ...payload,
        pull_request: { ...payload.pull_request, head: { sha: 'f'.repeat(40) } },
      })
    );
    assert.equal(collectChangeScope(env, cwd).scope, 'full');
    writeFileSync(
      eventFile,
      JSON.stringify({
        ...payload,
        pull_request: { ...payload.pull_request, labels: [{ name: 'ci:full' }] },
      })
    );
    assert.equal(collectChangeScope(env, cwd).scope, 'full');
    git('reset', '--hard', base);
    rmSync(join(cwd, 'docs/a.md'));
    symlinkSync('../README.md', join(cwd, 'docs/a.md'));
    git('add', 'docs/a.md');
    const linkHead = git('commit-tree', git('write-tree'), '-p', base, '-m', 'fixture link');
    const linkMerge = git(
      'commit-tree',
      git('write-tree'),
      '-p',
      base,
      '-p',
      linkHead,
      '-m',
      'fixture link merge'
    );
    git('reset', '--hard', linkMerge);
    writeFileSync(
      eventFile,
      JSON.stringify({
        ...payload,
        pull_request: { ...payload.pull_request, head: { sha: linkHead } },
      })
    );
    assert.equal(collectChangeScope({ ...env, GITHUB_SHA: linkMerge }, cwd).scope, 'full');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
