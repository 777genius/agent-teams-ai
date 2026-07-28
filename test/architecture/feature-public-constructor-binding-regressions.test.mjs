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

test('propagates constructor-local scalar aliases into every public instance sink', () => {
  withFeatureFixture(
    constructorFixtures([
      ['scalar-direct-danger', 'const value = Store; this.Store = value;'],
      ['scalar-assign-danger', 'const value = Store; Object.assign(this, { Store: value });'],
      [
        'scalar-define-property-danger',
        "const value = Store; Object.defineProperty(this, 'Store', { value });",
      ],
      [
        'scalar-define-properties-danger',
        'const value = Store; Object.defineProperties(this, { Store: { value } });',
      ],
      ['scalar-reflect-set-danger', "const value = Store; Reflect.set(this, 'Store', value);"],
      [
        'scalar-getter-danger',
        "const value = Store; Object.defineProperty(this, 'Store', { get() { return value; } });",
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/scalar-assign-danger/main/index.ts',
        'src/features/scalar-define-properties-danger/main/index.ts',
        'src/features/scalar-define-property-danger/main/index.ts',
        'src/features/scalar-direct-danger/main/index.ts',
        'src/features/scalar-getter-danger/main/index.ts',
        'src/features/scalar-reflect-set-danger/main/index.ts',
      ]);
    }
  );
});

test('uses the latest path-sensitive scalar value for every public instance sink', () => {
  withFeatureFixture(
    constructorFixtures([
      ['scalar-direct-rebound-safe', 'let value = Store; value = null; this.Store = value;'],
      [
        'scalar-assign-rebound-safe',
        'let value = Store; value = null; Object.assign(this, { Store: value });',
      ],
      [
        'scalar-define-property-rebound-safe',
        "let value = Store; value = null; Object.defineProperty(this, 'Store', { value });",
      ],
      [
        'scalar-define-properties-rebound-safe',
        'let value = Store; value = null; Object.defineProperties(this, { Store: { value } });',
      ],
      [
        'scalar-reflect-set-rebound-safe',
        "let value = Store; value = null; Reflect.set(this, 'Store', value);",
      ],
      [
        'scalar-getter-rebound-safe',
        "let value = Store; Object.defineProperty(this, 'Store', { get: () => value }); value = null;",
      ],
      [
        'scalar-getter-correlated-rebound-safe',
        "let value = Store; if (Math.random()) { Object.defineProperty(this, 'Store', { get: () => value }); value = null; } else { value = Store; }",
      ],
      [
        'scalar-alias-chain-danger',
        'const value = Store; let alias = null; alias = value; this.Store = alias;',
      ],
      [
        'scalar-conditional-rebind-danger',
        'let value = Store; if (Math.random()) value = null; this.Store = value;',
      ],
      [
        'scalar-all-branches-rebound-safe',
        'let value = Store; if (Math.random()) value = null; else value = null; this.Store = value;',
      ],
      [
        'scalar-logical-assignment-danger',
        'let value = null; value ??= Store; Reflect.set(this, "Store", value);',
      ],
      [
        'scalar-logical-assignment-safe',
        'let value = null; value &&= Store; Reflect.set(this, "Store", value);',
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/scalar-alias-chain-danger/main/index.ts',
        'src/features/scalar-conditional-rebind-danger/main/index.ts',
        'src/features/scalar-logical-assignment-danger/main/index.ts',
      ]);
    }
  );
});

