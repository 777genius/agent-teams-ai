import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationViolationSources(root) {
  return collectFeatureArchitectureViolations(root).violations
    .filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

test('traces public accessors on directly exported classes', () => {
  withFeatureFixture(
    {
      'src/features/exported-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          get store() {
            return Store;
          }
        }
      `,
      'src/features/exported-class/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/exported-private-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          private get store() {
            return Store;
          }
        }
      `,
      'src/features/exported-private-class/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/exported-class/main/index.ts',
      ]);
    }
  );
});

test('resolves every possible conditional descriptor map', () => {
  withFeatureFixture(
    {
      'src/features/conditional-descriptors/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        const descriptors = enabled
          ? { Store: { get: () => Store, enumerable: true } }
          : {};
        const hidden = {};
        Object.defineProperties(hidden, descriptors);
        export const api = { ...hidden };
      `,
      'src/features/conditional-descriptors/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/nonenumerable-descriptor-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptors = {
          Public: { enumerable: true, value: 'safe' },
          Secret: { enumerable: false, get: () => Store },
        };
        const hidden = {};
        Object.defineProperties(hidden, descriptors);
        export const api = { ...hidden };
      `,
      'src/features/nonenumerable-descriptor-safe/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/conditional-descriptors/main/index.ts',
      ]);
    }
  );
});

