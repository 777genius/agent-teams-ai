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

test('traces only definite public static-block assignments', () => {
  withFeatureFixture(
    {
      'src/features/static-block-direct/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static Store: unknown;
          static {
            this.Store = Store;
          }
        }
      `,
      'src/features/static-block-direct/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/static-block-dynamic/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const publicName = 'Store';
        export class Api {
          static {
            this[publicName] = Store;
          }
        }
      `,
      'src/features/static-block-dynamic/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/static-block-iife/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            (() => {
              this.Store = Store;
            })();
          }
        }
      `,
      'src/features/static-block-iife/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/static-block-private-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          private static Store: unknown;
          static {
            this.Store = Store;
          }
        }
      `,
      'src/features/static-block-private-safe/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/static-block-false-branch-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            if (false) this.Store = Store;
          }
        }
      `,
      'src/features/static-block-false-branch-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/static-block-callback-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            queueMicrotask(() => {
              this.Store = Store;
            });
          }
        }
      `,
      'src/features/static-block-callback-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/static-block-direct/main/index.ts',
        'src/features/static-block-dynamic/main/index.ts',
        'src/features/static-block-iife/main/index.ts',
      ]);
    }
  );
});
