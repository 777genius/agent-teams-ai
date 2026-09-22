import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  toBaselineEntry,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import {
  evaluateFeatureArchitectureRatchet,
  validateFeatureArchitectureBaseline,
} from '../../scripts/ci/verify-feature-architecture.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

test('ratchets each public implementation export by its symbol identity', () => {
  withFeatureFixture(
    {
      'src/features/symbol-identity/main/index.ts': `
        export { First, First as FirstAlias, Second } from './barrel';
      `,
      'src/features/symbol-identity/main/barrel.ts': `
        export { First, Second } from './infrastructure/implementations';
      `,
      'src/features/symbol-identity/main/infrastructure/implementations.ts': `
        export class First {}
        export class Second {}
      `,
    },
    (root) => {
      const violations = collectFeatureArchitectureViolations(root).violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
      );
      const entries = violations.map(toBaselineEntry);

      assert.deepEqual(entries, [
        {
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/symbol-identity/main/barrel.ts',
          specifier: './infrastructure/implementations',
          publicEntrypoint: 'src/features/symbol-identity/main/index.ts',
          exportedName: 'First',
          importedName: 'First',
        },
        {
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/symbol-identity/main/barrel.ts',
          specifier: './infrastructure/implementations',
          publicEntrypoint: 'src/features/symbol-identity/main/index.ts',
          exportedName: 'FirstAlias',
          importedName: 'First',
        },
        {
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/symbol-identity/main/barrel.ts',
          specifier: './infrastructure/implementations',
          publicEntrypoint: 'src/features/symbol-identity/main/index.ts',
          exportedName: 'Second',
          importedName: 'Second',
        },
      ]);

      assert.deepEqual(
        evaluateFeatureArchitectureRatchet({
          baselineEntries: entries.slice(0, 2),
          baselineReferenceEntries: null,
          violations,
        }).map(({ code, entry }) => ({ code, exportedName: entry.exportedName })),
        [{ code: 'new-architecture-violation', exportedName: 'Second' }]
      );
    }
  );
});

test('rejects public baseline entries without exact symbol identities', () => {
  const validation = validateFeatureArchitectureBaseline({
    version: 2,
    violations: [
      {
        rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
        source: 'src/features/example/main/index.ts',
        specifier: './infrastructure/Store',
        publicEntrypoint: 'src/features/example/main/index.ts',
      },
    ],
  });

  assert.deepEqual(
    validation.diagnostics.map(({ code }) => code),
    ['missing-public-export-identity']
  );
});
