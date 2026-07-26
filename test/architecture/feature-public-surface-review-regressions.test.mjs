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
