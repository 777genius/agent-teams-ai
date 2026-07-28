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
      'src/features/callback-flat-map/main/infrastructure/Store.ts': 'export class Store {}',
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
      'src/features/callback-block-return/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-frozen/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Object.freeze([0].map(() => Store));
      `,
      'src/features/callback-frozen/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reduce/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].reduce(() => Store, null);
      `,
      'src/features/callback-reduce/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reduce-right/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0, 1].reduceRight(() => Store);
      `,
      'src/features/callback-reduce-right/main/infrastructure/Store.ts': 'export class Store {}',
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
      'src/features/callback-discarded/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-custom-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const source = { map: (_callback: () => unknown) => [] };
        export const api = source.map(() => Store);
      `,
      'src/features/callback-custom-map/main/infrastructure/Store.ts': 'export class Store {}',
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
      'src/features/callback-generator/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reduce-empty/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [].reduce(() => Store, null);
      `,
      'src/features/callback-reduce-empty/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reduce-single/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [0].reduce(() => Store);
      `,
      'src/features/callback-reduce-single/main/infrastructure/Store.ts': 'export class Store {}',
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
      'src/features/callback-map-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-for-each-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].forEach(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-for-each-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-comma-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].forEach((0, () => {
          api.Store = Store;
        }));
      `,
      'src/features/callback-comma-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-filter-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0].filter(() => {
          api.Store = Store;
          return true;
        });
      `,
      'src/features/callback-filter-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-value-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0, Store].forEach((value) => {
          api.Store = value;
        });
      `,
      'src/features/callback-value-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-target-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [{}, api].forEach((target) => {
          target.Store = Store;
        });
      `,
      'src/features/callback-target-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reducer-target-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [{}, api].reduce((_accumulator, target) => {
          target.Store = Store;
          return {};
        }, {});
      `,
      'src/features/callback-reducer-target-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reducer-result-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0, 1].reduce((accumulator) => {
          accumulator.Store = Store;
          return api;
        }, {});
      `,
      'src/features/callback-reducer-result-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-invocation-identity-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const privateObject = { Store };
        export const api: Record<string, unknown> = {};
        [privateObject, api].forEach((target) => {
          target.mark = true;
        });
      `,
      'src/features/callback-invocation-identity-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-destructured-target-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [{ target: {} }, { target: api }].forEach(({ target }) => {
          target.Store = Store;
        });
      `,
      'src/features/callback-destructured-target-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-find-hole-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [,].find(() => { api.find = Store; return false; });
        [,].findIndex(() => { api.findIndex = Store; return false; });
        [,].findLast(() => { api.findLast = Store; return false; });
        [,].findLastIndex(() => { api.findLastIndex = Store; return false; });
      `,
      'src/features/callback-find-hole-mutation/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-target-mutation-before-reassignment/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          target.Store = Store;
          target = {};
        });
      `,
      'src/features/callback-target-mutation-before-reassignment/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-empty-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [].map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-empty-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-custom-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        const source = { map: (callback: () => void) => callback };
        source.map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-custom-mutation/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-short-circuit-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0, Store].some((value) => {
          api.Store = value;
          return true;
        });
      `,
      'src/features/callback-short-circuit-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-static-branch-short-circuit-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [0, Store].some((value) => {
          api.item = value;
          if (true) return true;
          return false;
        });
      `,
      'src/features/callback-static-branch-short-circuit-safe/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/callback-comma-mutation/main/index.ts',
        'src/features/callback-destructured-target-mutation/main/index.ts',

        'src/features/callback-filter-mutation/main/index.ts',
        'src/features/callback-find-hole-mutation/main/index.ts',
        'src/features/callback-for-each-mutation/main/index.ts',
        'src/features/callback-map-mutation/main/index.ts',
        'src/features/callback-reducer-result-mutation/main/index.ts',
        'src/features/callback-reducer-target-mutation/main/index.ts',
        'src/features/callback-target-mutation-before-reassignment/main/index.ts',
        'src/features/callback-target-mutation/main/index.ts',
        'src/features/callback-value-mutation/main/index.ts',
      ]);
    }
  );
});

test('respects lexical for bindings when tracking callback parameter assignments', () => {
  withFeatureFixture(
    {
      'src/features/callback-for-let-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (let target = {}; true; ) {
            target = {};
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-let-shadow/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-for-let-destructured-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (let { target } = { target: {} }; true; ) {
            target = {};
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-let-destructured-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-in-let-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (let target in { item: true }) {
            target = 'shadowed';
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-in-let-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-of-let-destructured-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (let { target } of [{ target: {} }]) {
            target = {};
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-of-let-destructured-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-of-const-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (const target of [{}]) {
            target.inner = true;
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-of-const-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-var-reassignment/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (var target = {}; true; ) {
            target = {};
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-var-reassignment/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-for-const-non-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          for (const { item } = { item: {} }; true; ) {
            target = {};
            break;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-for-const-non-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/callback-for-in-let-shadow/main/index.ts',
        'src/features/callback-for-let-destructured-shadow/main/index.ts',
        'src/features/callback-for-let-shadow/main/index.ts',
        'src/features/callback-for-of-const-shadow/main/index.ts',
        'src/features/callback-for-of-let-destructured-shadow/main/index.ts',
      ]);
    }
  );
});

test('keeps skipped holes, short-circuited find values, and reassigned targets private', () => {
  withFeatureFixture(
    {
      'src/features/callback-skipped-holes/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [,].forEach(() => { api.forEach = Store; });
        [,].map(() => { api.map = Store; });
        [,].flatMap(() => { api.flatMap = Store; });
        [,].filter(() => { api.filter = Store; return true; });
        [,].every(() => { api.every = Store; return true; });
        [,].some(() => { api.some = Store; return false; });
        [,].reduce(() => { api.reduce = Store; return {}; }, {});
        [,].reduceRight(() => { api.reduceRight = Store; return {}; }, {});
      `,
      'src/features/callback-skipped-holes/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-find-first-hole/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const found = [, Store].find(() => true);
        export const foundIndex = [, Store].findIndex(() => true);
        export const foundLast = [Store, ,].findLast(() => true);
        export const foundLastIndex = [Store, ,].findLastIndex(() => true);
      `,
      'src/features/callback-find-first-hole/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/callback-reassigned-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          target = {};
          target.Store = Store;
        });
      `,
      'src/features/callback-reassigned-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-conditionally-reassigned-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const condition: boolean;
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          if (condition) target = {};
          else target = {};
          target.Store = Store;
        });
      `,
      'src/features/callback-conditionally-reassigned-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-conditionally-public-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const condition: boolean;
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          if (condition) target = {};
          else target = api;
          target.Store = Store;
        });
      `,
      'src/features/callback-conditionally-public-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-abruptly-reassigned-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const condition: boolean;
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          if (condition) target = {};
          else return;
          target.Store = Store;
        });
      `,
      'src/features/callback-abruptly-reassigned-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-reassigned-twice-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const condition: boolean;
        export const api: Record<string, unknown> = {};
        [api].forEach((target) => {
          target = {};
          {
            if (condition) target = {};
            else target = api;
          }
          target.Store = Store;
        });
      `,
      'src/features/callback-reassigned-twice-target/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/callback-conditionally-public-target/main/index.ts',
        'src/features/callback-reassigned-twice-target/main/index.ts',
      ]);
    }
  );
});
