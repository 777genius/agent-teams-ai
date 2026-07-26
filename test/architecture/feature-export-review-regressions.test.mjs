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

function implementationSpecifiers(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
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
      'src/features/dynamic-nested/main/infrastructure/Repository.ts': 'export class Repository {}',
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
      'src/features/control-flow/main/infrastructure/Repository.ts': 'export class Repository {}',
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
      'src/features/defined-initializer-safe/main/infrastructure/Store.ts': infrastructureSource(),
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
      'src/features/conditional-descriptor/main/infrastructure/Store.ts': infrastructureSource(),
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
      assert.deepEqual(implementationSpecifiers(root), ['./infrastructure/PublicStore']);
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
      'src/features/anonymous-default-class/main/infrastructure/Store.ts': infrastructureSource(),
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
      'src/features/direct-object-overwritten/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), ['src/features/direct-object/main/index.ts']);
    }
  );
});

test('traces getters wrapped by public identity helpers', () => {
  withFeatureFixture(
    {
      'src/features/identity-getters/main/index.ts': `
        import { FrozenStore } from './infrastructure/FrozenStore';
        import { AssignedStore } from './infrastructure/AssignedStore';
        import { SealedStore } from './infrastructure/SealedStore';
        import { NonExtensibleStore } from './infrastructure/NonExtensibleStore';
        export const frozen = Object.freeze({
          get Store() { return FrozenStore; },
        });
        export const assigned = Object.assign({}, {
          get Store() { return AssignedStore; },
        });
        export const sealed = Object.seal({
          get Store() { return SealedStore; },
        });
        export const nonExtensible = Object.preventExtensions({
          get Store() { return NonExtensibleStore; },
        });
      `,
      'src/features/identity-getters/main/infrastructure/FrozenStore.ts':
        'export class FrozenStore {}',
      'src/features/identity-getters/main/infrastructure/AssignedStore.ts':
        'export class AssignedStore {}',
      'src/features/identity-getters/main/infrastructure/SealedStore.ts':
        'export class SealedStore {}',
      'src/features/identity-getters/main/infrastructure/NonExtensibleStore.ts':
        'export class NonExtensibleStore {}',
    },
    (root) => {
      assert.deepEqual(implementationSpecifiers(root).sort(), [
        './infrastructure/AssignedStore',
        './infrastructure/FrozenStore',
        './infrastructure/NonExtensibleStore',
        './infrastructure/SealedStore',
      ]);
    }
  );
});

test('traces possible top-level export mutations and logical exported-local assignments', () => {
  withFeatureFixture(
    {
      'src/features/control-flow-possible/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export let api;
        const enabled = globalThis.enabled;
        if (enabled) {
          api = Store;
        }
      `,
      'src/features/control-flow-possible/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/exported-local-logical/main/index.ts': `
        export let Store;
        export let Repository = {};
        export let Service;
        Store ||= require('./infrastructure/Store');
        Repository &&= require('./infrastructure/Repository');
        Service ??= require('./infrastructure/Service');
      `,
      'src/features/exported-local-logical/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/exported-local-logical/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
      'src/features/exported-local-logical/main/infrastructure/Service.cjs':
        'module.exports = class Service {};',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/control-flow-possible/main/index.ts',
        'src/features/exported-local-logical/main/index.ts',
        'src/features/exported-local-logical/main/index.ts',
        'src/features/exported-local-logical/main/index.ts',
      ]);
    }
  );
});

test('traces both defineProperty initializer forms', () => {
  withFeatureFixture(
    {
      'src/features/defined-single-initializer/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Object.defineProperty({}, 'Store', {
          value: Store,
        });
      `,
      'src/features/defined-single-initializer/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/defined-single-initializer/main/index.ts',
      ]);
    }
  );
});

