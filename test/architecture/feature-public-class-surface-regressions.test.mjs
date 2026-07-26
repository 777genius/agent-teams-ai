import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationViolationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function infrastructureSource(name = 'Store') {
  return `export class ${name} {}`;
}

test('traces anonymous, expression, instance, and static public class members', () => {
  withFeatureFixture(
    {
      'src/features/class-anonymous-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default class {
          get store() {
            return Store;
          }
        }
      `,
      'src/features/class-anonymous-default/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-expression/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const Api = class {
          get store() {
            return Store;
          }
        };
      `,
      'src/features/class-expression/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-static/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static get store() {
            return Store;
          }
        }
      `,
      'src/features/class-static/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-private-protected-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          private get privateStore() {
            return Store;
          }
          protected static get protectedStore() {
            return Store;
          }
        }
      `,
      'src/features/class-private-protected-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-anonymous-default/main/index.ts',
        'src/features/class-expression/main/index.ts',
        'src/features/class-static/main/index.ts',
      ]);
    }
  );
});

test('traces direct class heritage, inherited members, and public type signatures', () => {
  withFeatureFixture(
    {
      'src/features/class-extends-import/main/index.ts': `
        import { Infra } from './infrastructure/Infra';
        export class Api extends Infra {}
      `,
      'src/features/class-extends-import/main/infrastructure/Infra.ts':
        infrastructureSource('Infra'),
      'src/features/class-inherited-member/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Base {
          get store() {
            return Store;
          }
        }
        export class Api extends Base {}
      `,
      'src/features/class-inherited-member/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-method-parameter/main/index.ts': `
        import type { Input } from './infrastructure/Input';
        export class Api {
          run(input: Input): void {}
        }
      `,
      'src/features/class-method-parameter/main/infrastructure/Input.ts':
        'export interface Input {}',
      'src/features/class-method-return/main/index.ts': `
        import type { Output } from './infrastructure/Output';
        export class Api {
          run(): Output {
            throw new Error('not implemented');
          }
        }
      `,
      'src/features/class-method-return/main/infrastructure/Output.ts':
        'export interface Output {}',
      'src/features/class-constructor-signature/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        export class Api {
          constructor(config: Config) {}
        }
      `,
      'src/features/class-constructor-signature/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-private-signatures-safe/main/index.ts': `
        import type { Secret } from './infrastructure/Secret';
        export class Api {
          private hidden(value: Secret): Secret {
            return value;
          }
          protected constructor(secret: Secret) {}
        }
      `,
      'src/features/class-private-signatures-safe/main/infrastructure/Secret.ts':
        'export interface Secret {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-constructor-signature/main/index.ts',
        'src/features/class-extends-import/main/index.ts',
        'src/features/class-inherited-member/main/index.ts',
        'src/features/class-method-parameter/main/index.ts',
        'src/features/class-method-return/main/index.ts',
      ]);
    }
  );
});

test('traces public parameter-property defaults without exposing private constructor state', () => {
  withFeatureFixture(
    {
      'src/features/class-public-parameter-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(public store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/class-public-parameter-default/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-private-parameter-default-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(private store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/class-private-parameter-default-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-plain-parameter-default-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(store = Store) {
            void store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-plain-parameter-default-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-public-parameter-default/main/index.ts',
      ]);
    }
  );
});

test('does not attribute nested callback returns to an enclosing public method', () => {
  withFeatureFixture(
    {
      'src/features/class-direct-method-return/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          run() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-direct-method-return/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-nested-callback-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          run() {
            [1].map(() => {
              return Store;
            });
            return true;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-nested-callback-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-private-method-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          private run() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-private-method-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-direct-method-return/main/index.ts',
      ]);
    }
  );
});

test('traces modeled object-mutator writes to constructed public instances', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-object-assign-shorthand/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, { Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-shorthand/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-set/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Reflect.set(this, 'store', Store);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-set/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-define-property/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', { value: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperties(this, { store: { value: Store } });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-private-object-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          private store: unknown;
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-private-object-assign-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-other-object-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign({}, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-other-object-assign-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-define-properties/main/index.ts',
        'src/features/class-define-property/main/index.ts',
        'src/features/class-object-assign-shorthand/main/index.ts',
        'src/features/class-object-assign/main/index.ts',
        'src/features/class-reflect-set/main/index.ts',
      ]);
    }
  );
});

test('traces constructor getter descriptors and local mutator aliases', () => {
  withFeatureFixture(
    {
      'src/features/class-define-property-getter/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', { get: () => Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-getter/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-object-assign-public-method/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          install() {
            const fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-public-method/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const descriptor = { value: Store };
            const descriptors = { store: descriptor };
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-getter-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const descriptors = { store: { get: () => Store } };
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-getter-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-define-properties-alias/main/index.ts',
        'src/features/class-define-properties-getter-alias/main/index.ts',
        'src/features/class-define-property-getter/main/index.ts',
        'src/features/class-object-assign-alias/main/index.ts',
        'src/features/class-object-assign-public-method/main/index.ts',
      ]);
    }
  );
});