test('treats definite CommonJS deletes as final property removal', () => {
  withFeatureFixture(
    {
      'src/features/commonjs-delete-safe/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        delete exports.Store;
      `,
      'src/features/commonjs-delete-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-conditional/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        if (enabled) delete exports.Store;
      `,
      'src/features/commonjs-delete-conditional/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-configurable-safe/main/index.cjs': `
        Object.defineProperty(exports, 'Store', {
          configurable: true,
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        delete exports.Store;
      `,
      'src/features/commonjs-delete-configurable-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-existing-property-safe/main/index.cjs': `
        exports.Store = undefined;
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        delete exports.Store;
      `,
      'src/features/commonjs-delete-existing-property-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-existing-property-locked/main/index.cjs': `
        exports.Store = undefined;
        Object.defineProperty(exports, 'Store', {
          configurable: false,
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        delete exports.Store;
      `,
      'src/features/commonjs-delete-existing-property-locked/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-alias-safe/main/index.cjs': `
        const api = exports;
        api.Store = require('./infrastructure/Store');
        delete api.Store;
      `,
      'src/features/commonjs-delete-alias-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-array-safe/main/index.cjs': `
        module.exports = [require('./infrastructure/Store')];
        delete module.exports[0];
      `,
      'src/features/commonjs-delete-array-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-nonconfigurable/main/index.cjs': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        delete exports.Store;
      `,
      'src/features/commonjs-delete-nonconfigurable/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-nested-safe/main/index.cjs': `
        module.exports = {
          nested: {
            Store: require('./infrastructure/Store'),
          },
        };
        delete module.exports.nested.Store;
      `,
      'src/features/commonjs-delete-nested-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-object-create-safe/main/index.cjs': `
        module.exports = Object.create(null, {
          Store: {
            configurable: true,
            enumerable: true,
            value: require('./infrastructure/Store'),
          },
        });
        delete module.exports.Store;
      `,
      'src/features/commonjs-delete-object-create-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-object-assign-safe/main/index.cjs': `
        module.exports = Object.assign({}, {
          Store: require('./infrastructure/Store'),
        });
        delete module.exports.Store;
      `,
      'src/features/commonjs-delete-object-assign-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-define-nonconfigurable-positive/main/index.cjs': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
      `,
      'src/features/commonjs-define-nonconfigurable-positive/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-nonwritable-assignment-positive/main/index.cjs': `
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          value: require('./infrastructure/Store'),
        });
        exports.Store = undefined;
      `,
      'src/features/commonjs-nonwritable-assignment-positive/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-freeze-assignment-positive/main/index.cjs': `
        module.exports = Object.freeze({
          Store: require('./infrastructure/Store'),
        });
        module.exports.Store = undefined;
      `,
      'src/features/commonjs-freeze-assignment-positive/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-seal-assignment-safe/main/index.cjs': `
        module.exports = Object.seal({
          Store: require('./infrastructure/Store'),
        });
        module.exports.Store = undefined;
      `,
      'src/features/commonjs-seal-assignment-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-nested-freeze-replace-safe/main/index.cjs': `
        const api = {
          nested: {
            Store: require('./infrastructure/Store'),
          },
        };
        module.exports = api;
        Object.freeze(api.nested);
        api.nested = {};
      `,
      'src/features/commonjs-nested-freeze-replace-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-nested-seal-delete-safe/main/index.cjs': `
        const api = {
          nested: {
            Store: require('./infrastructure/Store'),
          },
        };
        module.exports = api;
        Object.seal(api.nested);
        delete api.nested;
      `,
      'src/features/commonjs-nested-seal-delete-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-positive/main/index.cjs':
        "exports.Store = require('./infrastructure/Store');",
      'src/features/commonjs-delete-positive/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-dead-and/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        false && delete exports.Store;
      `,
      'src/features/commonjs-delete-dead-and/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-dead-or/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        true || delete exports.Store;
      `,
      'src/features/commonjs-delete-dead-or/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-dead-ternary/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        true ? undefined : delete exports.Store;
      `,
      'src/features/commonjs-delete-dead-ternary/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-logical-assignment/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        let gate;
        gate &&= delete exports.Store;
      `,
      'src/features/commonjs-delete-logical-assignment/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-optional-call/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        maybe?.(delete exports.Store);
      `,
      'src/features/commonjs-delete-optional-call/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-optional-element/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        maybe?.[delete exports.Store];
      `,
      'src/features/commonjs-delete-optional-element/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-live-expressions/main/index.cjs': `
        exports.AndStore = require('./infrastructure/Store');
        true && delete exports.AndStore;
        exports.OrStore = require('./infrastructure/Store');
        false || delete exports.OrStore;
        exports.TernaryStore = require('./infrastructure/Store');
        false ? undefined : delete exports.TernaryStore;
      `,
      'src/features/commonjs-delete-live-expressions/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-linked-root-safe/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        module.exports = exports;
        delete exports.Store;
      `,
      'src/features/commonjs-delete-linked-root-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-root-object-safe/main/index.cjs': `
        module.exports = {
          Store: require('./infrastructure/Store'),
        };
        delete module.exports.Store;
      `,
      'src/features/commonjs-delete-root-object-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-delete-root-safe/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        delete module.exports;
      `,
      'src/features/commonjs-delete-root-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-define-nonconfigurable-positive/main/index.cjs',
        'src/features/commonjs-delete-conditional/main/index.cjs',
        'src/features/commonjs-delete-dead-and/main/index.cjs',
        'src/features/commonjs-delete-dead-or/main/index.cjs',
        'src/features/commonjs-delete-dead-ternary/main/index.cjs',
        'src/features/commonjs-delete-existing-property-locked/main/index.cjs',
        'src/features/commonjs-delete-logical-assignment/main/index.cjs',
        'src/features/commonjs-delete-nonconfigurable/main/index.cjs',
        'src/features/commonjs-delete-optional-call/main/index.cjs',
        'src/features/commonjs-delete-optional-element/main/index.cjs',
        'src/features/commonjs-delete-positive/main/index.cjs',
        'src/features/commonjs-freeze-assignment-positive/main/index.cjs',
        'src/features/commonjs-nonwritable-assignment-positive/main/index.cjs',
      ]);
    }
  );
});

