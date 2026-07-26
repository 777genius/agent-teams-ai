import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationSources(root) {
  return collectFeatureArchitectureViolations(root).violations
    .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
    .map(({ source }) => source);
}

function implementationSpecifiers(root) {
  return collectFeatureArchitectureViolations(root).violations
    .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
    .map(({ specifier }) => specifier);
}

function infrastructureSource() {
  return 'export class Store {}';
}

test('collects every reachable dynamic-import then selection', () => {
  withFeatureFixture(
    {
      'src/features/dynamic-nested/main/index.ts': `
        const chooseStore = true;
        export const api = import('./mixed').then((module) => {
          if (chooseStore) {
            return module.Store;
          }
          try {
            return module.Repository;
          } catch {
            return module.Safe;
          }
        });
      `,
      'src/features/dynamic-nested/main/mixed.ts': `
        export { Store } from './infrastructure/Store';
        export { Repository } from './infrastructure/Repository';
        export const Safe = true;
      `,
      'src/features/dynamic-nested/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/dynamic-nested/main/infrastructure/Repository.ts':
        'export class Repository {}',
      'src/features/dynamic-ambiguous/main/index.ts': `
        const selected = 'Store';
        export const api = import('./mixed').then((module) => module[selected]);
      `,
      'src/features/dynamic-ambiguous/main/mixed.ts': `
        export { Store } from './infrastructure/Store';
        export const Safe = true;
      `,
      'src/features/dynamic-ambiguous/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/dynamic-safe/main/index.ts': `
        export const api = import('./mixed').then((module) => module.Safe);
      `,
      'src/features/dynamic-safe/main/mixed.ts': `
        export { Store } from './infrastructure/Store';
        export const Safe = true;
      `,
      'src/features/dynamic-safe/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/dynamic-ambiguous/main/mixed.ts',
        'src/features/dynamic-nested/main/mixed.ts',
        'src/features/dynamic-nested/main/mixed.ts',
      ]);
    }
  );
});

test('preserves exported mutation owners in definite top-level control flow', () => {
  withFeatureFixture(
    {
      'src/features/control-flow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        import { Repository } from './infrastructure/Repository';
        export const api = {};
        {
          if (true) {
            api.Store = Store;
          }
        }
        try {
          api.Repository = Repository;
        } finally {
          api.ready = true;
        }
      `,
      'src/features/control-flow/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/control-flow/main/infrastructure/Repository.ts':
        'export class Repository {}',
      'src/features/control-flow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        if (false) {
          api.Store = Store;
        }
        function configure() {
          api.Store = Store;
        }
      `,
      'src/features/control-flow-safe/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/control-flow/main/index.ts',
        'src/features/control-flow/main/index.ts',
      ]);
    }
  );
});

test('recognizes logical CommonJS export mutations', () => {
  withFeatureFixture(
    {
      'src/features/commonjs-logical/main/index.cjs': `
        exports.Store ||= require('./infrastructure/Store');
        module.exports.Repository &&= require('./infrastructure/Repository');
        exports.Service ??= require('./infrastructure/Service');
      `,
      'src/features/commonjs-logical/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-logical/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
      'src/features/commonjs-logical/main/infrastructure/Service.cjs':
        'module.exports = class Service {};',
      'src/features/commonjs-logical-safe/main/index.cjs': `
        const hidden = {};
        hidden.Store ||= require('./infrastructure/Store');
      `,
      'src/features/commonjs-logical-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/commonjs-logical/main/index.cjs',
        'src/features/commonjs-logical/main/index.cjs',
        'src/features/commonjs-logical/main/index.cjs',
      ]);
    }
  );
});

test('traces exported IIFE return values without promoting ordinary callbacks', () => {
  withFeatureFixture(
    {
      'src/features/iife-object/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const enabled = true;
        export const api = (() => {
          if (enabled) {
            return { Store };
          }
          return {};
        })();
      `,
      'src/features/iife-object/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-direct/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default (function () {
          return Store;
        })();
      `,
      'src/features/iife-direct/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/callback-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = [1].map(() => Store);
      `,
      'src/features/callback-safe/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-direct/main/index.ts',
        'src/features/iife-object/main/index.ts',
      ]);
    }
  );
});

test('recognizes export-star helper targets through CommonJS aliases', () => {
  withFeatureFixture(
    {
      'src/features/export-star-alias/main/index.cjs': `
        const publicTarget = exports;
        __exportStar(require('./infrastructure/Store'), publicTarget);
      `,
      'src/features/export-star-alias/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/export-star-path-alias/main/index.cjs': `
        exports.api = {};
        const publicTarget = exports.api;
        tslib._exportStar(require('./infrastructure/Store'), publicTarget);
      `,
      'src/features/export-star-path-alias/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/export-star-alias-safe/main/index.cjs': `
        const hidden = {};
        __exportStar(require('./infrastructure/Store'), hidden);
      `,
      'src/features/export-star-alias-safe/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/export-star-alias/main/index.cjs',
        'src/features/export-star-path-alias/main/index.cjs',
      ]);
    }
  );
});

test('traces descriptors returned by exported Object.defineProperty initializers', () => {
  withFeatureFixture(
    {
      'src/features/defined-initializer/main/index.ts': `
        import { Store } from './infrastructure/Store';
        import { Repository } from './infrastructure/Repository';
        export const api = Object.defineProperties({}, {
          Store: {
            get() {
              return Store;
            },
          },
          Repository: { value: Repository },
        });
      `,
      'src/features/defined-initializer/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/defined-initializer/main/infrastructure/Repository.ts':
        'export class Repository {}',
      'src/features/defined-initializer-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Object.defineProperty({}, 'Store', {
          set(value) {
            void Store;
          },
        });
      `,
      'src/features/defined-initializer-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/defined-initializer/main/index.ts',
        'src/features/defined-initializer/main/index.ts',
      ]);
    }
  );
});

