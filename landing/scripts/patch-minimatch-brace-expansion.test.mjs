import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  patchInstalledLegacyMinimatch,
  rewriteLegacyMinimatchSource,
  writeFileAtomically,
} from './patch-minimatch-brace-expansion.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(braceExpansionSource) {
  const landingRoot = mkdtempSync(join(tmpdir(), 'landing-minimatch-patch-'));
  temporaryDirectories.push(landingRoot);
  const packagePath = 'node_modules/minimatch';
  const packageDirectory = join(landingRoot, packagePath);
  const braceExpansionDirectory = join(packageDirectory, 'node_modules/brace-expansion');
  mkdirSync(braceExpansionDirectory, { recursive: true });
  const entrypointPath = join(packageDirectory, 'minimatch.js');
  const legacySource = [
    "'use strict'",
    "var expand = require('brace-expansion')",
    'module.exports = minimatch',
    'minimatch.braceExpand = braceExpand',
    'function minimatch(value, pattern) {',
    '  return braceExpand(pattern).includes(value)',
    '}',
    'function braceExpand(pattern) {',
    '  return expand(pattern)',
    '}',
  ].join('\n');
  writeFileSync(entrypointPath, legacySource, 'utf8');
  writeFileSync(join(braceExpansionDirectory, 'index.js'), braceExpansionSource, 'utf8');

  return {
    entrypointPath,
    landingRoot,
    legacySource,
    lockfile: {
      packages: {
        [packagePath]: {
          version: '3.1.5',
          dependencies: { 'brace-expansion': '^1.1.7' },
        },
      },
    },
  };
}

function createLinkedFixture() {
  const landingRoot = mkdtempSync(join(tmpdir(), 'landing-minimatch-linked-'));
  temporaryDirectories.push(landingRoot);
  const packageDirectory = join(
    landingRoot,
    'node_modules/.store/minimatch@opaque-fixture-hash/node_modules/minimatch',
  );
  const braceExpansionDirectory = join(packageDirectory, 'node_modules/brace-expansion');
  mkdirSync(braceExpansionDirectory, { recursive: true });
  const entrypointPath = join(packageDirectory, 'minimatch.js');
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'minimatch',
      version: '3.1.5',
      dependencies: { 'brace-expansion': '^1.1.7' },
    }),
    'utf8',
  );
  writeFileSync(
    entrypointPath,
    [
      "'use strict'",
      "var expand = require('brace-expansion')",
      'module.exports = minimatch',
      'minimatch.braceExpand = braceExpand',
      'function minimatch(value, pattern) { return braceExpand(pattern).includes(value) }',
      'function braceExpand(pattern) { return expand(pattern) }',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(braceExpansionDirectory, 'index.js'),
    "module.exports = { expand: () => ['left', 'right'] }\n",
    'utf8',
  );

  return {
    entrypointPath,
    landingRoot,
    lockfile: {
      packages: {
        'node_modules/logical-parent/node_modules/minimatch': {
          version: '3.1.5',
          dependencies: { 'brace-expansion': '^1.1.7' },
        },
      },
    },
  };
}

