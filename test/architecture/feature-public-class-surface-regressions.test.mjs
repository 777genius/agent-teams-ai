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
      'src/features/class-anonymous-default/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-expression/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const Api = class {
          get store() {
            return Store;
          }
        };
      `,
      'src/features/class-expression/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static get store() {
            return Store;
          }
        }
      `,
      'src/features/class-static/main/infrastructure/Store.ts':
        infrastructureSource(),
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
      'src/features/class-inherited-member/main/infrastructure/Store.ts':
        infrastructureSource(),
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
      'src/features/class-instance-member/main/infrastructure/Store.ts':
        infrastructureSource(),
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
      'src/features/class-rebind-final-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
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
      'src/features/class-rebind-final-public/main/infrastructure/Store.ts':
        infrastructureSource(),
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
      'src/features/class-rebind-conditional/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-rebind-conditional/main/index.ts',
        'src/features/class-rebind-final-public/main/index.ts',
      ]);
    }
  );
});