test('ignores constructor mutator aliases that cannot expose the implementation', () => {
  withFeatureFixture(
    {
      'src/features/class-define-property-setter-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', {
              set(value: unknown) {
                void value;
                void Store;
              },
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-setter-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-property-unreturned-getter-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', {
              get: () => {
                void Store;
                return null;
              },
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-unreturned-getter-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias-rebound-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias-rebound-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias-other-target-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            Object.assign({}, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias-other-target-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-alias-rebound-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let descriptors = { store: { value: Store } };
            descriptors = {};
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-alias-rebound-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-nested-this-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            function install(this: object) {
              Object.assign(this, fields);
            }
            void install;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-nested-this-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-deferred-arrow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            const install = () => Object.assign(this, fields);
            void install;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-deferred-arrow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('keeps conditional constructor alias rebinds path-conservative', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign-conditional-rebind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = { store: Store };
            if (condition) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-conditional-rebind/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-conditional-source/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = {};
            if (condition) fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-conditional-source/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-false-rebind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            if (false) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-false-rebind/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-true-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            if (true) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-true-rebind-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-object-assign-conditional-rebind/main/index.ts',
        'src/features/class-object-assign-conditional-source/main/index.ts',
        'src/features/class-object-assign-false-rebind/main/index.ts',
      ]);
    }
  );
});

test('recognizes only unshadowed global constructor mutators', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign-parameter-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(Object: { assign(target: object, source: object): void }) {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api({ assign() {} });
      `,
      'src/features/class-object-assign-parameter-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-block-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            {
              const Object = { assign() {} };
              Object.assign(this, { store: Store });
            }
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-block-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-module-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const Reflect = { set() {} };
        class Api {
          constructor() {
            Reflect.set(this, 'store', Store);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-module-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-catch-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            try {
              throw null;
            } catch (Reflect) {
              Reflect.set(this, 'store', Store);
            }
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-catch-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-sibling-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            {
              const Object = { assign() {} };
              void Object;
            }
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-sibling-shadow/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-type-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        type Object = { marker: true };
        class Api {
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-type-shadow/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-object-assign-sibling-shadow/main/index.ts',
        'src/features/class-object-assign-type-shadow/main/index.ts',
      ]);
    }
  );
});

test('keeps constructed instances instance-only while preserving their public instance type', () => {
  withFeatureFixture(
    {
      'src/features/class-instance-member/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-instance-member/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-instance-static-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          static get store() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-instance-static-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-instance-constructor-safe/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        class Api {
          constructor(config: Config) {}
        }
        export const api = new Api(null as never);
      `,
      'src/features/class-instance-constructor-safe/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-instance-method-type/main/index.ts': `
        import type { Input } from './infrastructure/Input';
        class Api {
          run(input: Input): void {}
        }
        export const api = new Api();
      `,
      'src/features/class-instance-method-type/main/infrastructure/Input.ts':
        'export interface Input {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-instance-member/main/index.ts',
        'src/features/class-instance-method-type/main/index.ts',
      ]);
    }
  );
});

test('uses the final class binding and remains conservative for conditional rebinds', () => {
  withFeatureFixture(
    {
      'src/features/class-rebind-final-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        Api = class {};
        export { Api };
      `,
      'src/features/class-rebind-final-safe/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-rebind-final-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        Api = class {
          get store() {
            return Store;
          }
        };
        export { Api };
      `,
      'src/features/class-rebind-final-public/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-rebind-conditional/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        class Api {
          get store() {
            return Store;
          }
        }
        if (enabled) Api = class {};
        export { Api };
      `,
      'src/features/class-rebind-conditional/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-rebind-conditional/main/index.ts',
        'src/features/class-rebind-final-public/main/index.ts',
      ]);
    }
  );
});

test('preserves public assignments from function constructors', () => {
  withFeatureFixture(
    {
      'src/features/function-constructor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        function Api() {
          this.Store = Store;
        }
        export const api = new Api();
      `,
      'src/features/function-constructor/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/function-constructor/main/index.ts',
      ]);
    }
  );
});

test('traces snapshot defaults and inherited class type surfaces', () => {
  withFeatureFixture(
    {
      'src/features/class-default-snapshot/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        export default Api;
        Api = class {};
      `,
      'src/features/class-default-snapshot/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-default-snapshot-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        export default Api;
        Api = class {
          get store() {
            return Store;
          }
        };
      `,
      'src/features/class-default-snapshot-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-inherited-constructor/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        class Base {
          constructor(config: Config) {}
        }
        export class Api extends Base {}
      `,
      'src/features/class-inherited-constructor/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-index-signature/main/index.ts': `
        import type { Store } from './infrastructure/Store';
        export class Api {
          [key: string]: Store;
        }
      `,
      'src/features/class-index-signature/main/infrastructure/Store.ts':
        'export interface Store {}',
      'src/features/class-generator/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          *items() {
            yield Store;
          }
        }
      `,
      'src/features/class-generator/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-default-snapshot/main/index.ts',
        'src/features/class-generator/main/index.ts',
        'src/features/class-index-signature/main/index.ts',
        'src/features/class-inherited-constructor/main/index.ts',
      ]);
    }
  );
});
