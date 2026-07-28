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

test('tracks CommonJS function declarations through direct and copied mutations', () => {
  withFeatureFixture(
    {
      'src/features/function-target/main/index.cjs': `
        function api() {}
        module.exports = api;
        api.Direct = require('./infrastructure/Direct');
        Object.assign(api, {
          Assigned: require('./infrastructure/Assigned'),
        });
      `,
      'src/features/function-target/main/infrastructure/Assigned.cjs':
        'module.exports = class Assigned {};',
      'src/features/function-target/main/infrastructure/Direct.cjs':
        'module.exports = class Direct {};',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ exportedName, specifier }) => ({
          exportedName,
          specifier,
        })),
        [
          {
            exportedName: '*',
            specifier: './infrastructure/Assigned',
          },
          {
            exportedName: 'Direct',
            specifier: './infrastructure/Direct',
          },
        ]
      );
    }
  );
});

test('tracks CommonJS class declarations through global mutators', () => {
  withFeatureFixture(
    {
      'src/features/class-target/main/index.cjs': `
        class Api {}
        module.exports = Api;
        Reflect.set(Api, 'Reflected', require('./infrastructure/Reflected'));
        Object.defineProperty(Api, 'Defined', {
          enumerable: true,
          value: require('./infrastructure/Defined'),
        });
      `,
      'src/features/class-target/main/infrastructure/Defined.cjs':
        'module.exports = class Defined {};',
      'src/features/class-target/main/infrastructure/Reflected.cjs':
        'module.exports = class Reflected {};',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ exportedName, specifier }) => ({
          exportedName,
          specifier,
        })),
        [
          {
            exportedName: 'Defined',
            specifier: './infrastructure/Defined',
          },
          {
            exportedName: 'Reflected',
            specifier: './infrastructure/Reflected',
          },
        ]
      );
    }
  );
});

test('resolves hoisted CommonJS function declarations before their source position', () => {
  withFeatureFixture(
    {
      'src/features/hoisted-function/main/index.cjs': `
        module.exports = api;
        function api() {}
        api.Store = require('./infrastructure/Store');
      `,
      'src/features/hoisted-function/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(
        implementationViolations(root).map(({ exportedName, specifier }) => ({
          exportedName,
          specifier,
        })),
        [
          {
            exportedName: 'Store',
            specifier: './infrastructure/Store',
          },
        ]
      );
    }
  );
});

test('does not attach post-rebind mutations to an earlier CommonJS export', () => {
  withFeatureFixture(
    {
      'src/features/rebound-function/main/index.cjs': `
        function api() {}
        module.exports = api;
        api = function replacement() {};
        api.Store = require('./infrastructure/Store');
      `,
      'src/features/rebound-function/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      assert.deepEqual(implementationViolations(root), []);
    }
  );
});
