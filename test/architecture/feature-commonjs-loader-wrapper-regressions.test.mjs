import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  collectModuleEdgesFromSource,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function importSpecifiers(source, sourcePath) {
  return collectModuleEdgesFromSource(source, sourcePath)
    .filter(({ kind }) => kind === 'import')
    .map(({ specifier }) => specifier)
    .sort();
}

test('collects exact module specifiers from CommonJS call, apply, and bind wrappers', () => {
  const source = `
    const load = require;
    const moduleLoad = module.require;
    const applyArguments = ['./apply'];
    const callMethod = 'ca' + 'll';

    require.call(null, './call');
    require.apply(null, applyArguments);
    require.bind(null)('./bind');
    load[callMethod](null, './alias-call');

    const boundLoad = moduleLoad.bind(module, './bound-module');
    boundLoad();
  `;

  assert.deepEqual(importSpecifiers(source, 'src/features/loader-wrappers/main/index.cjs'), [
    './alias-call',
    './apply',
    './bind',
    './bound-module',
    './call',
  ]);
});

test('preserves public export selections for indirectly invoked CommonJS loaders', () => {
  withFeatureFixture(
    {
      'src/features/loader-wrapper-exports/main/index.cjs': `
        exports.Store =
          require.call(null, './infrastructure/Store').Store;
        exports.Repository =
          module.require.apply(module, [
            './infrastructure/Repository',
          ]).Repository;

        const loadService =
          require.bind(null, './infrastructure/Service');
        exports.Service = loadService().Service;
      `,
      'src/features/loader-wrapper-exports/main/infrastructure/Repository.cjs':
        'exports.Repository = class Repository {};',
      'src/features/loader-wrapper-exports/main/infrastructure/Service.cjs':
        'exports.Service = class Service {};',
      'src/features/loader-wrapper-exports/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
    },
    (root) => {
      const violations = collectFeatureArchitectureViolations(root)
        .violations.filter(
          ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
        )
        .map(({ exportedName, specifier }) => ({ exportedName, specifier }))
        .sort((left, right) => left.specifier.localeCompare(right.specifier));

      assert.deepEqual(violations, [
        {
          exportedName: 'Repository',
          specifier: './infrastructure/Repository',
        },
        {
          exportedName: 'Service',
          specifier: './infrastructure/Service',
        },
        {
          exportedName: 'Store',
          specifier: './infrastructure/Store',
        },
      ]);
    }
  );
});

test('rejects cross-feature private imports through CommonJS loader wrappers', () => {
  withFeatureFixture(
    {
      'src/features/loader-wrapper-cross/main/index.cjs': `
        const load = module.require;
        load.call(
          module,
          '@features/loader-wrapper-target/main/private/Store',
        );
      `,
      'src/features/loader-wrapper-target/main/index.ts': 'export const safe = true;',
      'src/features/loader-wrapper-target/main/private/Store.ts': 'export class Store {}',
    },
    (root) => {
      const violations = collectFeatureArchitectureViolations(root).violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint
      );

      assert.deepEqual(
        violations.map(({ source, specifier }) => ({ source, specifier })),
        [
          {
            source: 'src/features/loader-wrapper-cross/main/index.cjs',
            specifier: '@features/loader-wrapper-target/main/private/Store',
          },
        ]
      );
    }
  );
});

test('ignores shadowed loaders and non-static wrapper arguments', () => {
  const source = `
    function shadowedRequire(require) {
      require.call(null, './shadowed-require');
    }

    {
      const module = {
        require: () => undefined,
      };
      module.require.apply(module, ['./shadowed-module']);
    }

    let overwritten = require;
    overwritten = () => undefined;
    overwritten.call(null, './overwritten');

    declare const dynamicArguments: string[];
    require.apply(null, dynamicArguments);

    declare const dynamicMethod: string;
    require[dynamicMethod](null, './dynamic-method');

    const unconfigured = require.bind(null);
    unconfigured();
  `;

  assert.deepEqual(
    importSpecifiers(source, 'src/features/loader-wrapper-negatives/main/index.ts'),
    []
  );
});