test('preserves conditional descriptor member ownership', () => {
  withFeatureFixture(
    {
      'src/features/conditional-descriptor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const enabled = true;
        const descriptors = enabled
          ? { Store: { enumerable: true, get: () => Store } }
          : {};
        const hidden = {};
        Object.defineProperties(hidden, descriptors);
        export const api = { ...hidden };
      `,
      'src/features/conditional-descriptor/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/conditional-descriptor-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const enabled = true;
        const descriptors = enabled
          ? { Store: { enumerable: true, set: () => void Store } }
          : {};
        const hidden = {};
        Object.defineProperties(hidden, descriptors);
        export const api = { ...hidden };
      `,
      'src/features/conditional-descriptor-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/conditional-descriptor/main/index.ts',
      ]);
    }
  );
});

test('does not promote non-enumerable descriptor siblings', () => {
  withFeatureFixture(
    {
      'src/features/descriptor-siblings/main/index.ts': `
        import { PublicStore } from './infrastructure/PublicStore';
        import { SecretStore } from './infrastructure/SecretStore';
        const descriptors = {
          PublicStore: { enumerable: true, get: () => PublicStore },
          SecretStore: { enumerable: false, get: () => SecretStore },
        };
        const hidden = {};
        Object.defineProperties(hidden, descriptors);
        export const api = { ...hidden };
      `,
      'src/features/descriptor-siblings/main/infrastructure/PublicStore.ts':
        'export class PublicStore {}',
      'src/features/descriptor-siblings/main/infrastructure/SecretStore.ts':
        'export class SecretStore {}',
      'src/features/descriptor-inline-siblings/main/index.ts': `
        import { SecretStore } from './infrastructure/SecretStore';
        const hidden = {};
        Object.defineProperties(hidden, {
          PublicStore: { enumerable: true, value: 1 },
          SecretStore: { enumerable: false, get: () => SecretStore },
        });
        export const api = { ...hidden };
      `,
      'src/features/descriptor-inline-siblings/main/infrastructure/SecretStore.ts':
        'export class SecretStore {}',
    },
    (root) => {
      assert.deepEqual(implementationSpecifiers(root), [
        './infrastructure/PublicStore',
      ]);
    }
  );
});

test('traces public members of anonymous default classes only in the exposed mode', () => {
  withFeatureFixture(
    {
      'src/features/anonymous-default-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default class {
          get store() {
            return Store;
          }
        }
      `,
      'src/features/anonymous-default-class/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/anonymous-default-class-static/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default class {
          static get store() {
            return Store;
          }
        }
      `,
      'src/features/anonymous-default-class-static/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/constructed-class-static-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          static get store() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/constructed-class-static-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/anonymous-default-class-static/main/index.ts',
        'src/features/anonymous-default-class/main/index.ts',
      ]);
    }
  );
});

test('drops direct ESM object members after a final overwrite', () => {
  withFeatureFixture(
    {
      'src/features/direct-object/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
      `,
      'src/features/direct-object/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/direct-object-overwritten/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        api.Store = undefined;
      `,
      'src/features/direct-object-overwritten/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/direct-object/main/index.ts',
      ]);
    }
  );
});

test('traces getters wrapped by public identity helpers', () => {
  withFeatureFixture(
    {
      'src/features/identity-getters/main/index.ts': `
        import { FrozenStore } from './infrastructure/FrozenStore';
        import { AssignedStore } from './infrastructure/AssignedStore';
        export const frozen = Object.freeze({
          get Store() { return FrozenStore; },
        });
        export const assigned = Object.assign({}, {
          get Store() { return AssignedStore; },
        });
      `,
      'src/features/identity-getters/main/infrastructure/FrozenStore.ts':
        'export class FrozenStore {}',
      'src/features/identity-getters/main/infrastructure/AssignedStore.ts':
        'export class AssignedStore {}',
    },
    (root) => {
      assert.deepEqual(implementationSpecifiers(root).sort(), [
        './infrastructure/AssignedStore',
        './infrastructure/FrozenStore',
      ]);
    }
  );
});
