import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  collectModuleEdgesFromSource,
  toBaselineEntry,
  violationKey,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import {
  evaluateFeatureArchitectureRatchet,
  validateFeatureArchitectureBaseline,
  verifyFeatureArchitecture,
} from '../../scripts/ci/verify-feature-architecture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withFixture(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'feature-architecture-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, source);
    }
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function baselineEntry(rule, source, specifier, publicEntrypoint) {
  const entry = { rule, source, specifier };
  if (publicEntrypoint) entry.publicEntrypoint = publicEntrypoint;
  return entry;
}

function architectureViolation(rule, source, specifier) {
  return {
    line: 1,
    message: 'fixture violation',
    rule,
    source,
    specifier,
  };
}

test('collects static, dynamic, CommonJS, and re-export dependency edges', () => {
  const edges = collectModuleEdgesFromSource(
    `
      import type { Contract } from './contract';
      export { facade } from './facade';
      const lazy = import('./lazy');
      const attributed = import('./attributed', { with: { type: 'json' } });
      const legacy = require('./legacy');
      const invalidLegacy = require('./ignored', 'utf8');
      type Queried = import('./queried').Thing;
    `,
    'src/features/example/main/index.ts'
  );

  assert.deepEqual(
    edges.map(({ kind, specifier }) => ({ kind, specifier })),
    [
      { kind: 'import', specifier: './contract' },
      { kind: 'export', specifier: './facade' },
      { kind: 'import', specifier: './lazy' },
      { kind: 'import', specifier: './attributed' },
      { kind: 'import', specifier: './legacy' },
      { kind: 'import', specifier: './queried' },
    ]
  );
});