test('keeps scalar aliases private across shadow, callback, getter, and target boundaries', () => {
  withFeatureFixture(
    constructorFixtures([
      [
        'scalar-shadowed-safe',
        'const value = Store; { const value = null; this.Store = value; } void value;',
      ],
      [
        'scalar-deferred-direct-safe',
        'const value = Store; const install = () => { this.Store = value; }; void install;',
      ],
      [
        'scalar-deferred-mutator-safe',
        'const value = Store; const install = () => Object.assign(this, { Store: value }); void install;',
      ],
      [
        'scalar-getter-unreturned-safe',
        "const value = Store; Object.defineProperty(this, 'Store', { get() { void value; return null; } });",
      ],
      [
        'scalar-direct-other-instance-safe',
        'const value = Store; const other = new Api(); other.Store = value;',
      ],
      [
        'scalar-assign-other-target-safe',
        'const value = Store; Object.assign({}, { Store: value });',
      ],
      [
        'scalar-define-property-other-target-safe',
        "const value = Store; Object.defineProperty({}, 'Store', { value });",
      ],
      [
        'scalar-define-properties-other-target-safe',
        'const value = Store; Object.defineProperties({}, { Store: { value } });',
      ],
      [
        'scalar-reflect-set-other-target-safe',
        "const value = Store; Reflect.set({}, 'Store', value);",
      ],
      [
        'scalar-getter-other-target-safe',
        "const value = Store; Object.defineProperty({}, 'Store', { get: () => value });",
      ],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('tracks constructor this aliases through bindings and every public instance sink', () => {
  withFeatureFixture(
    constructorFixtures([
      ['this-alias-direct-danger', 'const target = this; target.Store = Store;'],
      [
        'this-alias-chain-danger',
        'const first = this; const target = first; target.Store = Store;',
      ],
      [
        'this-alias-object-destructure-danger',
        'const { target } = { target: this }; Object.assign(target, { Store });',
      ],
      [
        'this-alias-array-assignment-danger',
        "let target = {}; [target] = [this]; Object.defineProperty(target, 'Store', { value: Store });",
      ],
      [
        'this-alias-define-properties-danger',
        'const target = this; Object.defineProperties(target, { Store: { value: Store } });',
      ],
      ['this-alias-reflect-danger', "const target = this; Reflect.set(target, 'Store', Store);"],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/this-alias-array-assignment-danger/main/index.ts',
        'src/features/this-alias-chain-danger/main/index.ts',
        'src/features/this-alias-define-properties-danger/main/index.ts',
        'src/features/this-alias-direct-danger/main/index.ts',
        'src/features/this-alias-object-destructure-danger/main/index.ts',
        'src/features/this-alias-reflect-danger/main/index.ts',
      ]);
    }
  );
});

test('preserves constructor this for immediate ordinary call and apply invocations', () => {
  withFeatureFixture(
    constructorFixtures([
      ['this-call-danger', '(function () { this.Store = Store; }).call(this);'],
      [
        'this-call-alias-target-danger',
        'const target = this; (function () { Object.assign(this, { Store }); }).call(target);',
      ],
      [
        'this-apply-danger',
        "(function () { Reflect.set(this, 'Store', Store); }).apply(this, []);",
      ],
      [
        'this-apply-inner-alias-danger',
        '(function () { const target = this; Object.defineProperties(target, { Store: { value: Store } }); }).apply(this, []);',
      ],
      [
        'this-apply-outer-value-alias-danger',
        "const value = Store; (function () { Object.defineProperty(this, 'Store', { value }); }).apply(this, []);",
      ],
      ['this-bracket-apply-danger', "(function () { this.Store = Store; })['apply'](this, []);"],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/this-apply-danger/main/index.ts',
        'src/features/this-apply-inner-alias-danger/main/index.ts',
        'src/features/this-apply-outer-value-alias-danger/main/index.ts',
        'src/features/this-bracket-apply-danger/main/index.ts',
        'src/features/this-call-alias-target-danger/main/index.ts',
        'src/features/this-call-danger/main/index.ts',
      ]);
    }
  );
});

test('rejects rebound, copied, shadowed, deferred, and foreign constructor receivers', () => {
  withFeatureFixture(
    constructorFixtures([
      ['this-alias-rebound-safe', 'let target = this; target = {}; target.Store = Store;'],
      ['this-alias-rest-copy-safe', 'const { ...target } = this; target.Store = Store;'],
      ['this-alias-other-object-safe', 'const target = Object.create(this); target.Store = Store;'],
      [
        'this-alias-shadowed-safe',
        'const target = this; { const target = {}; target.Store = Store; } void target;',
      ],
      [
        'this-alias-deferred-arrow-safe',
        'const target = this; const install = () => { target.Store = Store; }; void install;',
      ],
      [
        'this-deferred-function-safe',
        'const install = function () { this.Store = Store; }; void install;',
      ],
      ['this-ordinary-iife-safe', '(function () { this.Store = Store; })();'],
      [
        'this-call-other-safe',
        'const other = {}; (function () { this.Store = Store; }).call(other);',
      ],
      [
        'this-apply-other-safe',
        'const other = {}; (function () { this.Store = Store; }).apply(other, []);',
      ],
      [
        'this-call-rebound-alias-safe',
        'let target = this; target = {}; (function () { this.Store = Store; }).call(target);',
      ],
      ['this-unrelated-team-safe', 'const team = {}; team.Store = Store;'],
    ]),
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});