test('traverses executed IIFE mutations but not callbacks or unstarted generators', () => {
  withFeatureFixture(
    {
      'src/features/iife-mutation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        (() => {
          api.Store = Store;
        })();
      `,
      'src/features/iife-mutation/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-generator/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        (function* () {
          api.Store = undefined;
        })();
      `,
      'src/features/iife-generator/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-callback-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        [1].map(() => {
          api.Store = Store;
        });
      `,
      'src/features/iife-callback-safe/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-generator/main/index.ts',
        'src/features/iife-mutation/main/index.ts',
      ]);
    }
  );
});

test('finds CommonJS exports nested in sequence and logical expressions', () => {
  withFeatureFixture(
    {
      'src/features/commonjs-nested/main/index.cjs': `
        const enabled = globalThis.enabled;
        (
          exports.Store = require('./infrastructure/Store'),
          exports.safe = undefined
        );
        enabled && (
          module.exports.Repository = require('./infrastructure/Repository')
        );
      `,
      'src/features/commonjs-nested/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-nested/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
      'src/features/commonjs-nested-safe/main/index.cjs': `
        false && (
          exports.Store = require('./infrastructure/Store')
        );
        (
          exports.Repository = require('./infrastructure/Repository'),
          exports.Repository = undefined
        );
      `,
      'src/features/commonjs-nested-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-nested-safe/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/commonjs-nested/main/index.cjs',
        'src/features/commonjs-nested/main/index.cjs',
      ]);
    }
  );
});

test('distinguishes exported snapshots from later binding reassignments', () => {
  withFeatureFixture(
    {
      'src/features/snapshot-reassigned/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = {};
        export default api;
        api = { Store };
      `,
      'src/features/snapshot-reassigned/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/snapshot-alias-reassigned/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let api = {};
        const snapshot = api;
        export default snapshot;
        api = { Store };
      `,
      'src/features/snapshot-alias-reassigned/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/snapshot-mutated/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        export default api;
        api.Store = Store;
      `,
      'src/features/snapshot-mutated/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/snapshot-mutated/main/index.ts',
      ]);
    }
  );
});

test('stops executed IIFE traversal after selected return and throw branches', () => {
  withFeatureFixture(
    {
      'src/features/iife-return-terminal/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        (() => {
          if (true) return;
          api.Store = undefined;
        })();
      `,
      'src/features/iife-return-terminal/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-throw-terminal/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        (() => {
          if (true) throw new Error('stop');
          api.Store = undefined;
        })();
      `,
      'src/features/iife-throw-terminal/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-caught-throw/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = { Store };
        (() => {
          try {
            if (true) throw new Error('continue');
          } catch {}
          api.Store = undefined;
        })();
      `,
      'src/features/iife-caught-throw/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-return-terminal/main/index.ts',
        'src/features/iife-throw-terminal/main/index.ts',
      ]);
    }
  );
});

test('maps destructured and default IIFE parameters without crossing lexical shadows', () => {
  withFeatureFixture(
    {
      'src/features/iife-destructured-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        (({ value }) => {
          api.Store = value;
        })({ value: Store });
      `,
      'src/features/iife-destructured-param/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-default-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value = Store) => {
          api.Store = value;
        })();
      `,
      'src/features/iife-default-param/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-destructured-default-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        import { Repository } from './infrastructure/Repository';
        export const api = {};
        (({ value = Store, hidden = Repository } = {}) => {
          api.Store = value;
        })();
      `,
      'src/features/iife-destructured-default-param/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/iife-destructured-default-param/main/infrastructure/Repository.ts':
        'export class Repository {}',
      'src/features/iife-shadowed-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          {
            const value = undefined;
            api.Store = value;
          }
        })(Store);
      `,
      'src/features/iife-shadowed-param/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-default-param/main/index.ts',
        'src/features/iife-destructured-default-param/main/index.ts',
        'src/features/iife-destructured-param/main/index.ts',
      ]);
    }
  );
});

test('tracks live IIFE parameters through nested execution and stops after reassignment', () => {
  withFeatureFixture(
    {
      'src/features/iife-nested-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          (() => {
            api.Store = value;
          })();
        })(Store);
      `,
      'src/features/iife-nested-param/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-reassigned-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          value = undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-reassigned-param/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-nested-param/main/index.ts',
      ]);
    }
  );
});

test('models logical IIFE parameter assignments without dropping possible tainted paths', () => {
  withFeatureFixture(
    {
      'src/features/iife-logical-and-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          value &&= undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-and-param/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-logical-or-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          value ||= undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-or-param/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/iife-logical-nullish-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        ((value) => {
          value ??= undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-nullish-param/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/iife-logical-and-unknown-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        const flag = Math.random() > 0.5;
        ((value) => {
          value &&= flag ? undefined : value;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-and-unknown-param/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/iife-logical-or-unknown-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        const flag = Math.random() > 0.5;
        ((value) => {
          if (flag) value = undefined;
          value ||= undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-or-unknown-param/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/iife-logical-nullish-unknown-param/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {};
        const flag = Math.random() > 0.5;
        ((value) => {
          if (flag) value = undefined;
          value ??= undefined;
          api.Store = value;
        })(Store);
      `,
      'src/features/iife-logical-nullish-unknown-param/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationSources(root), [
        'src/features/iife-logical-and-unknown-param/main/index.ts',
        'src/features/iife-logical-nullish-param/main/index.ts',
        'src/features/iife-logical-nullish-unknown-param/main/index.ts',
        'src/features/iife-logical-or-param/main/index.ts',
        'src/features/iife-logical-or-unknown-param/main/index.ts',
      ]);
    }
  );
});
