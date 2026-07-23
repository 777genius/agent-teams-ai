import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  collectFiles,
  countPhysicalLines,
  evaluateLegacyManifestRatchet,
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

test('keeps the checked-in legacy snapshot synchronized with the source tree', () => {
  const result = verifySourceFileSizePolicy();

  assert.ok(result.productionFileCount > result.legacyFileCount);
  assert.ok(result.legacyFileCount > 0);
});
