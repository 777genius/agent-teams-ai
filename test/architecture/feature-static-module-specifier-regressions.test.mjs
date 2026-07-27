import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  collectModuleEdgesFromSource,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationViolations(root) {
  return collectFeatureArchitectureViolations(root).violations.filter(
    ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
  );
}

test('folds exact static module specifiers before applying public API rules', () => {
  withFeatureFixture(
    {
      'src/features/concat-specifier/main/index.cjs': `
        module.exports.Store =
          require('./infrastructure/' + 'Store').Store;
      `,
      'src/features/concat-specifier/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/dynamic-template-specifier/main/index.ts': `
        const layer = 'infrastructure';
        export const api =
          import(\`./\${layer}/Store\`).then((module) => module.Store);
      `,
      'src/features/dynamic-template-specifier/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/local-specifier/main/index.cjs': `
        module.exports.Store = (() => {
          const directory = './infrastructure/';
          const specifier = directory + 'Store';
          return require(specifier).Store;
        })();
      `,
      'src/features/local-specifier/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ source, specifier }) => ({
          source,
          specifier,
        })),
        [
          {
            source: 'src/features/concat-specifier/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/dynamic-template-specifier/main/index.ts',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/local-specifier/main/index.cjs',
            specifier: './infrastructure/Store',
          },
        ]
      );
    }
  );
});

test('uses exact lexical reaching values without guessing ambiguous specifiers', () => {
  const source = `
    const captured = './captured';
    function capture() {
      require(captured);
    }

    const shadowed = 'node:fs';
    {
      const shadowed = './block-safe';
      module.require(shadowed);
    }
    function parameterShadow(shadowed) {
      require(shadowed);
    }

    let rebound = 'node:path';
    rebound = './rebound-safe';
    require(rebound);

    let conditional = './conditional-safe';
    if (runtime) conditional = 'node:child_process';
    require(conditional);

    let first = second;
    let second = first;
    require(first);
  `;

  assert.deepEqual(
    collectModuleEdgesFromSource(source, 'src/features/specifier-scope/main/index.cjs')
      .map(({ specifier }) => specifier)
      .sort(),
    ['./block-safe', './captured', './rebound-safe']
  );
});
