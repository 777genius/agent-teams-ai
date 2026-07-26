import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

const store = 'export class Store {}';

function implementationViolationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function constructorFixtures(cases) {
  return Object.fromEntries(
    cases.flatMap(([name, body]) => [
      [
        `src/features/${name}/main/index.ts`,
        `import { Store } from './infrastructure/Store';
         class Api { constructor() { ${body} } }
         export const api = new Api();`,
      ],
      [`src/features/${name}/main/infrastructure/Store.ts`, store],
    ])
  );
}

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

test('models every logical local-binding assignment outcome', () => {
  withFeatureFixture(
    constructorFixtures([
      [
        'logical-nullish-danger',
        'let fields = null; fields ??= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-or-danger',
        'let fields = null; fields ||= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-and-danger',
        'let fields = {}; fields &&= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-nullish-retains-danger',
        'let fields = { store: Store }; fields ??= {}; Object.assign(this, fields);',
      ],
      [
        'logical-or-retains-danger',
        'let fields = { store: Store }; fields ||= {}; Object.assign(this, fields);',
      ],
      [
        'logical-nullish-unknown-danger',
        'let fields = Math.random() ? null : {}; fields ??= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-nullish-skipped-safe',
        'let fields = {}; fields ??= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-or-skipped-safe',
        'let fields = {}; fields ||= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-and-skipped-safe',
        'let fields = null; fields &&= { store: Store }; Object.assign(this, fields);',
      ],
      [
        'logical-and-overwrite-safe',
        'let fields = { store: Store }; fields &&= {}; Object.assign(this, fields);',
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/logical-and-danger/main/index.ts',
        'src/features/logical-nullish-danger/main/index.ts',
        'src/features/logical-nullish-retains-danger/main/index.ts',
        'src/features/logical-nullish-unknown-danger/main/index.ts',
        'src/features/logical-or-danger/main/index.ts',
        'src/features/logical-or-retains-danger/main/index.ts',
      ]);
    }
  );
});

test('models getter and spread Object.assign sources in overwrite order', () => {
  withFeatureFixture(
    constructorFixtures([
      ['assign-getter-danger', 'Object.assign(this, { get store() { return Store; } });'],
      ['assign-spread-last-danger', 'Object.assign(this, { store: null, ...{ store: Store } });'],
      [
        'assign-spread-alias-danger',
        'const fields = { store: Store }; Object.assign(this, { store: null, ...fields });',
      ],
      [
        'assign-spread-getter-alias-danger',
        'const fields = { get store() { return Store; } }; Object.assign(this, { ...fields });',
      ],
      ['assign-later-source-danger', 'Object.assign(this, { store: null }, { store: Store });'],
      [
        'assign-spread-overwrite-safe',
        'Object.assign(this, { store: Store, ...{ store: null } });',
      ],
      [
        'assign-direct-overwrite-safe',
        'Object.assign(this, { ...{ store: Store }, store: null });',
      ],
      [
        'assign-getter-overwrite-safe',
        'Object.assign(this, { get store() { return Store; }, store: null });',
      ],
      [
        'assign-later-source-overwrite-safe',
        'Object.assign(this, { store: Store }, { store: null });',
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/assign-getter-danger/main/index.ts',
        'src/features/assign-later-source-danger/main/index.ts',
        'src/features/assign-spread-alias-danger/main/index.ts',
        'src/features/assign-spread-getter-alias-danger/main/index.ts',
        'src/features/assign-spread-last-danger/main/index.ts',
      ]);
    }
  );
});

test('traces destructured values introduced through object and array spreads', () => {
  withFeatureFixture(
    constructorFixtures([
      [
        'object-rest-spread-danger',
        'const source = { ...{ store: Store } }; const { ...fields } = source; Object.assign(this, fields);',
      ],
      [
        'object-rest-alias-spread-danger',
        'const extra = { store: Store }; const source = { ...extra }; const { ...fields } = source; Object.assign(this, fields);',
      ],
      [
        'array-element-spread-danger',
        'const source = [...[{ store: Store }]]; const [fields] = source; Object.assign(this, fields);',
      ],
      [
        'array-offset-spread-danger',
        'const source = [0, ...[{ store: Store }]]; const [, fields] = source; Object.assign(this, fields);',
      ],
      [
        'array-rest-spread-danger',
        'const source = [0, ...[Store]]; const [, ...fields] = source; Object.assign(this, fields);',
      ],
      [
        'array-alias-spread-danger',
        'const extra = [{ store: Store }]; const source = [...extra]; const [fields] = source; Object.assign(this, fields);',
      ],
      [
        'array-rest-alias-spread-danger',
        'const extra = [Store]; const source = [0, ...extra]; const [, ...fields] = source; Object.assign(this, fields);',
      ],
      [
        'object-rest-spread-excluded-safe',
        'const source = { ...{ hidden: Store } }; const { hidden, ...fields } = source; void hidden; Object.assign(this, fields);',
      ],
      [
        'array-spread-excluded-safe',
        'const source = [...[Store]]; const [hidden, ...fields] = source; void hidden; Object.assign(this, fields);',
      ],
      [
        'object-rest-alias-spread-excluded-safe',
        'const extra = { hidden: Store }; const source = { ...extra }; const { hidden, ...fields } = source; void hidden; Object.assign(this, fields);',
      ],
      [
        'array-alias-spread-excluded-safe',
        'const extra = [Store]; const source = [...extra]; const [hidden, ...fields] = source; void hidden; Object.assign(this, fields);',
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/array-alias-spread-danger/main/index.ts',
        'src/features/array-element-spread-danger/main/index.ts',
        'src/features/array-offset-spread-danger/main/index.ts',
        'src/features/array-rest-alias-spread-danger/main/index.ts',
        'src/features/array-rest-spread-danger/main/index.ts',
        'src/features/object-rest-alias-spread-danger/main/index.ts',
        'src/features/object-rest-spread-danger/main/index.ts',
      ]);
    }
  );
});

test('applies destructuring defaults only to missing or undefined selections', () => {
  withFeatureFixture(
    constructorFixtures([
      [
        'object-default-missing-danger',
        'const source = {}; const { fields = { store: Store } } = source; Object.assign(this, fields);',
      ],
      [
        'object-default-undefined-danger',
        'const source = { fields: undefined }; const { fields = { store: Store } } = source; Object.assign(this, fields);',
      ],
      [
        'object-default-null-safe',
        'const source = { fields: null }; const { fields = { store: Store } } = source; Object.assign(this, fields);',
      ],
      [
        'array-default-null-safe',
        'const source = [null]; const [fields = { store: Store }] = source; Object.assign(this, fields);',
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/object-default-missing-danger/main/index.ts',
        'src/features/object-default-undefined-danger/main/index.ts',
      ]);
    }
  );
});

test('honors statically resolved computed object-rest exclusions', () => {
  withFeatureFixture(
    constructorFixtures([
      [
        'computed-rest-exclusion-safe',
        "const key = 'hidden'; const source = { hidden: Store }; const { [key]: ignored, ...fields } = source; void ignored; Object.assign(this, fields);",
      ],
      [
        'computed-rest-other-danger',
        "const key = 'other'; const source = { hidden: Store }; const { [key]: ignored, ...fields } = source; void ignored; Object.assign(this, fields);",
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/computed-rest-other-danger/main/index.ts',
      ]);
    }
  );
});