describe('landing minimatch brace-expansion compatibility patch', () => {
  it('patches a legacy import and remains idempotent', () => {
    const legacySource = [
      "'use strict'",
      "const expand = require('brace-expansion');",
      'module.exports = pattern => expand(pattern)',
    ].join('\n');

    const firstPass = rewriteLegacyMinimatchSource(legacySource, 'node_modules/minimatch');
    const secondPass = rewriteLegacyMinimatchSource(firstPass.source, 'node_modules/minimatch');

    assert.equal(firstPass.patched, true);
    assert.deepEqual(secondPass, { patched: false, source: firstPass.source });
  });

  it('rejects a partially written compatibility bridge', () => {
    const partialSource = [
      "'use strict'",
      "var braceExpansion = require('brace-expansion')",
      'module.exports = pattern => expand(pattern)',
    ].join('\n');

    assert.throws(
      () => rewriteLegacyMinimatchSource(partialSource, 'node_modules/minimatch'),
      /unsupported brace-expansion import/,
    );
  });

  it('replaces files atomically without changing their mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'landing-minimatch-atomic-write-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'minimatch.js');
    writeFileSync(filePath, 'before', 'utf8');
    chmodSync(filePath, 0o640);

    writeFileAtomically(filePath, 'after');

    assert.equal(readFileSync(filePath, 'utf8'), 'after');
    assert.equal(statSync(filePath).mode & 0o777, 0o640);
  });

  it('verifies staged code before replacing the installed entrypoint', () => {
    const fixture = createFixture("'use strict'\nmodule.exports = {}\n");

    assert.throws(
      () =>
        patchInstalledLegacyMinimatch({
          landingRoot: fixture.landingRoot,
          lockfile: fixture.lockfile,
        }),
      /compatibility verification failed/,
    );
    assert.equal(readFileSync(fixture.entrypointPath, 'utf8'), fixture.legacySource);
    assert.deepEqual(readdirSync(join(fixture.landingRoot, 'node_modules/minimatch')).sort(), [
      'minimatch.js',
      'node_modules',
    ]);
  });

  it('leaves earlier targets unchanged when a later target is unsupported', () => {
    const fixture = createFixture("module.exports = { expand: () => ['left', 'right'] }\n");
    const unsupportedPackagePath = 'node_modules/unsupported/node_modules/minimatch';
    const unsupportedDirectory = join(fixture.landingRoot, unsupportedPackagePath);
    mkdirSync(unsupportedDirectory, { recursive: true });
    const unsupportedSource =
      "var braceExpansion = require('brace-expansion')\nmodule.exports = expand\n";
    writeFileSync(join(unsupportedDirectory, 'minimatch.js'), unsupportedSource, 'utf8');
    fixture.lockfile.packages[unsupportedPackagePath] = {
      version: '5.1.9',
      dependencies: { 'brace-expansion': '^2.0.1' },
    };

    assert.throws(
      () =>
        patchInstalledLegacyMinimatch({
          landingRoot: fixture.landingRoot,
          lockfile: fixture.lockfile,
        }),
      /unsupported brace-expansion import/,
    );
    assert.equal(readFileSync(fixture.entrypointPath, 'utf8'), fixture.legacySource);
    assert.equal(
      readFileSync(join(unsupportedDirectory, 'minimatch.js'), 'utf8'),
      unsupportedSource,
    );
  });

  it('commits a verified bridge and keeps subsequent runs byte-identical', () => {
    const fixture = createFixture(
      [
        "'use strict'",
        'module.exports = {',
        "  expand: pattern => pattern === '{left,right}' ? ['left', 'right'] : [pattern],",
        '}',
      ].join('\n'),
    );
    mkdirSync(join(fixture.landingRoot, 'node_modules/.store'), { recursive: true });

    const firstRun = patchInstalledLegacyMinimatch({
      landingRoot: fixture.landingRoot,
      lockfile: fixture.lockfile,
    });
    const patchedSource = readFileSync(fixture.entrypointPath, 'utf8');
    const secondRun = patchInstalledLegacyMinimatch({
      landingRoot: fixture.landingRoot,
      lockfile: fixture.lockfile,
    });

    assert.deepEqual(firstRun, { patchedCount: 1, verifiedLegacyCount: 1 });
    assert.deepEqual(secondRun, { patchedCount: 0, verifiedLegacyCount: 1 });
    assert.equal(readFileSync(fixture.entrypointPath, 'utf8'), patchedSource);
  });

  it('discovers and patches npm linked-layout packages by verified store metadata', () => {
    const fixture = createLinkedFixture();

    const result = patchInstalledLegacyMinimatch({
      installStrategy: 'linked',
      landingRoot: fixture.landingRoot,
      lockfile: fixture.lockfile,
    });

    assert.deepEqual(result, { patchedCount: 1, verifiedLegacyCount: 1 });
    assert.match(readFileSync(fixture.entrypointPath, 'utf8'), /braceExpansion\.expand/);
  });
});