test('requires public entrypoints for alias and relative cross-feature dependencies', () => {
  withFixture(
    {
      'src/features/alpha/core/application/useCase.ts': `
        import type { Contract } from '@features/beta/contracts';
        import { ownRule } from '@features/alpha/core/domain/ownRule';
      `,
      'src/features/alpha/core/domain/ownRule.ts': 'export const ownRule = true;',
      'src/features/alpha/main/composition/createAlpha.ts': `
        import { privateRule } from '@features/beta/core/domain/privateRule';
      `,
      'src/features/beta/contracts/index.ts': 'export interface Contract {}',
      'src/features/beta/core/domain/privateRule.ts': 'export const privateRule = true;',
      'src/main/relativeFeatureImport.ts': `
        import { privateRule } from '../features/beta/core/domain/privateRule';
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const crossFeatureViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint
      );

      assert.deepEqual(
        crossFeatureViolations.map(({ source, specifier }) => ({ source, specifier })),
        [
          {
            source: 'src/features/alpha/main/composition/createAlpha.ts',
            specifier: '@features/beta/core/domain/privateRule',
          },
          {
            source: 'src/main/relativeFeatureImport.ts',
            specifier: '../features/beta/core/domain/privateRule',
          },
        ]
      );
    }
  );
});

test('keeps core domain free from application and runtime dependencies', () => {
  withFixture(
    {
      'src/features/example/core/domain/policy.ts': `
        import path from 'node:path';
        import electron from 'electron';
        import fastify from 'fastify';
        import type { Input } from '../application/model';
        import { store } from '../../main/infrastructure/store';
        import type { Id } from '@shared/contracts/hosted/identifiers';
        import { registerRuntime } from '@features/runtime-feature';
        import { z } from 'zod';
        export type Store = import('../../main/infrastructure/typeStore').Store;
      `,
      'src/features/runtime-feature/index.ts': `export { registerRuntime } from './main';`,
      'src/features/runtime-feature/main/index.ts':
        'export const registerRuntime = () => undefined;',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const domainViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreDomainIsolation
      );

      assert.deepEqual(domainViolations.map(({ specifier }) => specifier).sort(), [
        '../../main/infrastructure/store',
        '../../main/infrastructure/typeStore',
        '../application/model',
        '@features/runtime-feature',
        'electron',
        'fastify',
        'node:path',
      ]);
    }
  );
});

test('allows application domain, contracts, and own ports while rejecting outer dependencies', () => {
  withFixture(
    {
      'src/features/example/core/application/useCase.ts': `
        import { rule } from '../domain/rule';
        import type { Contract } from '../../contracts';
        import type { Clock } from './ports/Clock';
        import type { SharedId } from '@shared/contracts/hosted/identifiers';
        import type { OtherContract } from '@features/other/contracts';
        import type { LegacyType } from '@shared/types';
        import fs from 'node:fs';
        import { otherFacade } from '@features/other';
        import { store } from '../../main/infrastructure/store';
      `,
      'src/features/example/contracts/index.ts': 'export interface Contract {}',
      'src/features/example/core/application/ports/Clock.ts': 'export interface Clock {}',
      'src/features/example/core/domain/rule.ts': 'export const rule = true;',
      'src/features/other/contracts/index.ts': 'export interface OtherContract {}',
      'src/features/other/index.ts': 'export const otherFacade = true;',
      'src/shared/contracts/hosted/identifiers.ts': 'export type SharedId = string;',
      'src/shared/types.ts': 'export interface LegacyType {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const applicationViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies
      );

      assert.deepEqual(applicationViolations.map(({ specifier }) => specifier).sort(), [
        '../../main/infrastructure/store',
        '@features/other',
        '@shared/types',
        'node:fs',
      ]);
    }
  );
});

test('fails the end-to-end gate for a new violation in a new feature', () => {
  withFixture(
    {
      'scripts/ci/feature-architecture-baseline.json': JSON.stringify({
        version: 1,
        violations: [],
      }),
      'src/features/new-feature/core/domain/rule.ts': `import path from 'node:path';`,
    },
    (root) => {
      assert.throws(
        () => verifyFeatureArchitecture({ baselineRef: null, root }),
        /new-architecture-violation.*new-feature.*node:path/s
      );
    }
  );
});

test('detects implementation exports through transitive internal barrels', () => {
  withFixture(
    {
      'src/features/example/main/index.ts': `
        import { AliasInfra } from './infrastructure/AliasInfra';
        import { BodyOnly } from './infrastructure/BodyOnly';
        import { CastInfra } from './infrastructure/CastInfra';
        import type { ImportedInfra } from './infrastructure/ImportedInfra';
        import type { PropertyName } from './infrastructure/PropertyName';
        import type { ShadowOnly } from './infrastructure/ShadowOnly';
        import { HiddenMutation } from './infrastructure/HiddenMutation';
        import { MethodInfra } from './infrastructure/MethodInfra';
        import { MutatedInfra } from './infrastructure/MutatedInfra';
        import * as mixedNamespace from './mixedBarrel';
        import { Store } from './public';
        import { safe } from './safePublic';
        export { safe, Store };
        type ChainedInfra = ImportedInfra;
        export interface PublicShape { value: ChainedInfra }
        export const ExportedAlias = AliasInfra;
        export const RequiredInfra = require('./infrastructure/RequiredInfra').RequiredInfra;
        export const LazyInfra = import('./infrastructure/LazyInfra', { with: { type: 'json' } });
        export const ChainedInfra = import('./thenBarrel').then((module) => module.Infra);
        export const api = {};
        api.Store = MutatedInfra;
        (api as { CastInfra?: unknown }).CastInfra = CastInfra;
        api.register(MethodInfra);
        Object.assign(api, {
          AssignedInfra: require('./infrastructure/AssignedInfra').AssignedInfra,
        });
        const internal = {};
        internal.HiddenMutation = HiddenMutation;
        export type DirectInfra = import('./infrastructure/DirectInfra').DirectInfra;
        export { TransitiveInfra } from './publicTypes';
        export { SelectiveSafe } from './mixedBarrel';
        const {
          SelectiveSafe: DestructuredSafe,
          SelectedInfra: DestructuredInfra,
        } = mixedNamespace;
        export { DestructuredSafe, DestructuredInfra };
        const { SelectiveSafe: RequiredSafe } = require('./mixedBarrel');
        export const { SelectiveSafe: LazySafe } = await import('./mixedBarrel');
        export { RequiredSafe };
        export { ExternalInfra } from '@main/services/infrastructure/ExternalInfra';
        export { SharedInfra } from '@shared/infraBarrel';
        import { MemberInfra } from './memberBarrel';
        export const memberValue = MemberInfra.value;
        type HiddenInfra = import('./infrastructure/HiddenInfra').HiddenInfra;
        export interface SafeProperty { PropertyName: string }
        export interface SafeShadow<ShadowOnly> { value: ShadowOnly }
        export function safeFactory() {
          type LocalInfra = import('./infrastructure/LocalInfra').LocalInfra;
          return BodyOnly;
        }
      `,
      'src/features/example/main/infrastructure/AliasInfra.ts': 'export const AliasInfra = {};',
      'src/features/example/main/infrastructure/BodyOnly.ts': 'export const BodyOnly = {};',
      'src/features/example/main/infrastructure/AssignedInfra.ts': 'export class AssignedInfra {}',
      'src/features/example/main/infrastructure/CastInfra.ts': 'export class CastInfra {}',
      'src/features/example/main/infrastructure/DirectInfra.ts': 'export interface DirectInfra {}',
      'src/features/example/main/infrastructure/HiddenInfra.ts': 'export interface HiddenInfra {}',
      'src/features/example/main/infrastructure/HiddenMutation.ts':
        'export class HiddenMutation {}',
      'src/features/example/main/infrastructure/ImportedInfra.ts':
        'export interface ImportedInfra {}',
      'src/features/example/main/infrastructure/LocalInfra.ts': 'export interface LocalInfra {}',
      'src/features/example/main/infrastructure/LazyInfra.ts': 'export class LazyInfra {}',
      'src/features/example/main/infrastructure/MethodInfra.ts': 'export class MethodInfra {}',
      'src/features/example/main/infrastructure/MutatedInfra.ts': 'export class MutatedInfra {}',
      'src/features/example/main/infrastructure/PropertyName.ts':
        'export interface PropertyName {}',
      'src/features/example/main/infrastructure/RequiredInfra.ts': 'export class RequiredInfra {}',
      'src/features/example/main/infrastructure/SelectedInfra.ts': 'export class SelectedInfra {}',
      'src/features/example/main/infrastructure/ShadowOnly.ts': 'export interface ShadowOnly {}',
      'src/features/example/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/example/main/infrastructure/TransitiveInfra.ts':
        'export interface TransitiveInfra {}',
      'src/features/example/main/public.ts': `
        import { Store } from './infrastructure/Store';
        export { Store };
      `,
      'src/features/example/main/publicTypes.ts': `
        type InternalInfra = import('./infrastructure/TransitiveInfra').TransitiveInfra;
        export { InternalInfra as TransitiveInfra };
      `,
      'src/features/example/main/mixedBarrel.ts': `
        export * from './selectiveSafe';
        export * from './infrastructure/SelectedInfra';
      `,
      'src/features/example/main/memberBarrel.ts': `
        export { MemberInfra } from './infrastructure/MemberInfra';
      `,
      'src/features/example/main/infrastructure/MemberInfra.ts': `
        export const MemberInfra = { value: true };
      `,
      'src/features/example/main/selectiveSafe.ts': 'export const SelectiveSafe = true;',
      'src/features/example/main/safePublic.ts': `
        export const safe = true;
        export * from './infrastructure/Store';
      `,
      'src/features/example/main/thenBarrel.ts': `
        export { Infra } from './infrastructure/ThenInfra';
        export { SelectiveSafe } from './selectiveSafe';
      `,
      'src/features/example/main/infrastructure/ThenInfra.ts': 'export class Infra {}',
      'src/features/example/renderer/adapters/Adapter.ts': `
        export class Adapter {}
      `,
      'src/features/example/renderer/index.tsx': `
        import * as adapters from './adapters/Adapter';
        export default adapters.Adapter;
      `,
      'src/main/services/infrastructure/ExternalInfra.ts': 'export class ExternalInfra {}',
      'src/main/services/infrastructure/SharedInfra.ts': 'export class SharedInfra {}',
      'src/shared/infraBarrel.ts': `
        export { SharedInfra } from '@main/services/infrastructure/SharedInfra';
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const publicApiViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
      );

      assert.deepEqual(publicApiViolations.map(toBaselineEntry), [
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/AliasInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/AssignedInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/CastInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/DirectInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/ImportedInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/LazyInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/MethodInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/MutatedInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: './infrastructure/RequiredInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/index.ts',
          specifier: '@main/services/infrastructure/ExternalInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/memberBarrel.ts',
          specifier: './infrastructure/MemberInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/mixedBarrel.ts',
          specifier: './infrastructure/SelectedInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/public.ts',
          specifier: './infrastructure/Store',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/publicTypes.ts',
          specifier: './infrastructure/TransitiveInfra',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/main/thenBarrel.ts',
          specifier: './infrastructure/ThenInfra',
        },
        {
          publicEntrypoint: 'src/features/example/renderer/index.tsx',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/features/example/renderer/index.tsx',
          specifier: './adapters/Adapter',
        },
        {
          publicEntrypoint: 'src/features/example/main/index.ts',
          rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
          source: 'src/shared/infraBarrel.ts',
          specifier: '@main/services/infrastructure/SharedInfra',
        },
      ]);
    }
  );
});

