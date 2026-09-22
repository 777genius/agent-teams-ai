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
    .map(({ source }) => source);
}

function storeSource() {
  return 'export class Store {}';
}

function withStores(fixtures) {
  return Object.fromEntries(
    Object.entries(fixtures).flatMap(([name, source]) => [
      [`src/features/${name}/main/index.ts`, source],
      [`src/features/${name}/main/infrastructure/Store.ts`, storeSource()],
    ])
  );
}

test('models ESM logical property assignments as conditional terminal writes', () => {
  withFeatureFixture(
    withStores({
      'logical-and-terminal-safe': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        api.Store &&= undefined;
      `,
      'logical-and-missing-safe': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        api.Store &&= Store;
      `,
      'logical-or-truthy-safe': `
        import { Store } from './infrastructure/Store';
        export const api = { Store: {} };
        api.Store ||= Store;
      `,
      'logical-nullish-truthy-safe': `
        import { Store } from './infrastructure/Store';
        export const api = { Store: {} };
        api.Store ??= Store;
      `,
      'logical-or-preserves-public': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        api.Store ||= undefined;
      `,
      'logical-nullish-preserves-public': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        api.Store ??= undefined;
      `,
      'logical-and-unknown-public': `
        import { Store } from './infrastructure/Store';
        declare const replacement: unknown;
        export const api = { Store };
        api.Store &&= replacement;
      `,
      'logical-and-rhs-public': `
        import { Store } from './infrastructure/Store';
        export const api = { Store: {} };
        api.Store &&= Store;
      `,
      'logical-or-rhs-public': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        api.Store ||= Store;
      `,
      'logical-nullish-rhs-public': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        api.Store ??= Store;
      `,
    }),
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/logical-and-rhs-public/main/index.ts',
        'src/features/logical-and-unknown-public/main/index.ts',
        'src/features/logical-nullish-preserves-public/main/index.ts',
        'src/features/logical-nullish-rhs-public/main/index.ts',
        'src/features/logical-or-preserves-public/main/index.ts',
        'src/features/logical-or-rhs-public/main/index.ts',
      ]);
    }
  );
});

test('preserves object aliases only when logical assignment cannot replace them', () => {
  withFeatureFixture(
    withStores({
      'logical-or-preserves-object-alias': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target ||= {};
        target.Store = Store;
      `,
      'logical-nullish-preserves-object-alias': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target ??= {};
        target.Store = Store;
      `,
      'logical-and-replaces-object-alias-safe': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target &&= {};
        target.Store = Store;
      `,
      'logical-and-clears-object-alias-safe': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target &&= undefined;
        target.Store = Store;
      `,
    }),
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/logical-nullish-preserves-object-alias/main/index.ts',
        'src/features/logical-or-preserves-object-alias/main/index.ts',
      ]);
    }
  );
});

test('preserves ordinary and copied property capabilities through terminal deletes', () => {
  withFeatureFixture(
    withStores({
      'getter-delete-safe': `
        import { Store } from './infrastructure/Store';
        export const api = { get Store() { return Store; } };
        delete api.Store;
      `,
      'getter-setter-delete-safe': `
        import { Store } from './infrastructure/Store';
        export const api = {
          get Store() { return Store; },
          set Store(value) { void value; },
        };
        delete api.Store;
      `,
      'getter-spread-delete-safe': `
        import { Store } from './infrastructure/Store';
        const hidden = { get Store() { return Store; } };
        export const api = { ...hidden };
        delete api.Store;
      `,
      'getter-alias-spread-delete-safe': `
        import { Store } from './infrastructure/Store';
        const hidden = { get Store() { return Store; } };
        const alias = { ...hidden };
        export const api = { ...alias };
        delete api.Store;
      `,
      'getter-assign-copy-delete-safe': `
        import { Store } from './infrastructure/Store';
        const hidden = { get Store() { return Store; } };
        export const api = Object.assign({}, hidden);
        delete api.Store;
      `,
      'assigned-spread-delete-safe': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = { ...hidden };
        delete api.Store;
      `,
      'descriptor-copy-delete-safe': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        Object.defineProperty(hidden, 'Store', {
          enumerable: true,
          get() { return Store; },
        });
        export const api = Object.assign({}, hidden);
        delete api.Store;
      `,
      'getter-overwrite-order-safe': `
        import { Store } from './infrastructure/Store';
        export const api = {
          get Store() { return Store; },
          Store: undefined,
        };
      `,
      'descriptor-direct-delete-public': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        Object.defineProperty(api, 'Store', {
          enumerable: true,
          get() { return Store; },
        });
        delete api.Store;
      `,
      'getter-sealed-delete-public': `
        import { Store } from './infrastructure/Store';
        export const api = { get Store() { return Store; } };
        Object.seal(api);
        delete api.Store;
      `,
      'getter-frozen-overwrite-public': `
        import { Store } from './infrastructure/Store';
        export const api = { get Store() { return Store; } };
        Object.freeze(api);
        api.Store = undefined;
      `,
      'getter-accessor-overwrite-public': `
        import { Store } from './infrastructure/Store';
        export const api = { get Store() { return Store; } };
        api.Store = undefined;
      `,
      'getter-spread-frozen-delete-public': `
        import { Store } from './infrastructure/Store';
        const hidden = { get Store() { return Store; } };
        const api = { ...hidden };
        Object.freeze(api);
        export { api };
        delete api.Store;
      `,
      'getter-copy-order-sealed-public': `
        import { Store } from './infrastructure/Store';
        const hidden = { get Store() { return Store; } };
        const api = Object.assign({}, { Store: undefined }, hidden);
        Object.seal(api);
        export { api };
        delete api.Store;
      `,
      'getter-last-overwrite-sealed-public': `
        import { Store } from './infrastructure/Store';
        const api = {
          Store: undefined,
          get Store() { return Store; },
        };
        Object.seal(api);
        export { api };
        delete api.Store;
      `,
    }),
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/descriptor-direct-delete-public/main/index.ts',
        'src/features/getter-accessor-overwrite-public/main/index.ts',
        'src/features/getter-copy-order-sealed-public/main/index.ts',
        'src/features/getter-frozen-overwrite-public/main/index.ts',
        'src/features/getter-last-overwrite-sealed-public/main/index.ts',
        'src/features/getter-sealed-delete-public/main/index.ts',
        'src/features/getter-spread-frozen-delete-public/main/index.ts',
      ]);
    }
  );
});
