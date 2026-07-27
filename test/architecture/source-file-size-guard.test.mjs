import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import {
  collectFiles,
  countPhysicalLines,
  evaluateLegacyManifestRatchet,
  evaluatePolicyManifestRatchet,
  evaluateSourceFileSizePolicy,
  evaluateWorkspaceSourceCoverage,
  isProductionSourcePath,
  parseWorkspacePackagePatterns,
  verifySourceFileSizePolicy,
} from '../../scripts/ci/verify-source-file-size.mjs';

test('counts physical lines across newline styles without adding a trailing phantom line', () => {
  assert.equal(countPhysicalLines(''), 0);
  assert.equal(countPhysicalLines('one'), 1);
  assert.equal(countPhysicalLines('one\n'), 1);
  assert.equal(countPhysicalLines('one\r\ntwo'), 2);
  assert.equal(countPhysicalLines('one\rtwo\r'), 2);
});

test('includes production source roots and excludes tests, declarations, and fixtures', () => {
  assert.equal(isProductionSourcePath('src/main/index.ts'), true);
  assert.equal(isProductionSourcePath('packages/agent-graph/src/index.ts'), true);
  assert.equal(isProductionSourcePath('agent-teams-controller/src/controller.js'), true);
  assert.equal(isProductionSourcePath('mcp-server/src/index.ts'), true);
  assert.equal(isProductionSourcePath('landing/components/AppHeader.vue'), true);
  assert.equal(isProductionSourcePath('landing/assets/styles/hero.scss'), true);
  assert.equal(isProductionSourcePath('src/renderer/index.css'), true);
  assert.equal(isProductionSourcePath('src/main/index.test.ts'), false);
  assert.equal(isProductionSourcePath('src/main/generated.d.ts'), false);
  assert.equal(isProductionSourcePath('src/main/fixtures/example.ts'), false);
  assert.equal(isProductionSourcePath('landing/.nuxt/generated.ts'), false);
  assert.equal(isProductionSourcePath('landing/public/generated.js'), false);
  assert.equal(isProductionSourcePath('scripts/example.ts'), false);
});

test('requires every workspace package to be covered by a production source root', () => {
  const workspacePackagePatterns = parseWorkspacePackagePatterns(`
packages:
  - landing
  - packages/agent-graph
  - uncovered-app
minimumReleaseAge: 4320
`);

  assert.deepEqual(
    evaluateWorkspaceSourceCoverage({
      sourceRoots: ['landing', 'packages'],
      workspacePackagePatterns,
    }),
    [
      {
        code: 'uncovered-workspace-package',
        filePath: 'pnpm-workspace.yaml',
        message: 'workspace package uncovered-app has no production source root',
      },
    ]
  );
});

test('prunes excluded directories before recursively collecting files', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-file-size-'));
  try {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'ignored.ts'), 'ignored');
    writeFileSync(join(root, 'included.ts'), 'included');

    assert.deepEqual(
      collectFiles(root).map((filePath) => basename(filePath)),
      ['included.ts']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects new oversized files and permits exactly 800 lines', () => {
  const diagnostics = evaluateSourceFileSizePolicy({
    lineCounts: new Map([
      ['src/new-ok.ts', 800],
      ['src/new-too-large.ts', 801],
    ]),
    legacyMaxLines: {},
  });

  assert.deepEqual(
    diagnostics.map(({ code, filePath }) => ({ code, filePath })),
    [{ code: 'unapproved-oversized-file', filePath: 'src/new-too-large.ts' }]
  );
});

test('requires every legacy cap to stay exact and disappear after refactoring below the limit', () => {
  const legacyMaxLines = {
    'src/grew.ts': 900,
    'src/reduced.ts': 900,
    'src/refactored.ts': 900,
    'src/unchanged.ts': 900,
  };
  const diagnostics = evaluateSourceFileSizePolicy({
    lineCounts: new Map([
      ['src/grew.ts', 901],
      ['src/reduced.ts', 850],
      ['src/refactored.ts', 800],
      ['src/unchanged.ts', 900],
    ]),
    legacyMaxLines,
  });

  assert.deepEqual(
    diagnostics.map(({ code, filePath }) => ({ code, filePath })),
    [
      { code: 'legacy-file-grew', filePath: 'src/grew.ts' },
      { code: 'legacy-cap-not-tight', filePath: 'src/reduced.ts' },
      { code: 'stale-legacy-exception', filePath: 'src/refactored.ts' },
    ]
  );
});

test('forbids new legacy exceptions and raised caps relative to the PR base', () => {
  const diagnostics = evaluateLegacyManifestRatchet({
    baselineLegacyMaxLines: {
      'src/lowered.ts': 950,
      'src/raised.ts': 900,
      'src/removed.ts': 850,
    },
    legacyMaxLines: {
      'src/lowered.ts': 925,
      'src/new-exception.ts': 900,
      'src/raised.ts': 901,
    },
  });

  assert.deepEqual(
    diagnostics.map(({ code, filePath }) => ({ code, filePath })),
    [
      { code: 'new-legacy-exception', filePath: 'src/new-exception.ts' },
      { code: 'raised-legacy-cap', filePath: 'src/raised.ts' },
    ]
  );
});

test('uses base source sizes to repair stale manifests without widening the ratchet', () => {
  const diagnostics = evaluateLegacyManifestRatchet({
    baselineLegacyMaxLines: {
      'src/stale-cap.ts': 900,
    },
    baselineSourceLineCounts: new Map([
      ['src/stale-cap.ts', 925],
      ['src/stale-path.ts', 910],
      ['src/grew.ts', 900],
    ]),
    legacyMaxLines: {
      'src/grew.ts': 901,
      'src/new-exception.ts': 900,
      'src/stale-cap.ts': 925,
      'src/stale-path.ts': 910,
    },
  });

  assert.deepEqual(
    diagnostics.map(({ code, filePath }) => ({ code, filePath })),
    [
      { code: 'raised-legacy-cap', filePath: 'src/grew.ts' },
      { code: 'new-legacy-exception', filePath: 'src/new-exception.ts' },
    ]
  );
});

