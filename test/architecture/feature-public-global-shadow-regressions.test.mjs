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

function infrastructureSource() {
  return 'export class Store {}';
}

test('models Object and Reflect mutators only for unshadowed globals', () => {
  withFeatureFixture(
    {
      'src/features/global-object-assign/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const source = { Store };
        const api = Object.assign(source, {});
        export { api };
      `,
      'src/features/global-object-assign/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/shadowed-object-assign/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const source = { Store };
        const Object = {
          assign() {
            return {};
          },
        };
        const api = Object.assign(source, {});
        export { api };
      `,
      'src/features/shadowed-object-assign/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/global-object-define-property/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        Object.defineProperty(alias, 'Store', {
          enumerable: true,
          value: Store,
        });
        export { api };
      `,
      'src/features/global-object-define-property/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/shadowed-object-define-property/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        const Object = {
          defineProperty() {
            return {};
          },
        };
        Object.defineProperty(alias, 'Store', {
          enumerable: true,
          value: Store,
        });
        export { api };
      `,
      'src/features/shadowed-object-define-property/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/global-object-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        Object.defineProperties(alias, {
          Store: {
            enumerable: true,
            value: Store,
          },
        });
        export { api };
      `,
      'src/features/global-object-define-properties/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/shadowed-object-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        const Object = {
          defineProperties() {
            return {};
          },
        };
        Object.defineProperties(alias, {
          Store: {
            enumerable: true,
            value: Store,
          },
        });
        export { api };
      `,
      'src/features/shadowed-object-define-properties/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/global-reflect-set/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        Reflect.set(alias, 'Store', Store);
        export { api };
      `,
      'src/features/global-reflect-set/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/shadowed-reflect-set/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        const alias = api;
        const Reflect = {
          set() {
            return false;
          },
        };
        Reflect.set(alias, 'Store', Store);
        export { api };
      `,
      'src/features/shadowed-reflect-set/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/global-object-assign/main/index.ts',
        'src/features/global-object-define-properties/main/index.ts',
        'src/features/global-object-define-property/main/index.ts',
        'src/features/global-reflect-set/main/index.ts',
      ]);
    }
  );
});

test('respects lexical value shadows without hiding global values behind type syntax', () => {
  withFeatureFixture(
    {
      'src/features/block-object-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        export { api };
        {
          const Object = {
            assign() {
              return {};
            },
          };
          Object.assign(api, { Store });
        }
      `,
      'src/features/block-object-shadow-safe/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/sibling-object-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        export { api };
        {
          const Object = { assign() {} };
          void Object;
        }
        Object.assign(api, { Store });
      `,
      'src/features/sibling-object-shadow/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/function-object-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        export { api };
        ((Object: { defineProperty(...args: unknown[]): object }) => {
          Object.defineProperty(api, 'Store', {
            enumerable: true,
            value: Store,
          });
        })({
          defineProperty() {
            return {};
          },
        });
      `,
      'src/features/function-object-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/catch-reflect-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const api = {};
        export { api };
        try {
          throw { set() { return false; } };
        } catch (Reflect) {
          Reflect.set(api, 'Store', Store);
        }
      `,
      'src/features/catch-reflect-shadow-safe/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/imported-object-shadow-safe/main/index.ts': `
        import Object from './fake-object';
        import { Store } from './infrastructure/Store';
        const api = {};
        Object.defineProperties(api, {
          Store: {
            enumerable: true,
            value: Store,
          },
        });
        export { api };
      `,
      'src/features/imported-object-shadow-safe/main/fake-object.ts': `
        export default {
          defineProperties() {
            return {};
          },
        };
      `,
      'src/features/imported-object-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/type-object-global/main/index.ts': `
        import { Store } from './infrastructure/Store';
        type Object = { marker: true };
        const api = {};
        Object.defineProperties(api, {
          Store: {
            enumerable: true,
            value: Store,
          },
        });
        export { api };
      `,
      'src/features/type-object-global/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/type-import-reflect-global/main/index.ts': `
        import type { Reflect } from './types';
        import { Store } from './infrastructure/Store';
        const api = {};
        Reflect.set(api, 'Store', Store);
        export { api };
      `,
      'src/features/type-import-reflect-global/main/types.ts': 'export interface Reflect {}',
      'src/features/type-import-reflect-global/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/method-name-global/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Names {
          Object() {}
          Reflect() {}
        }
        void Names;
        const api = {};
        Object.assign(api, { Store });
        export { api };
      `,
      'src/features/method-name-global/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/method-name-global/main/index.ts',
        'src/features/sibling-object-shadow/main/index.ts',
        'src/features/type-import-reflect-global/main/index.ts',
        'src/features/type-object-global/main/index.ts',
      ]);
    }
  );
});
