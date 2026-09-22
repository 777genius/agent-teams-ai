import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function publicApiViolations(files) {
  return withFeatureFixture(files, (root) =>
    collectFeatureArchitectureViolations(root).violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
  );
}

function implementation(fileName) {
  return {
    [`src/features/${fileName}/main/infrastructure/Store.ts`]: 'export class Store {}',
  };
}

test('rejects implementation values returned from inline and aliased Proxy get traps', () => {
  const violations = publicApiViolations({
    'src/features/proxy-alias/main/index.ts': `
      import { Store } from './infrastructure/Store';
      const handler = { get: () => Store };
      export const api = new Proxy({}, handler);
    `,
    ...implementation('proxy-alias'),
    'src/features/proxy-inline/main/index.ts': `
      import { Store } from './infrastructure/Store';
      export const api = new Proxy({}, {
        get() {
          return Store;
        },
      });
    `,
    ...implementation('proxy-inline'),
  });

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/proxy-alias/main/index.ts',
        specifier: './infrastructure/Store',
      },
      {
        source: 'src/features/proxy-inline/main/index.ts',
        specifier: './infrastructure/Store',
      },
    ]
  );
});

test('rejects descriptor values and getter results returned through public Proxy traps', () => {
  const violations = publicApiViolations({
    'src/features/proxy-descriptor-getter/main/index.ts': `
      import { Store } from './infrastructure/Store';
      export const api = new Proxy({}, {
        getOwnPropertyDescriptor() {
          return {
            configurable: true,
            get() {
              return Store;
            },
          };
        },
      });
    `,
    ...implementation('proxy-descriptor-getter'),
    'src/features/proxy-descriptor-value/main/index.ts': `
      import { Store } from './infrastructure/Store';
      export const api = new Proxy({}, {
        getOwnPropertyDescriptor() {
          return { configurable: true, value: Store };
        },
      });
    `,
    ...implementation('proxy-descriptor-value'),
  });

  assert.deepEqual(
    violations.map(({ source }) => source),
    [
      'src/features/proxy-descriptor-getter/main/index.ts',
      'src/features/proxy-descriptor-value/main/index.ts',
    ]
  );
});

test('covers direct ESM and CommonJS public Proxy values', () => {
  const violations = publicApiViolations({
    'src/features/proxy-cjs-alias/main/index.cjs': `
      const load = require('./infrastructure/Store');
      const api = new Proxy({}, { get: () => load.Store });
      module.exports = api;
    `,
    'src/features/proxy-cjs-alias/main/infrastructure/Store.cjs':
      'exports.Store = class Store {};',
    'src/features/proxy-cjs-direct/main/index.cjs': `
      module.exports = new Proxy({}, {
        get() {
          return require('./infrastructure/Store');
        },
      });
    `,
    'src/features/proxy-cjs-direct/main/infrastructure/Store.cjs':
      'module.exports = class Store {};',
    'src/features/proxy-cjs-member/main/index.cjs': `
      exports.api = new Proxy({}, {
        get() {
          return require('./infrastructure/Store');
        },
      });
    `,
    'src/features/proxy-cjs-member/main/infrastructure/Store.cjs':
      'module.exports = class Store {};',
    'src/features/proxy-default/main/index.ts': `
      import { Store } from './infrastructure/Store';
      export default new Proxy({}, { get: () => Store });
    `,
    ...implementation('proxy-default'),
  });

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/proxy-cjs-alias/main/index.cjs',
        specifier: './infrastructure/Store',
      },
      {
        source: 'src/features/proxy-cjs-direct/main/index.cjs',
        specifier: './infrastructure/Store',
      },
      {
        source: 'src/features/proxy-cjs-member/main/index.cjs',
        specifier: './infrastructure/Store',
      },
      {
        source: 'src/features/proxy-default/main/index.ts',
        specifier: './infrastructure/Store',
      },
    ]
  );
});

test('ignores shadowed, hidden, overwritten, and non-returned Proxy references', () => {
  const violations = publicApiViolations({
    'src/features/proxy-safe/main/index.ts': `
      import { Store } from './infrastructure/Store';

      const Proxy = class LocalProxy {
        constructor(_target: object, _handler: object) {}
      };
      export const shadowed = new Proxy({}, { get: () => Store });

      const hidden = new globalThis.Proxy({}, { get: () => Store });
      void hidden;

      export const safe = new globalThis.Proxy({}, {
        get() {
          void Store;
          return 1;
        },
        set() {
          return Store;
        },
        getOwnPropertyDescriptor() {
          void Store;
          return {
            configurable: true,
            set() {
              return Store;
            },
          };
        },
      });

      exports.api = new globalThis.Proxy({}, { get: () => Store });
      exports.api = {};
    `,
    ...implementation('proxy-safe'),
  });

  assert.deepEqual(violations, []);
});

test('uses the handler binding that reaches the public Proxy construction', () => {
  const violations = publicApiViolations({
    'src/features/proxy-rebind-safe/main/index.ts': `
      import { Store } from './infrastructure/Store';
      let handler = { get: () => Store };
      handler = { get: () => 1 };
      export const api = new Proxy({}, handler);
    `,
    ...implementation('proxy-rebind-safe'),
    'src/features/proxy-rebind-unsafe/main/index.ts': `
      import { Store } from './infrastructure/Store';
      let handler = { get: () => 1 };
      handler = { get: () => Store };
      export const api = new Proxy({}, handler);
    `,
    ...implementation('proxy-rebind-unsafe'),
  });

  assert.deepEqual(
    violations.map(({ source }) => source),
    ['src/features/proxy-rebind-unsafe/main/index.ts']
  );
});
