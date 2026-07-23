import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  collectModuleEdgesFromSource,
  toBaselineEntry,
  violationKey,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import {
  evaluateFeatureArchitectureRatchet,
  validateFeatureArchitectureBaseline,
  verifyFeatureArchitecture,
} from '../../scripts/ci/verify-feature-architecture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withFixture(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'feature-architecture-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, source);
    }
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function baselineEntry(rule, source, specifier, publicEntrypoint) {
  const entry = { rule, source, specifier };
  if (publicEntrypoint) entry.publicEntrypoint = publicEntrypoint;
  return entry;
}

function architectureViolation(rule, source, specifier) {
  return {
    line: 1,
    message: 'fixture violation',
    rule,
    source,
    specifier,
  };
}

test('collects static, dynamic, CommonJS, and re-export dependency edges', () => {
  const edges = collectModuleEdgesFromSource(
    `
      import type { Contract } from './contract';
      export { facade } from './facade';
      const lazy = import('./lazy');
      const attributed = import('./attributed', { with: { type: 'json' } });
      const legacy = require('./legacy');
      const invalidLegacy = require('./ignored', 'utf8');
    `,
    'src/features/example/main/index.ts'
  );

  assert.deepEqual(
    edges.map(({ kind, specifier }) => ({ kind, specifier })),
    [
      { kind: 'import', specifier: './contract' },
      { kind: 'export', specifier: './facade' },
      { kind: 'import', specifier: './lazy' },
      { kind: 'import', specifier: './attributed' },
      { kind: 'import', specifier: './legacy' },
    ]
  );
});

test('requires public entrypoints for alias and relative cross-feature dependencies', () => {
  withFixture(
    {
      'src/features/alpha/core/application/useCase.ts': `
        import type { Contract } from '@features/beta/contracts';
        import { ownRule } from '@features/alpha/core/domain/ownRule';
      `,
      'src/features/alpha/core/domain/ownRule.ts': 'export const ownRule = true;',
      'src/features/alpha/main/composition/createAlpha.ts': `
        import { privateRule } from '@features/beta/core/domain/privateRule';
      `,
      'src/features/beta/contracts/index.ts': 'export interface Contract {}',
      'src/features/beta/core/domain/privateRule.ts': 'export const privateRule = true;',
      'src/main/relativeFeatureImport.ts': `
        import { privateRule } from '../features/beta/core/domain/privateRule';
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const crossFeatureViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint
      );

      assert.deepEqual(
        crossFeatureViolations.map(({ source, specifier }) => ({ source, specifier })),
        [
          {
            source: 'src/features/alpha/main/composition/createAlpha.ts',
            specifier: '@features/beta/core/domain/privateRule',
          },
          {
            source: 'src/main/relativeFeatureImport.ts',
            specifier: '../features/beta/core/domain/privateRule',
          },
        ]
      );
    }
  );
});

test('keeps core domain free from application and runtime dependencies', () => {
  withFixture(
    {
      'src/features/example/core/domain/policy.ts': `
        import path from 'node:path';
        import electron from 'electron';
        import fastify from 'fastify';
        import type { Input } from '../application/model';
        import { store } from '../../main/infrastructure/store';
        import type { Id } from '@shared/contracts/hosted/identifiers';
        import { z } from 'zod';
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const domainViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreDomainIsolation
      );

      assert.deepEqual(domainViolations.map(({ specifier }) => specifier).sort(), [
        '../../main/infrastructure/store',
        '../application/model',
        'electron',
        'fastify',
        'node:path',
      ]);
    }
  );
});

test('allows application domain, contracts, and own ports while rejecting outer dependencies', () => {
  withFixture(
    {
      'src/features/example/core/application/useCase.ts': `
        import { rule } from '../domain/rule';
        import type { Contract } from '../../contracts';
        import type { Clock } from './ports/Clock';
        import type { SharedId } from '@shared/contracts/hosted/identifiers';
        import type { OtherContract } from '@features/other/contracts';
        import type { LegacyType } from '@shared/types';
        import fs from 'node:fs';
        import { otherFacade } from '@features/other';
        import { store } from '../../main/infrastructure/store';
      `,
      'src/features/example/contracts/index.ts': 'export interface Contract {}',
      'src/features/example/core/application/ports/Clock.ts': 'export interface Clock {}',
      'src/features/example/core/domain/rule.ts': 'export const rule = true;',
      'src/features/other/contracts/index.ts': 'export interface OtherContract {}',
      'src/features/other/index.ts': 'export const otherFacade = true;',
      'src/shared/contracts/hosted/identifiers.ts': 'export type SharedId = string;',
      'src/shared/types.ts': 'export interface LegacyType {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const applicationViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies
      );

      assert.deepEqual(applicationViolations.map(({ specifier }) => specifier).sort(), [
        '../../main/infrastructure/store',
        '@features/other',
        '@shared/types',
        'node:fs',
      ]);
    }
  );
});

