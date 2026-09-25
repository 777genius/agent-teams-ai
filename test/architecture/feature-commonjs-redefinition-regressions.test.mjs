import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

const STORE_SOURCE = 'exports.Store = class Store {};';

function implementationViolationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function commonJsFixtures(entries) {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([feature, source]) => [
      [`src/features/${feature}/main/index.cjs`, source],
      [`src/features/${feature}/main/infrastructure/Store.cjs`, STORE_SOURCE],
    ])
  );
}

test('keeps exports linked across CommonJS root self-assignments', () => {
  withFeatureFixture(
    commonJsFixtures({
      'commonjs-module-self-assignment': `
        module.exports = module.exports;
        exports.Store = require('./infrastructure/Store');
      `,
      'commonjs-exports-self-assignment': `
        exports = exports;
        exports.Store = require('./infrastructure/Store');
      `,
      'commonjs-detached-self-assignment-safe': `
        module.exports = {};
        module.exports = module.exports;
        exports.Store = require('./infrastructure/Store');
      `,
    }),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-exports-self-assignment/main/index.cjs',
        'src/features/commonjs-module-self-assignment/main/index.cjs',
      ]);
    }
  );
});

test('does not treat rejected or attribute-only redefinitions as overwrites', () => {
  withFeatureFixture(
    commonJsFixtures({
      'commonjs-reflect-redefine-locked': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        Reflect.defineProperty(exports, 'Store', { value: undefined });
      `,
      'commonjs-reflect-redefine-configurable-safe': `
        Object.defineProperty(exports, 'Store', {
          configurable: true,
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        Reflect.defineProperty(exports, 'Store', { value: undefined });
      `,
      'commonjs-attribute-only-redefine': `
        Object.defineProperty(exports, 'Store', {
          configurable: true,
          value: require('./infrastructure/Store'),
        });
        Object.defineProperty(exports, 'Store', { enumerable: true });
      `,
      'commonjs-attribute-only-redefine-map': `
        Object.defineProperty(exports, 'Store', {
          configurable: true,
          value: require('./infrastructure/Store'),
        });
        Object.defineProperties(exports, { Store: { enumerable: true } });
      `,
    }),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-attribute-only-redefine-map/main/index.cjs',
        'src/features/commonjs-attribute-only-redefine/main/index.cjs',
        'src/features/commonjs-reflect-redefine-locked/main/index.cjs',
      ]);
    }
  );
});

test('keeps defined values unknown for logical assignments', () => {
  withFeatureFixture(
    commonJsFixtures({
      'commonjs-defined-logical-or': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
          writable: true,
        });
        exports.Store ||= undefined;
      `,
      'commonjs-defined-nullish-coalescing': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
          writable: true,
        });
        exports.Store ??= undefined;
      `,
      'commonjs-absent-logical-or-safe': `
        exports.Store = require('./infrastructure/Store');
        exports.Store = undefined;
        exports.Store ||= null;
      `,
    }),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-defined-logical-or/main/index.cjs',
        'src/features/commonjs-defined-nullish-coalescing/main/index.cjs',
      ]);
    }
  );
});
