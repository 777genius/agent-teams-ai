import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationViolations(root) {
  return collectFeatureArchitectureViolations(root).violations.filter(
    ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
  );
}

test('traces definite prototype writes on publicly constructed class instances', () => {
  withFeatureFixture(
    {
      'src/features/class-prototype/main/index.ts': `
        import { Aliased } from './infrastructure/Aliased';
        import { Assigned } from './infrastructure/Assigned';
        import { Defined } from './infrastructure/Defined';
        import { Direct } from './infrastructure/Direct';
        import { Reflected } from './infrastructure/Reflected';
        class Api {}
        const Alias = Api;
        Api.prototype.Aliased = Aliased;
        Api.prototype.Direct = Direct;
        Object.assign(Api.prototype, { Assigned });
        Reflect.set(Api.prototype, 'Reflected', Reflected);
        Object.defineProperty(Api.prototype, 'Defined', {
          value: Defined,
        });
        export const api = new Alias();
      `,
      'src/features/class-prototype/main/infrastructure/Aliased.ts':
        'export class Aliased {}',
      'src/features/class-prototype/main/infrastructure/Assigned.ts':
        'export class Assigned {}',
      'src/features/class-prototype/main/infrastructure/Defined.ts':
        'export class Defined {}',
      'src/features/class-prototype/main/infrastructure/Direct.ts': 'export class Direct {}',
      'src/features/class-prototype/main/infrastructure/Reflected.ts':
        'export class Reflected {}',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ importedName, specifier }) => ({
          importedName,
          specifier,
        })),
        [
          {
            importedName: 'Aliased',
            specifier: './infrastructure/Aliased',
          },
          {
            importedName: 'Assigned',
            specifier: './infrastructure/Assigned',
          },
          {
            importedName: 'Defined',
            specifier: './infrastructure/Defined',
          },
          {
            importedName: 'Direct',
            specifier: './infrastructure/Direct',
          },
          {
            importedName: 'Reflected',
            specifier: './infrastructure/Reflected',
          },
        ]
      );
    }
  );
});

test('traces prototype writes on exported function-constructor instances', () => {
  withFeatureFixture(
    {
      'src/features/function-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        function Api() {}
        Api.prototype.Store = Store;
        export const api = new Api();
      `,
      'src/features/function-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ importedName, specifier }) => ({
          importedName,
          specifier,
        })),
        [
          {
            importedName: 'Store',
            specifier: './infrastructure/Store',
          },
        ]
      );
    }
  );
});

test('traces dynamic prototype members and prototype getters conservatively', () => {
  withFeatureFixture(
    {
      'src/features/dynamic-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const member: string;
        class Api {}
        Api.prototype[member] = Store;
        export const api = new Api();
      `,
      'src/features/dynamic-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        Object.defineProperty(Api.prototype, 'Store', {
          get: () => Store,
        });
        export const api = new Api();
      `,
      'src/features/getter-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ importedName, specifier }) => ({
          importedName,
          specifier,
        })),
        [
          {
            importedName: 'Store',
            specifier: './infrastructure/Store',
          },
          {
            importedName: 'Store',
            specifier: './infrastructure/Store',
          },
        ]
      );
    }
  );
});

test('ignores stale, overwritten, and conditional prototype writes', () => {
  withFeatureFixture(
    {
      'src/features/rebound-prototype/main/index.js': `
        const Store = require('./infrastructure/Store');
        class Api {}
        export const api = new Api();
        Api = class Replacement {};
        Api.prototype.Store = Store;
      `,
      'src/features/rebound-prototype/main/infrastructure/Store.js':
        'module.exports = class Store {};',
      'src/features/overwritten-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        Api.prototype.Store = Store;
        Api.prototype.Store = undefined;
        export const api = new Api();
      `,
      'src/features/overwritten-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/conditional-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        class Api {}
        if (enabled) Api.prototype.Store = Store;
        export const api = new Api();
      `,
      'src/features/conditional-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/deferred-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        Api.prototype.refresh = () => Store.bootstrap();
        export const api = new Api();
      `,
      'src/features/deferred-prototype/main/infrastructure/Store.ts': `
        export const Store = { bootstrap: () => undefined };
      `,
    },
    (root) => {
      assert.deepEqual(implementationViolations(root), []);
    }
  );
});