test('ignores CommonJS root resets outside definite execution', () => {
  withFeatureFixture(
    {
      'src/features/commonjs-dead-and/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        false && (module.exports = {});
      `,
      'src/features/commonjs-dead-and/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-dead-or/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        true || (module.exports = {});
      `,
      'src/features/commonjs-dead-or/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-dead-ternary/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        true ? undefined : (module.exports = {});
      `,
      'src/features/commonjs-dead-ternary/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-optional-call/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        maybe?.(module.exports = {});
      `,
      'src/features/commonjs-optional-call/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-conditional-reset/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        enabled && (module.exports = {});
      `,
      'src/features/commonjs-conditional-reset/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-definite-reset-safe/main/index.cjs': `
        module.exports = require('./infrastructure/Store');
        true && (module.exports = {});
      `,
      'src/features/commonjs-definite-reset-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-conditional-reset/main/index.cjs',
        'src/features/commonjs-dead-and/main/index.cjs',
        'src/features/commonjs-dead-or/main/index.cjs',
        'src/features/commonjs-dead-ternary/main/index.cjs',
        'src/features/commonjs-optional-call/main/index.cjs',
      ]);
    }
  );
});

test('removes logical CommonJS assignments after a terminal delete', () => {
  withFeatureFixture(
    {
      'src/features/commonjs-logical-delete/main/index.cjs': `
        exports.Store ||= require('./infrastructure/Store');
        delete exports.Store;
      `,
      'src/features/commonjs-logical-delete/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-logical-public/main/index.cjs': `
        exports.Store ||= require('./infrastructure/Store');
      `,
      'src/features/commonjs-logical-public/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-logical-existing-or/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        exports.Store ||= undefined;
      `,
      'src/features/commonjs-logical-existing-or/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-logical-existing-and/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        exports.Store &&= exports.Store;
      `,
      'src/features/commonjs-logical-existing-and/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-logical-existing-nullish/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        exports.Store ??= undefined;
      `,
      'src/features/commonjs-logical-existing-nullish/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-freeze-delete/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        Object.freeze(exports);
        delete exports.Store;
      `,
      'src/features/commonjs-freeze-delete/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-seal-delete/main/index.cjs': `
        exports.Store = require('./infrastructure/Store');
        Object.seal(exports);
        delete exports.Store;
      `,
      'src/features/commonjs-seal-delete/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/commonjs-freeze-delete/main/index.cjs',
        'src/features/commonjs-logical-existing-and/main/index.cjs',
        'src/features/commonjs-logical-existing-nullish/main/index.cjs',
        'src/features/commonjs-logical-existing-or/main/index.cjs',
        'src/features/commonjs-logical-public/main/index.cjs',
        'src/features/commonjs-seal-delete/main/index.cjs',
      ]);
    }
  );
});

test('uses the final ESM binding and property state', () => {
  withFeatureFixture(
    {
      'src/features/esm-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = { Store };
        api = {};
        export { api };
      `,
      'src/features/esm-rebind-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-rebind-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = {};
        api = { Store };
        export { api };
      `,
      'src/features/esm-rebind-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-rebind-conditional/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        let api = { Store };
        if (enabled) api = {};
        export { api };
      `,
      'src/features/esm-rebind-conditional/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-default-snapshot/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = Object.freeze({
          get Store() {
            return Store;
          },
        });
        export default api;
        api = {};
      `,
      'src/features/esm-default-snapshot/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-identity-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = Object.freeze({
          get Store() {
            return Store;
          },
        });
        api = {};
        export { api };
      `,
      'src/features/esm-identity-rebind-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-object-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        Object.assign(api, { Store });
        Object.assign(api, { Store: undefined });
      `,
      'src/features/esm-object-assign-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-object-assign-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        Object.assign(api, { Store });
      `,
      'src/features/esm-object-assign-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-object-assign-nested-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { nested: {} };
        Object.assign(api.nested, { Store });
        Object.assign(api.nested, { Store: undefined });
      `,
      'src/features/esm-object-assign-nested-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-object-assign-instance-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        export const api = new Api();
        Object.assign(api, { Store });
        Object.assign(api, { Store: undefined });
      `,
      'src/features/esm-object-assign-instance-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-snapshot-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = { Store };
        export default api;
        api.Store = undefined;
      `,
      'src/features/esm-snapshot-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-snapshot-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = { Store };
        export default api;
        Object.assign(api, { Store: undefined });
      `,
      'src/features/esm-snapshot-assign-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-delete-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        export { api };
        delete api.Store;
      `,
      'src/features/esm-delete-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-snapshot-delete-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        export default api;
        Reflect.deleteProperty(api, 'Store');
      `,
      'src/features/esm-snapshot-delete-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-alias-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = { Store };
        const alias = api;
        export { api };
        alias.Store = undefined;
      `,
      'src/features/esm-alias-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-alias-write-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = {};
        const alias = api;
        api.Store = Store;
        alias.Store = undefined;
        export { api };
      `,
      'src/features/esm-alias-write-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-alias-delete-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        const alias = api;
        export { api };
        delete alias.Store;
      `,
      'src/features/esm-alias-delete-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-freeze-delete-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        export { api };
        Object.freeze(api);
        delete api.Store;
      `,
      'src/features/esm-freeze-delete-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-freeze-overwrite-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        export { api };
        Object.freeze(api);
        api.Store = undefined;
      `,
      'src/features/esm-freeze-overwrite-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-alias-freeze-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        const alias = api;
        export { api };
        Object.freeze(alias);
        api.Store = undefined;
      `,
      'src/features/esm-alias-freeze-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-conditional-alias-freeze-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        const alias = true ? api : api;
        export { api };
        Object.freeze(alias);
        delete api.Store;
      `,
      'src/features/esm-conditional-alias-freeze-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-nonwritable-overwrite-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        Object.defineProperty(api, 'Store', { writable: false });
        export { api };
        api.Store = undefined;
      `,
      'src/features/esm-nonwritable-overwrite-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-nonwritable-delete-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        Object.defineProperty(api, 'Store', { writable: false });
        export { api };
        delete api.Store;
      `,
      'src/features/esm-nonwritable-delete-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-reflect-set-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { Store };
        const alias = api;
        export { api };
        Reflect.set(alias, 'Store', undefined);
      `,
      'src/features/esm-reflect-set-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-configurable-descriptor-delete-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = {};
        Object.defineProperty(api, 'Store', {
          configurable: true,
          value: Store,
        });
        export { api };
        delete api.Store;
      `,
      'src/features/esm-configurable-descriptor-delete-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/esm-nested-freeze-replace-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api: Record<string, unknown> = { nested: { Store } };
        export { api };
        Object.freeze(api.nested);
        api.nested = {};
      `,
      'src/features/esm-nested-freeze-replace-safe/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/esm-alias-freeze-public/main/index.ts',
        'src/features/esm-conditional-alias-freeze-public/main/index.ts',
        'src/features/esm-default-snapshot/main/index.ts',
        'src/features/esm-freeze-delete-public/main/index.ts',
        'src/features/esm-freeze-overwrite-public/main/index.ts',
        'src/features/esm-nonwritable-overwrite-public/main/index.ts',
        'src/features/esm-object-assign-public/main/index.ts',
        'src/features/esm-rebind-conditional/main/index.ts',
        'src/features/esm-rebind-public/main/index.ts',
      ]);
    }
  );
});