test('fails the end-to-end gate for a new violation in a new feature', () => {
  withFixture(
    {
      'scripts/ci/feature-architecture-baseline.json': JSON.stringify({
        version: 1,
        violations: [],
      }),
      'src/features/new-feature/core/domain/rule.ts': `import path from 'node:path';`,
    },
    (root) => {
      assert.throws(
        () => verifyFeatureArchitecture({ baselineRef: null, root }),
        /new-architecture-violation.*new-feature.*node:path/s
      );
    }
  );
});

test('detects implementation exports through transitive internal barrels', () => {
  withFixture(
    {
      'src/features/example/main/index.ts': `
        import { Store } from './public';
        import { safe } from './safePublic';
        export { safe, Store };
      `,
      'src/features/example/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/example/main/public.ts': `
        import { Store } from './infrastructure/Store';
        export { Store };
      `,
      'src/features/example/main/safePublic.ts': `
        export const safe = true;
        export * from './infrastructure/Store';
      `,
      'src/features/example/renderer/adapters/Adapter.ts': `
        export class Adapter {}
      `,
      'src/features/example/renderer/index.ts': `
        import * as adapters from './adapters/Adapter';
        export default adapters.Adapter;
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const publicApiViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
      );

      assert.deepEqual(publicApiViolations.map(toBaselineEntry), [
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/public.ts',
          specifier: './infrastructure/Store',
        },
        {
          publicEntrypoint: 'src/features/example/renderer/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/renderer/index.ts',
          specifier: './adapters/Adapter',
        },
      ]);
    }
  );
});

test('uses stable dependency identities that ignore line movement', () => {
  const first = architectureViolation(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );
  const moved = { ...first, line: 400 };

  assert.equal(violationKey(first), violationKey(moved));
});

test('rejects new and stale dependency edges independently within the same legacy file', () => {
  const source = 'src/features/example/core/application/useCase.ts';
  const legacy = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    source,
    '@shared/types'
  );
  const added = architectureViolation(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    source,
    '@shared/utils/errorHandling'
  );

  assert.deepEqual(
    evaluateFeatureArchitectureRatchet({
      baselineEntries: [legacy],
      baselineReferenceEntries: null,
      violations: [added],
    }).map(({ code, entry }) => ({ code, specifier: entry.specifier })),
    [
      { code: 'new-architecture-violation', specifier: '@shared/utils/errorHandling' },
      { code: 'stale-baseline-entry', specifier: '@shared/types' },
    ]
  );
});

test('forbids baseline expansion relative to the PR base while allowing removals', () => {
  const retained = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );
  const added = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'electron'
  );

  assert.deepEqual(
    evaluateFeatureArchitectureRatchet({
      baselineEntries: [retained, added],
      baselineReferenceEntries: [retained],
      violations: [
        { ...retained, line: 1, message: 'retained violation' },
        { ...added, line: 2, message: 'added violation' },
      ],
    }).map(({ code, entry }) => ({ code, specifier: entry.specifier })),
    [{ code: 'baseline-expansion', specifier: 'electron' }]
  );
});

test('validates baseline schema, uniqueness, and canonical ordering', () => {
  const later = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
    'src/features/example/main/index.ts',
    './infrastructure/store',
    'src/features/example/main/index.ts'
  );
  const earlier = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );

  const validation = validateFeatureArchitectureBaseline({
    version: 1,
    violations: [later, earlier, earlier],
  });

  assert.deepEqual(
    validation.diagnostics.map(({ code }) => code),
    ['duplicate-baseline-entry', 'unsorted-baseline']
  );
});

test('keeps the checked-in exact-edge baseline synchronized with production source', () => {
  const result = verifyFeatureArchitecture({ baselineRef: null, root: repoRoot });

  assert.equal(result.baselineEntries.length, result.violations.length);
  assert.ok(result.sourceFileCount > result.violations.length);
  assert.ok(result.violations.length > 0);
});
