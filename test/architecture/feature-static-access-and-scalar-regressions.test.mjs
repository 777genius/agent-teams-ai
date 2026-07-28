import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function violationsFor(files, rule) {
  return withFeatureFixture(files, (root) =>
    collectFeatureArchitectureViolations(root).violations.filter(
      (violation) => violation.rule === rule
    )
  );
}

test('recognizes statically bracketed module.require loaders', () => {
  const violations = violationsFor(
    {
      'src/features/bracket-require/main/index.cjs': `
        exports.Store =
          module['require']('./infrastructure/Store').Store;
        exports.Repository =
          module['re' + 'quire']('./infrastructure/Repository').Repository;
      `,
      'src/features/bracket-require/main/infrastructure/Repository.cjs':
        'exports.Repository = class Repository {};',
      'src/features/bracket-require/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/shadowed-bracket-require/main/index.cjs': `
        const module = {
          require: () => ({ Store: class Store {} }),
        };
        exports.Store = module['require']('./infrastructure/Store').Store;
      `,
      'src/features/shadowed-bracket-require/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
    },
    FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
  );

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/bracket-require/main/index.cjs',
        specifier: './infrastructure/Repository',
      },
      {
        source: 'src/features/bracket-require/main/index.cjs',
        specifier: './infrastructure/Store',
      },
    ]
  );
});

test('resolves statically computed globalThis runtime properties', () => {
  const violations = violationsFor(
    {
      'src/features/computed-global/core/domain/direct.ts': `
        export const pid = globalThis[('process')].pid;
      `,
      'src/features/computed-global/core/domain/concatenated.ts': `
        export const environment = globalThis['pro' + 'cess'].env;
      `,
      'src/features/computed-global/core/domain/aliased.ts': `
        const root = globalThis;
        const runtimeName = 'process';
        export const platform = root[runtimeName].platform;
      `,
      'src/features/shadowed-computed-global/core/domain/safe.ts': `
        const globalThis = { process: { pid: 1 } };
        export const pid = globalThis['pro' + 'cess'].pid;
      `,
    },
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation
  );

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/computed-global/core/domain/aliased.ts',
        specifier: 'node:process',
      },
      {
        source: 'src/features/computed-global/core/domain/concatenated.ts',
        specifier: 'node:process',
      },
      {
        source: 'src/features/computed-global/core/domain/direct.ts',
        specifier: 'node:process',
      },
    ]
  );
});

test('excludes scalar derivations without hiding identity-bearing exports', () => {
  const violations = violationsFor(
    {
      'src/features/scalar-derivations/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const enabled = Boolean(Store);
        export const absent = Store === undefined;
        export const mode = Store ? 1 : 2;
        export const negated = !Store;
        export const kind = typeof Store;
        export const constant = (Store, 'safe');
        export const api = {
          get enabled() {
            return Boolean(Store);
          },
        };
        export default Boolean(Store);
      `,
      'src/features/scalar-derivations/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/commonjs-scalar-derivations/main/index.cjs': `
        const { Store } = require('./infrastructure/Store');
        exports.enabled = Boolean(Store);
        exports.absent = Store === undefined;
        exports.mode = Store ? 1 : 2;
        Object.defineProperty(exports, 'available', {
          get: () => Boolean(Store),
        });
      `,
      'src/features/commonjs-scalar-derivations/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/conditional-identity/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        export const api = enabled ? Store : null;
      `,
      'src/features/conditional-identity/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/shadowed-boolean/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const Boolean = <T>(value: T): T => value;
        export const api = Boolean(Store);
      `,
      'src/features/shadowed-boolean/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/commonjs-identity/main/index.cjs': `
        const { Store } = require('./infrastructure/Store');
        exports.api = Math.random() > 0.5 ? Store : null;
      `,
      'src/features/commonjs-identity/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
    },
    FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
  );

  assert.deepEqual(
    violations.map(({ source }) => source),
    [
      'src/features/commonjs-identity/main/index.cjs',
      'src/features/conditional-identity/main/index.ts',
      'src/features/shadowed-boolean/main/index.ts',
    ]
  );
});
