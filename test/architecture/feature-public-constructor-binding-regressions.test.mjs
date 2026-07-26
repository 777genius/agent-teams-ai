import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

const store = 'export class Store {}';

test('tracks array destructuring and excludes removed rest members', () => {
  withFeatureFixture(
    {
      'src/features/array-binding/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = [{ store: Store }]; const [fields] = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-binding/main/infrastructure/Store.ts': store,
      'src/features/array-assignment/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { let fields = {}; const source = [{ store: Store }]; [fields] = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-assignment/main/infrastructure/Store.ts': store,
      'src/features/array-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = []; const [fields = { store: Store }] = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-default/main/infrastructure/Store.ts': store,
      'src/features/array-default-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = [{}]; const [fields = { store: Store }] = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-default-safe/main/infrastructure/Store.ts': store,
      'src/features/array-rest/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = [0, Store]; const [, ...fields] = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-rest/main/infrastructure/Store.ts': store,
      'src/features/array-rest-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = [Store]; const [hidden, ...fields] = source; void hidden; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/array-rest-safe/main/infrastructure/Store.ts': store,
      'src/features/object-rest-exclusion-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = { hidden: Store }; const { hidden, ...fields } = source; void hidden; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/object-rest-exclusion-safe/main/infrastructure/Store.ts': store,
    },
    (root) => {
      assert.deepEqual(
        collectFeatureArchitectureViolations(root)
          .violations.filter(
            ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
          )
          .map(({ source }) => source)
          .sort(),
        [
          'src/features/array-assignment/main/index.ts',
          'src/features/array-binding/main/index.ts',
          'src/features/array-default/main/index.ts',
          'src/features/array-rest/main/index.ts',
        ]
      );
    }
  );
});
