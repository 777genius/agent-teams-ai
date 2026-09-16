import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  firstParentFromCommitObject,
  NO_PRIOR_COMMIT_REF,
  resolveArchitectureBaselineRef,
} from '../../scripts/ci/resolve-architecture-baseline-ref.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('selects the first raw commit parent and keeps true roots at the zero sentinel', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);

  assert.equal(
    firstParentFromCommitObject(
      `tree ${'a'.repeat(40)}\nparent ${first}\nparent ${second}\nauthor Test <test@example.com> 1 +0000\n\nmessage\n`
    ),
    first
  );
  assert.equal(
    firstParentFromCommitObject(
      `tree ${'a'.repeat(40)}\nauthor Test <test@example.com> 1 +0000\n\nparent ${first}\n`
    ),
    null
  );

  const calls = [];
  assert.equal(
    resolveArchitectureBaselineRef({
      eventBaselineRef: NO_PRIOR_COMMIT_REF,
      git: (args) => {
        calls.push(args);
        return `tree ${'a'.repeat(40)}\n\nroot\n`;
      },
      headSha: '3'.repeat(40),
    }),
    NO_PRIOR_COMMIT_REF
  );
  assert.deepEqual(calls, [['cat-file', 'commit', '3'.repeat(40)]]);
});

test('fetches the existing event baseline and fails closed for malformed refs', () => {
  const baselineRef = '4'.repeat(40);
  const calls = [];
  assert.equal(
    resolveArchitectureBaselineRef({
      eventBaselineRef: baselineRef,
      git: (args) => {
        calls.push(args);
        return '';
      },
    }),
    baselineRef
  );
  assert.deepEqual(calls, [
    ['fetch', '--no-tags', '--depth=1', 'origin', baselineRef],
    ['cat-file', '-e', `${baselineRef}^{commit}`],
  ]);
  assert.throws(
    () => resolveArchitectureBaselineRef({ eventBaselineRef: 'main', git: () => '' }),
    /40-character commit SHA/
  );
  assert.throws(
    () =>
      resolveArchitectureBaselineRef({
        eventBaselineRef: NO_PRIOR_COMMIT_REF,
        git: () => `tree ${'a'.repeat(40)}\nparent invalid\n\nmessage\n`,
        headSha: '5'.repeat(40),
      }),
    /commit parent must be a 40-character commit SHA/
  );
});

test('recovers and fetches the missing parent from a depth-one branch clone', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'architecture-baseline-'));
  const origin = path.join(fixtureRoot, 'origin.git');
  const source = path.join(fixtureRoot, 'source');
  const shallow = path.join(fixtureRoot, 'shallow');

  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);
    execFileSync('git', ['init', '--initial-branch=main', source]);
    git(source, ['config', 'user.email', 'architecture@example.com']);
    git(source, ['config', 'user.name', 'Architecture Test']);
    writeFileSync(path.join(source, 'fixture.txt'), 'root\n');
    git(source, ['add', 'fixture.txt']);
    git(source, ['commit', '-m', 'root']);
    const parentRef = git(source, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(source, 'fixture.txt'), 'child\n');
    git(source, ['commit', '-am', 'child']);
    const headSha = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', '--depth=1', `file://${origin}`, shallow]);
    assert.throws(() => git(shallow, ['cat-file', '-e', `${parentRef}^{commit}`]));

    assert.equal(
      resolveArchitectureBaselineRef({
        eventBaselineRef: NO_PRIOR_COMMIT_REF,
        headSha,
        root: shallow,
      }),
      parentRef
    );
    assert.doesNotThrow(() => git(shallow, ['cat-file', '-e', `${parentRef}^{commit}`]));
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
