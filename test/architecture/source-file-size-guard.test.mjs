import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateSourceFileSizes,
  readWorkingTreeRecords,
  strictSourceFileSizeViolations,
} from '../../scripts/ci/check-source-file-size.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const policyPath = new URL('../../scripts/ci/source-file-size-baseline.json', import.meta.url);

test('keeps the checked-in source-size policy synchronized with the source tree', () => {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const result = evaluateSourceFileSizes(readWorkingTreeRecords(repoRoot), policy);

  assert.deepEqual(strictSourceFileSizeViolations(result), []);
  assert.ok(result.checkedFiles > result.legacyFiles);
  assert.ok(result.legacyFiles > 0);
});

test('package guards use the canonical source-size policy', () => {
  const packageScripts = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ).scripts;

  assert.equal(
    packageScripts['guard:source-file-size'],
    'node ./scripts/ci/check-source-file-size.mjs'
  );
  assert.match(packageScripts['validate:ci'], /^pnpm guard:source-file-size:ci(?: &&|$)/);
  assert.equal(
    packageScripts['guard:source-file-size:ci'],
    'node ./scripts/ci/check-source-file-size.mjs --require-baseline'
  );
});

test('canonical source-size guard succeeds for the current checkout', () => {
  const result = spawnSync(process.execPath, ['./scripts/ci/check-source-file-size.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Source file size guard passed:/);
});

test('CI guard rejects every base-relative policy widening', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'source-file-size-ratchet-'));
  const guardPath = join(root, 'scripts/ci/check-source-file-size.mjs');
  const policyPath = join(root, 'scripts/ci/source-file-size-baseline.json');
  const legacyPath = join(root, 'src/legacy.ts');
  const runGit = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const baselinePolicy = {
    maxLines: 800,
    legacy: { 'src/legacy.ts': 900 },
  };
  const runGuard = (baselineRef) =>
    spawnSync(process.execPath, [guardPath, '--require-baseline'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SOURCE_FILE_SIZE_BASELINE_REF: baselineRef },
    });

  try {
    mkdirSync(dirname(guardPath), { recursive: true });
    mkdirSync(dirname(legacyPath), { recursive: true });
    copyFileSync(
      new URL('../../scripts/ci/check-source-file-size.mjs', import.meta.url),
      guardPath
    );
    writeFileSync(policyPath, `${JSON.stringify(baselinePolicy, null, 2)}\n`);
    writeFileSync(legacyPath, 'baseline\n'.repeat(900));
    runGit('init', '--quiet');
    runGit('config', 'user.email', 'source-size-test@example.invalid');
    runGit('config', 'user.name', 'Source Size Test');
    runGit('add', '.');
    runGit('commit', '--quiet', '-m', 'establish source-size baseline');
    const baselineRef = runGit('rev-parse', 'HEAD').trim();

    await t.test('raised maxLines', () => {
      writeFileSync(
        policyPath,
        `${JSON.stringify({ ...baselinePolicy, maxLines: 801 }, null, 2)}\n`
      );
      const result = runGuard(baselineRef);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /global limit 801 exceeds the base limit 800/
      );
    });

    await t.test('new oversized-file exception', () => {
      const newPath = join(root, 'src/new-oversized.ts');
      writeFileSync(newPath, 'new\n'.repeat(850));
      writeFileSync(
        policyPath,
        `${JSON.stringify(
          { maxLines: 800, legacy: { ...baselinePolicy.legacy, 'src/new-oversized.ts': 850 } },
          null,
          2
        )}\n`
      );
      const result = runGuard(baselineRef);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /new oversized-file exceptions are forbidden/
      );
      rmSync(newPath);
    });

    await t.test('file and cap raised together', () => {
      writeFileSync(legacyPath, 'raised\n'.repeat(901));
      writeFileSync(
        policyPath,
        `${JSON.stringify({ maxLines: 800, legacy: { 'src/legacy.ts': 901 } }, null, 2)}\n`
      );
      const result = runGuard(baselineRef);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /legacy cap 901 exceeds the base cap 900/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