test('recognizes JavaScript feature root entrypoints', () => {
  withFixture(
    {
      'src/features/commonjs-default/index.cjs': `
        module.exports = require('./infrastructure/DefaultStore');
      `,
      'src/features/commonjs-default/infrastructure/DefaultStore.cjs':
        'module.exports = class DefaultStore {};',
      'src/features/commonjs-export-star/index.cjs': `
        __exportStar(require('./infrastructure/Store'), exports);
      `,
      'src/features/commonjs-export-star/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-getter/main/index.cjs': `
        const StoreModule = require('./infrastructure/Store');
        Object.defineProperty(exports, 'Store', {
          enumerable: true,
          get: function () {
            return StoreModule.Store;
          },
        });
      `,
      'src/features/commonjs-getter/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-named/main/index.js': `
        const AliasedStore = require('./infrastructure/AliasedStore');
        exports.AliasedStore = AliasedStore;
        exports.NamedStore = require('./infrastructure/NamedStore');
        Object.defineProperty(exports, 'DefinedStore', {
          value: require('./infrastructure/DefinedStore'),
        });
      `,
      'src/features/commonjs-named/main/infrastructure/AliasedStore.js':
        'module.exports = class AliasedStore {};',
      'src/features/commonjs-named/main/infrastructure/DefinedStore.js':
        'module.exports = class DefinedStore {};',
      'src/features/commonjs-named/main/infrastructure/NamedStore.js':
        'module.exports = class NamedStore {};',
      'src/features/commonjs-safe/index.cjs': `
        const barrel = require('./mixedBarrel');
        module.exports = { Safe: barrel.Safe };
      `,
      'src/features/commonjs-safe/mixedBarrel.js': `
        export { Safe } from './safe';
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/commonjs-safe/safe.js': 'export const Safe = true;',
      'src/features/commonjs-safe/infrastructure/Infra.js': 'export class Infra {}',
      'src/features/destructuring-write/main/index.js': `
        export let Store;
        ({ Store } = require('./infrastructure/Store'));
      `,
      'src/features/destructuring-write/main/infrastructure/Store.js':
        'export class Store {}',
      'src/features/js-feature/adapters/Adapter.js': 'export class Adapter {}',
      'src/features/js-feature/index.jsx': `export { Adapter } from './adapters/Adapter';`,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      assert.deepEqual(
        violations
          .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
          .map(toBaselineEntry),
        [
          {
            publicEntrypoint: 'src/features/commonjs-default/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-default/index.cjs',
            specifier: './infrastructure/DefaultStore',
          },
          {
            publicEntrypoint: 'src/features/commonjs-export-star/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-export-star/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/commonjs-getter/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-getter/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/commonjs-named/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-named/main/index.js',
            specifier: './infrastructure/AliasedStore',
          },
          {
            publicEntrypoint: 'src/features/commonjs-named/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-named/main/index.js',
            specifier: './infrastructure/DefinedStore',
          },
          {
            publicEntrypoint: 'src/features/commonjs-named/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-named/main/index.js',
            specifier: './infrastructure/NamedStore',
          },
          {
            publicEntrypoint: 'src/features/destructuring-write/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/destructuring-write/main/index.js',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/js-feature/index.jsx',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/js-feature/index.jsx',
            specifier: './adapters/Adapter',
          },
        ]
      );
    }
  );
});

test('preserves member selection through local aliases', () => {
  withFixture(
    {
      'src/features/default-alias/main/index.ts': `
        import { Infra } from './barrel';
        const Impl = Infra;
        export default Impl.value;
      `,
      'src/features/default-alias/main/barrel.ts': `
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/default-alias/main/infrastructure/Infra.ts':
        'export const Infra = { value: true };',
      'src/features/namespace-safe/main/index.ts': `
        const barrel = await import('./mixedBarrel');
        export const Safe = barrel.Safe;
        export const CastSafe = (barrel as any).Safe;
        export const InlineSafe = (await import('./mixedBarrel')).Safe;
      `,
      'src/features/namespace-safe/main/mixedBarrel.ts': `
        export { Safe } from './safe';
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/namespace-safe/main/safe.ts': 'export const Safe = true;',
      'src/features/namespace-safe/main/infrastructure/Infra.ts': 'export class Infra {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      assert.deepEqual(
        violations
          .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
          .map(toBaselineEntry),
        [
          {
            publicEntrypoint: 'src/features/default-alias/main/index.ts',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/default-alias/main/barrel.ts',
            specifier: './infrastructure/Infra',
          },
        ]
      );
    }
  );
});

test('uses stable dependency identities that ignore line movement', () => {
  const first = architectureViolation(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );
  const moved = { ...first, line: 400 };

  assert.equal(violationKey(first), violationKey(moved));
});

test('rejects new and stale dependency edges independently within the same legacy file', () => {
  const source = 'src/features/example/core/application/useCase.ts';
  const legacy = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    source,
    '@shared/types'
  );
  const added = architectureViolation(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    source,
    '@shared/utils/errorHandling'
  );

  assert.deepEqual(
    evaluateFeatureArchitectureRatchet({
      baselineEntries: [legacy],
      baselineReferenceEntries: null,
      violations: [added],
    }).map(({ code, entry }) => ({ code, specifier: entry.specifier })),
    [
      { code: 'new-architecture-violation', specifier: '@shared/utils/errorHandling' },
      { code: 'stale-baseline-entry', specifier: '@shared/types' },
    ]
  );
});

test('forbids baseline expansion relative to the PR base while allowing removals', () => {
  const retained = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );
  const added = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'electron'
  );

  assert.deepEqual(
    evaluateFeatureArchitectureRatchet({
      baselineEntries: [retained, added],
      baselineReferenceEntries: [retained],
      violations: [
        { ...retained, line: 1, message: 'retained violation' },
        { ...added, line: 2, message: 'added violation' },
      ],
    }).map(({ code, entry }) => ({ code, specifier: entry.specifier })),
    [{ code: 'baseline-expansion', specifier: 'electron' }]
  );
});

test('validates baseline schema, uniqueness, and canonical ordering', () => {
  const later = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
    'src/features/example/main/index.ts',
    './infrastructure/store',
    'src/features/example/main/index.ts'
  );
  const earlier = baselineEntry(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    'src/features/example/core/domain/policy.ts',
    'node:path'
  );

  const validation = validateFeatureArchitectureBaseline({
    version: 1,
    violations: [later, earlier, earlier],
  });

  assert.deepEqual(
    validation.diagnostics.map(({ code }) => code),
    ['duplicate-baseline-entry', 'unsorted-baseline']
  );
});

test('keeps the checked-in exact-edge baseline synchronized with production source', () => {
  const result = verifyFeatureArchitecture({ baselineRef: null, root: repoRoot });

  assert.equal(result.baselineEntries.length, result.violations.length);
  assert.ok(result.sourceFileCount > result.violations.length);
  assert.ok(result.violations.length > 0);
});