test('ratchets legacy caps from the complete existing source-size policy', () => {
  const diagnostics = evaluatePolicyManifestRatchet({
    baselinePolicy: {
      maxLines: 800,
      legacy: {
        'scripts/hosted-web/legacy.mjs': 900,
      },
    },
    policy: {
      maxLines: 801,
      legacy: {
        'eslint.config.js': 1000,
        'scripts/hosted-web/legacy.mjs': 901,
      },
    },
  });

  assert.deepEqual(
    diagnostics.map(({ code, filePath }) => ({ code, filePath })),
    [
      {
        code: 'raised-global-limit',
        filePath: 'scripts/ci/source-file-size-baseline.json',
      },
      { code: 'new-legacy-exception', filePath: 'eslint.config.js' },
      { code: 'raised-legacy-cap', filePath: 'scripts/hosted-web/legacy.mjs' },
    ]
  );
});

test('keeps the checked-in legacy snapshot synchronized with the source tree', () => {
  const result = verifySourceFileSizePolicy();

  assert.ok(result.productionFileCount > result.legacyFileCount);
  assert.ok(result.legacyFileCount > 0);
});

test('CI package guard rejects source and legacy cap growth from the base commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-file-size-ci-'));
  const packageScripts = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ).scripts;
  const ciGuardScript = packageScripts['guard:source-file-size:ci'];

  assert.match(packageScripts['validate:ci'], /^pnpm guard:source-file-size:ci(?: &&|$)/);
  assert.equal(ciGuardScript, 'node ./scripts/ci/verify-source-file-size.mjs --require-baseline');

  const runGit = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const runCiGuard = (baselineRef) => {
    const env = { ...process.env };
    if (baselineRef === undefined) delete env.SOURCE_FILE_SIZE_BASELINE_REF;
    else env.SOURCE_FILE_SIZE_BASELINE_REF = baselineRef;
    return spawnSync('pnpm', ['guard:source-file-size:ci'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
  };
  const commandOutput = (result) => `${result.stdout}\n${result.stderr}`;

  try {
    const sourceRoots = [
      'src',
      'packages',
      'agent-teams-controller/src',
      'landing',
      'mcp-server/src',
    ];
    for (const sourceRoot of sourceRoots) {
      mkdirSync(join(root, sourceRoot), { recursive: true });
    }
    const verifierPath = join(root, 'scripts/ci/verify-source-file-size.mjs');
    mkdirSync(dirname(verifierPath), { recursive: true });
    copyFileSync(
      new URL('../../scripts/ci/verify-source-file-size.mjs', import.meta.url),
      verifierPath
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'source-size-ci-fixture',
        private: true,
        scripts: {
          'guard:source-file-size:ci': ciGuardScript,
        },
      })
    );
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(
      join(root, 'scripts/ci/source-file-size-legacy.json'),
      JSON.stringify({ 'src/legacy.ts': 1000 })
    );
    writeFileSync(join(root, 'src/legacy.ts'), 'baseline\n'.repeat(1000));
    const broadLegacyPath = 'scripts/hosted-web/legacy.mjs';
    mkdirSync(join(root, dirname(broadLegacyPath)), { recursive: true });
    writeFileSync(join(root, broadLegacyPath), 'baseline\n'.repeat(900));
    writeFileSync(
      join(root, 'scripts/ci/source-file-size-baseline.json'),
      JSON.stringify({
        maxLines: 800,
        legacy: {
          [broadLegacyPath]: 900,
          'src/legacy.ts': 1000,
        },
      })
    );

    runGit('init', '--quiet');
    runGit('config', 'user.email', 'source-size-test@example.invalid');
    runGit('config', 'user.name', 'Source Size Test');
    runGit('add', '.');
    runGit('commit', '--quiet', '-m', 'test: establish source-size baseline');
    const baselineRef = runGit('rev-parse', 'HEAD').trim();

    writeFileSync(
      join(root, 'scripts/ci/source-file-size-legacy.json'),
      JSON.stringify({ 'src/legacy.ts': 1100 })
    );
    writeFileSync(join(root, 'src/legacy.ts'), 'head\n'.repeat(1100));
    writeFileSync(join(root, broadLegacyPath), 'head\n'.repeat(950));
    writeFileSync(
      join(root, 'scripts/ci/source-file-size-baseline.json'),
      JSON.stringify({
        maxLines: 800,
        legacy: {
          [broadLegacyPath]: 950,
          'src/legacy.ts': 1100,
        },
      })
    );

    const missingBaseline = runCiGuard(undefined);
    assert.notEqual(missingBaseline.status, 0);
    assert.match(commandOutput(missingBaseline), /BASELINE_REF is required/);

    const invalidBaseline = runCiGuard('not-a-commit');
    assert.notEqual(invalidBaseline.status, 0);
    assert.match(commandOutput(invalidBaseline), /must be a 40-character commit SHA/);

    const firstPush = runCiGuard('0'.repeat(40));
    assert.equal(firstPush.status, 0, commandOutput(firstPush));

    const raisedCap = runCiGuard(baselineRef);
    assert.notEqual(raisedCap.status, 0);
    assert.match(commandOutput(raisedCap), /\[raised-legacy-cap\] src\/legacy\.ts/);
    assert.match(
      commandOutput(raisedCap),
      /\[raised-legacy-cap\] scripts\/hosted-web\/legacy\.mjs/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
