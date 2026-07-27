import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

test('traces definite synchronous array callback results into public values', () => {
  withFeatureFixture(
    {
      'src/features/callback-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].map(() => Store);
      `,
      'src/features/callback-map/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-flat-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default [0].flatMap(() => [Store]);
      `,
      'src/features/callback-flat-map/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-commonjs/main/index.cjs': `
        module.exports = [0].map(() =>
          require('./infrastructure/Store')
        );
      `,
      'src/features/callback-commonjs/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/callback-block-return/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {
          values: [0].map(() => {
            return { Store };
          }),
        };
      `,
      'src/features/callback-block-return/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-frozen/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Object.freeze([0].map(() => Store));
      `,
      'src/features/callback-frozen/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reduce/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].reduce(() => Store, null);
      `,
      'src/features/callback-reduce/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reduce-right/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0, 1].reduceRight(() => Store);
      `,
      'src/features/callback-reduce-right/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/callback-block-return/main/index.ts',
        'src/features/callback-commonjs/main/index.cjs',
        'src/features/callback-flat-map/main/index.ts',
        'src/features/callback-frozen/main/index.ts',
        'src/features/callback-map/main/index.ts',
        'src/features/callback-reduce-right/main/index.ts',
        'src/features/callback-reduce/main/index.ts',
      ]);
    }
  );
});

test('keeps discarded, deferred, non-result, and non-executing callbacks private', () => {
  withFeatureFixture(
    {
      'src/features/callback-discarded/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        [0].map(() => Store);
      `,
      'src/features/callback-discarded/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-custom-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const source = { map: (_callback: () => unknown) => [] };
        export const api = source.map(() => Store);
      `,
      'src/features/callback-custom-map/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-promise/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Promise.resolve().then(() => Store);
      `,
      'src/features/callback-promise/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-filter/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].filter(() => Boolean(Store));
      `,
      'src/features/callback-filter/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-empty/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [].map(() => Store);
      `,
      'src/features/callback-empty/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-sparse/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [,].map(() => Store);
      `,
      'src/features/callback-sparse/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-length/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].map(() => Store).length;
      `,
      'src/features/callback-length/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-generator/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].map(function* () {
          return Store;
        });
      `,
      'src/features/callback-generator/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reduce-empty/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [].reduce(() => Store, null);
      `,
      'src/features/callback-reduce-empty/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reduce-single/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].reduce(() => Store);
      `,
      'src/features/callback-reduce-single/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), []);
    }
  );
});

test('traces public mutations from definitely executed synchronous array callbacks', () => {
  withFeatureFixture(
    {
      'src/features/callback-map-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-map-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-each-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].forEach(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-for-each-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-filter-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].filter(() => {
          api.Store = Store;
          return true;
        });
      `,
      'src/features/callback-filter-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-empty-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [].map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-empty-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-custom-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        const source = { map: (callback: () => void) => callback };
        source.map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-custom-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/callback-filter-mutation/main/index.ts',
        'src/features/callback-for-each-mutation/main/index.ts',
        'src/features/callback-map-mutation/main/index.ts',
      ]);
    }
  );
});