test('traces only definitely invoked function mutations', () => {
  withFeatureFixture(
    {
      'src/features/iife-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (() => {
          api.Store = Store;
        })();
      `,
      'src/features/iife-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-expression-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (() => (api.Store = Store))();
      `,
      'src/features/iife-expression-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-terminal-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        (() => {
          api.Store = undefined;
        })();
      `,
      'src/features/iife-terminal-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-argument-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        ((value) => {
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-argument-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-target-argument-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        ((target, value) => {
          target.Store = value;
        })(api, Store);
      `,
      'src/features/iife-target-argument-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-call-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (function () {
          api.Store = Store;
        }).call(undefined);
      `,
      'src/features/iife-call-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-if-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (() => {
          if ((true)) {
            api.Store = Store;
          }
        })();
      `,
      'src/features/iife-if-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-do-while-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (() => {
          do {
            api.Store = Store;
          } while (false);
        })();
      `,
      'src/features/iife-do-while-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-comma-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (undefined, (() => {
          api.Store = Store;
        }))();
      `,
      'src/features/iife-comma-public/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-dead-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        false && (() => {
          api.Store = Store;
        })();
      `,
      'src/features/iife-dead-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/iife-dead-asserted-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        (false as const) && (() => {
          api.Store = Store;
        })();
      `,
      'src/features/iife-dead-asserted-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [1].map(() => {
          api.Store = Store;
        });
      `,
      'src/features/callback-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/callback-argument-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api: Record<string, unknown> = {};
        [Store].forEach((value) => {
          api.Store = value;
        });
      `,
      'src/features/callback-argument-safe/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/iife-argument-public/main/index.ts',
        'src/features/iife-call-public/main/index.ts',
        'src/features/iife-comma-public/main/index.ts',
        'src/features/iife-do-while-public/main/index.ts',
        'src/features/iife-expression-public/main/index.ts',
        'src/features/iife-if-public/main/index.ts',
        'src/features/iife-public/main/index.ts',
        'src/features/iife-target-argument-public/main/index.ts',
      ]);
    }
  );
});
