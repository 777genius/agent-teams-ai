import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
import { withFeatureFixture as withFixture } from './support/feature-fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function baselineEntry(rule, source, specifier, publicEntrypoint) {
  const entry = { rule, source, specifier };
  if (publicEntrypoint) {
    entry.publicEntrypoint = publicEntrypoint;
    entry.exportedName = 'Store';
    entry.importedName = 'Store';
  }
  return entry;
}

function uniqueBaselineLocations(violations) {
  const locations = new Map();
  for (const violation of violations) {
    const baseline = toBaselineEntry(violation);
    const entry = {
      rule: baseline.rule,
      source: baseline.source,
      specifier: baseline.specifier,
    };
    if (baseline.publicEntrypoint) entry.publicEntrypoint = baseline.publicEntrypoint;
    locations.set(JSON.stringify(entry), entry);
  }
  return [...locations.values()];
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

test('accepts public aliases only when they resolve to index entrypoints', () => {
  withFixture(
    {
      'src/features/alpha/main/composition/createAlpha.ts': `
        import { rootFile } from '@features/root-file';
        import { mainFile } from '@features/main-file/main';
        import type { ContractFile } from '@features/contracts-file/contracts';
        import { rootIndex } from '@features/root-index';
        import { mainIndex } from '@features/main-index/main';
        import type { ContractIndex } from '@features/contracts-index/contracts';
      `,
      'src/features/contracts-file/contracts.ts': 'export interface ContractFile {}',
      'src/features/contracts-index/contracts/index.ts': 'export interface ContractIndex {}',
      'src/features/main-file/main.ts': 'export const mainFile = true;',
      'src/features/main-index/main/index.ts': 'export const mainIndex = true;',
      'src/features/root-file.ts': 'export const rootFile = true;',
      'src/features/root-index/index.ts': 'export const rootIndex = true;',
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
            specifier: '@features/contracts-file/contracts',
          },
          {
            source: 'src/features/alpha/main/composition/createAlpha.ts',
            specifier: '@features/main-file/main',
          },
          {
            source: 'src/features/alpha/main/composition/createAlpha.ts',
            specifier: '@features/root-file',
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

test('resolves allowed contract barrels to their dependency-rule origins', () => {
  withFixture(
    {
      'src/features/example/contracts/index.ts': `
        export * from './unsafeStar';
        export type { ExplicitTypeOnly, SafeContract } from './safe';
        export { AppService } from './runtime';
        export interface LocalSafeContract {}
      `,
      'src/features/example/contracts/unsafeStar.ts': `
        export { RuntimeAdapter as ExplicitTypeOnly } from '../main/RuntimeAdapter';
        export { RuntimeAdapter as SafeContract } from '../main/RuntimeAdapter';
        export { RuntimeAdapter as LocalSafeContract } from '../main/RuntimeAdapter';
      `,
      'src/features/example/contracts/runtime.ts': `
        export { AppService } from '../core/application/AppService';
        export { RuntimeAdapter } from '../main/RuntimeAdapter';
      `,
      'src/features/example/contracts/safe.ts': `
        export interface ExplicitTypeOnly {}
        export interface SafeContract {}
      `,
      'src/features/example/core/application/AppService.ts':
        'export class AppService {}',
      'src/features/example/core/application/useContract.ts': `
        import { RuntimeAdapter } from '../../contracts/runtime';
        void RuntimeAdapter;
      `,
      'src/features/example/main/RuntimeAdapter.ts': 'export class RuntimeAdapter {}',
      'src/features/example/core/domain/policy.ts': `
        import type {
          ExplicitTypeOnly,
          LocalSafeContract,
          SafeContract,
        } from '../../contracts';
        import { AppService } from '../../contracts';
        export type Policy = ExplicitTypeOnly & SafeContract & LocalSafeContract;
        void AppService;
      `,
      'src/features/example/core/domain/runtimeExplicit.ts': `
        const ExplicitTypeOnly = require('../../contracts').ExplicitTypeOnly;
        void ExplicitTypeOnly;
      `,
      'src/features/example/core/domain/runtimeLocal.ts': `
        const LocalSafeContract = require('../../contracts').LocalSafeContract;
        void LocalSafeContract;
      `,
      'src/features/other/contracts/index.ts': `
        export { RuntimeService } from '../main/RuntimeService';
      `,
      'src/features/other/main/RuntimeService.ts': 'export class RuntimeService {}',
      'src/features/example/core/domain/remotePolicy.ts': `
        import { RuntimeService } from '@features/other/contracts';
        void RuntimeService;
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const domainViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreDomainIsolation
      );

      assert.deepEqual(
        domainViolations.map(({ source, specifier }) => ({ source, specifier })),
        [
          {
            source: 'src/features/example/core/domain/policy.ts',
            specifier: '../../contracts',
          },
          {
            source: 'src/features/example/core/domain/remotePolicy.ts',
            specifier: '@features/other/contracts',
          },
          {
            source: 'src/features/example/core/domain/runtimeExplicit.ts',
            specifier: '../../contracts',
          },
          {
            source: 'src/features/example/core/domain/runtimeLocal.ts',
            specifier: '../../contracts',
          },
        ]
      );
      const applicationViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies
      );
      assert.deepEqual(applicationViolations.map(({ source, specifier }) => ({
        source,
        specifier,
      })), [
        {
          source: 'src/features/example/core/application/useContract.ts',
          specifier: '../../contracts/runtime',
        },
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
        version: 2,
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

      assert.deepEqual(uniqueBaselineLocations(publicApiViolations), [
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
      'src/features/commonjs-create-binding/main/index.cjs': `
        __createBinding(exports, require('./infrastructure/Store'), 'Store');
        tslib.__createBinding(
          module.exports,
          require('./infrastructure/Repository'),
          'Repository',
          'PublicRepository'
        );
      `,
      'src/features/commonjs-create-binding/main/infrastructure/Repository.cjs':
        'exports.Repository = class Repository {};',
      'src/features/commonjs-create-binding/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-create-binding-safe/main/index.cjs': `
        const barrel = require('./mixedBarrel');
        __createBinding(exports, barrel, 'Safe');
      `,
      'src/features/commonjs-create-binding-safe/main/mixedBarrel.js': `
        export { Safe } from './safe';
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/commonjs-create-binding-safe/main/safe.js': 'export const Safe = true;',
      'src/features/commonjs-create-binding-safe/main/infrastructure/Infra.js':
        'export class Infra {}',
      'src/features/commonjs-define-properties/main/index.cjs': `
        const StoreModule = require('./infrastructure/Store');
        Object.defineProperties(exports, {
          Store: {
            enumerable: true,
            get() {
              return StoreModule.Store;
            },
          },
        });
      `,
      'src/features/commonjs-define-properties/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-descriptor-alias/main/index.cjs': `
        const StoreModule = require('./infrastructure/Store');
        const descriptors = {
          Store: {
            get() {
              return StoreModule.Store;
            },
          },
        };
        Object.defineProperties(exports, descriptors);

        const Repository = require('./infrastructure/Repository');
        const repositoryDescriptor = {
          get: () => Repository,
        };
        Object.defineProperty(exports, 'Repository', repositoryDescriptor);
      `,
      'src/features/commonjs-descriptor-alias/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
      'src/features/commonjs-descriptor-alias/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/commonjs-descriptor-selection/main/index.cjs': `
        const barrel = require('./mixedBarrel');
        const descriptors = {
          Safe: { get: () => barrel.Safe },
          Infra: { get: () => barrel.Infra },
        };
        Object.defineProperty(exports, 'Safe', descriptors.Safe);
      `,
      'src/features/commonjs-descriptor-selection/main/mixedBarrel.js': `
        export { Safe } from './safe';
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/commonjs-descriptor-selection/main/safe.js': 'export const Safe = true;',
      'src/features/commonjs-descriptor-selection/main/infrastructure/Infra.js':
        'export class Infra {}',
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
      'src/features/commonjs-nested/main/index.cjs': `
        const publicName = 'DynamicStore';
        exports.api = {};
        exports.api.Store = require('./infrastructure/Store');
        exports.api[publicName] = require('./infrastructure/DynamicStore');
        Object.defineProperty(module.exports.api, 'Repository', {
          get: () => require('./infrastructure/Repository'),
        });
        Reflect.set(
          exports.api,
          'Service',
          require('./infrastructure/Service')
        );
      `,
      'src/features/commonjs-nested/main/infrastructure/DynamicStore.cjs':
        'module.exports = class DynamicStore {};',
      'src/features/commonjs-nested/main/infrastructure/Repository.cjs':
        'module.exports = class Repository {};',
      'src/features/commonjs-nested/main/infrastructure/Service.cjs':
        'module.exports = class Service {};',
      'src/features/commonjs-nested/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-nested-safe/main/index.cjs': `
        const barrel = require('./mixedBarrel');
        exports.api = {};
        Object.assign(exports.api, { Safe: barrel.Safe });
        Object.defineProperty(exports.api, 'AlsoSafe', {
          get: () => barrel.Safe,
        });
      `,
      'src/features/commonjs-nested-safe/main/mixedBarrel.js': `
        export { Safe } from './safe';
        export { Infra } from './infrastructure/Infra';
      `,
      'src/features/commonjs-nested-safe/main/safe.js': 'export const Safe = true;',
      'src/features/commonjs-nested-safe/main/infrastructure/Infra.js': 'export class Infra {}',
      'src/features/commonjs-object-getter/main/index.cjs': `
        const StoreModule = require('./infrastructure/Store');
        module.exports = {
          get Store() {
            return StoreModule.Store;
          },
        };
      `,
      'src/features/commonjs-object-getter/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
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
      'src/features/destructuring-write/main/infrastructure/Store.js': 'export class Store {}',
      'src/features/exported-object-getter/main/index.js': `
        import { Repository } from './infrastructure/Repository';
        import { Store } from './infrastructure/Store';
        export const api = {};
        Object.defineProperty(api, 'Store', {
          get() {
            return Store;
          },
        });
        Object.defineProperties(api, {
          Repository: {
            get: () => Repository,
          },
        });
      `,
      'src/features/exported-object-getter/main/infrastructure/Repository.js':
        'export class Repository {}',
      'src/features/exported-object-getter/main/infrastructure/Store.js': 'export class Store {}',
      'src/features/exported-object-literal-getter/main/index.js': `
        import { Store } from './infrastructure/Store';
        export const api = {
          get Store() {
            return Store;
          },
        };
      `,
      'src/features/exported-object-literal-getter/main/infrastructure/Store.js':
        'export class Store {}',
      'src/features/js-feature/adapters/Adapter.js': 'export class Adapter {}',
      'src/features/js-feature/index.jsx': `export { Adapter } from './adapters/Adapter';`,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      assert.deepEqual(
        uniqueBaselineLocations(
          violations.filter(
            ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
          )
        ),
        [
          {
            publicEntrypoint: 'src/features/commonjs-create-binding/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-create-binding/main/index.cjs',
            specifier: './infrastructure/Repository',
          },
          {
            publicEntrypoint: 'src/features/commonjs-create-binding/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-create-binding/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/commonjs-default/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-default/index.cjs',
            specifier: './infrastructure/DefaultStore',
          },
          {
            publicEntrypoint: 'src/features/commonjs-define-properties/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-define-properties/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/commonjs-descriptor-alias/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-descriptor-alias/main/index.cjs',
            specifier: './infrastructure/Repository',
          },
          {
            publicEntrypoint: 'src/features/commonjs-descriptor-alias/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-descriptor-alias/main/index.cjs',
            specifier: './infrastructure/Store',
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
            publicEntrypoint: 'src/features/commonjs-nested/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-nested/main/index.cjs',
            specifier: './infrastructure/DynamicStore',
          },
          {
            publicEntrypoint: 'src/features/commonjs-nested/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-nested/main/index.cjs',
            specifier: './infrastructure/Repository',
          },
          {
            publicEntrypoint: 'src/features/commonjs-nested/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-nested/main/index.cjs',
            specifier: './infrastructure/Service',
          },
          {
            publicEntrypoint: 'src/features/commonjs-nested/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-nested/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/commonjs-object-getter/main/index.cjs',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/commonjs-object-getter/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/destructuring-write/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/destructuring-write/main/index.js',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/exported-object-getter/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/exported-object-getter/main/index.js',
            specifier: './infrastructure/Repository',
          },
          {
            publicEntrypoint: 'src/features/exported-object-getter/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/exported-object-getter/main/index.js',
            specifier: './infrastructure/Store',
          },
          {
            publicEntrypoint: 'src/features/exported-object-literal-getter/main/index.js',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/exported-object-literal-getter/main/index.js',
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

test('traces top-level getter aliases only when public descriptors expose them', () => {
  withFixture(
    {
      'src/features/getter-alias/main/index.cjs': `
        const AliasedModule = require('./infrastructure/Aliased');
        const HiddenModule = require('./infrastructure/Hidden');
        const RepositoryModule = require('./infrastructure/Repository');
        const StoreModule = require('./infrastructure/Store');

        const getAliased = () => AliasedModule.Aliased;
        const getHidden = () => HiddenModule.Hidden;
        const getStore = () => StoreModule.Store;
        function getRepository() {
          return RepositoryModule.Repository;
        }
        const aliasedDescriptor = { get: getAliased };

        Object.defineProperty(exports, 'Aliased', aliasedDescriptor);
        Object.defineProperty(exports, 'Store', { get: getStore });
        Object.defineProperties(exports, {
          Repository: { get: getRepository },
        });
        void getHidden;
      `,
      'src/features/getter-alias/main/infrastructure/Aliased.cjs':
        'exports.Aliased = class Aliased {};',
      'src/features/getter-alias/main/infrastructure/Hidden.cjs':
        'exports.Hidden = class Hidden {};',
      'src/features/getter-alias/main/infrastructure/Repository.cjs':
        'exports.Repository = class Repository {};',
      'src/features/getter-alias/main/infrastructure/Store.cjs': 'exports.Store = class Store {};',
      'src/features/getter-alias-extended/main/index.cjs': `
        const AssignedModule = require('./infrastructure/Assigned');
        const HiddenModule = require('./infrastructure/Hidden');
        const StoreModule = require('./infrastructure/Store');

        const getters = {
          getStore() {
            return StoreModule.Store;
          },
          getHidden() {
            return HiddenModule.Hidden;
          },
        };
        let getAssigned;
        getAssigned = () => AssignedModule.Assigned;

        Object.defineProperty(exports, 'Store', { get: getters.getStore });
        Object.defineProperty(exports, 'Assigned', { get: getAssigned });
        void getters.getHidden;
      `,
      'src/features/getter-alias-extended/main/infrastructure/Assigned.cjs':
        'exports.Assigned = class Assigned {};',
      'src/features/getter-alias-extended/main/infrastructure/Hidden.cjs':
        'exports.Hidden = class Hidden {};',
      'src/features/getter-alias-extended/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/getter-alias-public-target/main/index.cjs': `
        const StoreModule = require('./infrastructure/Store');
        const getStore = () => StoreModule.Store;
        const descriptor = { get: getStore };
        const publicTarget = exports;
        Object.defineProperty(publicTarget, 'Store', descriptor);
      `,
      'src/features/getter-alias-public-target/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/getter-esm-public-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        export const api = {};
        const publicTarget = api;
        Object.defineProperty(publicTarget, 'Store', { get: getStore });
      `,
      'src/features/getter-esm-public-target/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-nested-public-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        const nested = {};
        export const api = { nested };
        Object.defineProperty(nested, 'Store', { get: getStore });
      `,
      'src/features/getter-nested-public-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-reassigned-target-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        let target = {};
        export const api = { target };
        target = {};
        Object.defineProperty(target, 'Store', { get: getStore });
      `,
      'src/features/getter-reassigned-target-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-target-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        const hidden = {};
        export const api = { ...hidden };
        Object.defineProperty(hidden, 'Store', { get: getStore });
      `,
      'src/features/getter-spread-target-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-created-public-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        export const api = Object.create(null);
        const target = api;
        Object.defineProperty(target, 'Store', { get: getStore });
      `,
      'src/features/getter-created-public-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-created-nested-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        const nested = Object.create(null);
        export const api = { nested };
        Object.defineProperty(nested, 'Store', { get: getStore });
      `,
      'src/features/getter-created-nested-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-constructed-nested-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        class PublicTarget {}
        const nested = new PublicTarget();
        export const api = { nested };
        Object.defineProperty(nested, 'Store', { get: getStore });
      `,
      'src/features/getter-constructed-nested-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-commonjs-assignment-target/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const publicTarget = exports;
        publicTarget.Store = Store;
      `,
      'src/features/getter-commonjs-assignment-target/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-create-binding-target/main/index.cjs': `
        const publicTarget = exports;
        __createBinding(publicTarget, require('./infrastructure/Store'), 'Store');
      `,
      'src/features/getter-commonjs-create-binding-target/main/infrastructure/Store.cjs':
        'exports.Store = class Store {};',
      'src/features/getter-let-export-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export let api = target;
        target.Store = Store;
      `,
      'src/features/getter-let-export-target/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-let-nested-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let target = {};
        export const api = { target };
        target.Store = Store;
      `,
      'src/features/getter-let-nested-target/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-spread-before-copy/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-before-copy/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-assign-copy/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = Object.assign({}, hidden);
      `,
      'src/features/getter-object-assign-copy/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-freeze-member/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const container = { api: {} };
        container.api.Store = Store;
        export const api = Object.freeze(container.api);
      `,
      'src/features/getter-freeze-member/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-object-assign-overwritten-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = Object.assign({}, hidden, { Store: undefined });
      `,
      'src/features/getter-object-assign-overwritten-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-after-publication-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        const alias = {};
        export const api = { ...alias };
        Object.assign(alias, hidden);
      `,
      'src/features/getter-copy-after-publication-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-overwrite-before-publication-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        hidden.Store = undefined;
        const alias = { ...hidden };
        export const api = { ...alias };
      `,
      'src/features/getter-copy-overwrite-before-publication-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-parent-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = { api: {} };
        hidden.api.Store = Store;
        hidden.api = {};
        export const api = { ...hidden.api };
      `,
      'src/features/getter-copy-parent-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-source-order-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const safe = {};
        safe.Store = undefined;
        const hidden = {};
        hidden.Store = Store;
        const alias = Object.assign({}, hidden, safe);
        export const api = { ...alias };
      `,
      'src/features/getter-copy-source-order-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-descriptor-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        Object.defineProperty(hidden, 'Store', { value: undefined });
        const alias = { ...hidden };
        export const api = { ...alias };
      `,
      'src/features/getter-copy-descriptor-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-target-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        const alias = { ...hidden };
        export const api = { ...alias };
        api.Store = undefined;
      `,
      'src/features/getter-copy-target-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-nested-target-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = { nested: {} };
        Object.assign(api.nested, hidden);
        api.nested.Store = undefined;
      `,
      'src/features/getter-copy-nested-target-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-copy-nested-initializer-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        export const api = { nested: { ...hidden } };
        api.nested.Store = undefined;
      `,
      'src/features/getter-copy-nested-initializer-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-descriptor-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptor = { get: () => Store, enumerable: true };
        const hidden = {};
        Object.defineProperty(hidden, 'Store', descriptor);
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-descriptor-alias/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        Object.defineProperties(hidden, {
          Store: { value: Store, enumerable: true },
        });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-define-properties/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-define-properties-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptors = {
          Store: { value: Store, enumerable: true },
        };
        const hidden = {};
        Object.defineProperties(hidden, { ...descriptors });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-define-properties-map/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-define-properties-getter-map/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptor = { get: () => Store, enumerable: true };
        const descriptors = { Store: descriptor };
        const hidden = {};
        Object.defineProperties(hidden, { ...descriptors });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-define-properties-getter-map/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-define-properties-map-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptors = {
          Store: { value: Store, enumerable: true },
        };
        const hidden = {};
        Object.defineProperties(hidden, {
          ...descriptors,
          Store: { value: undefined, enumerable: true },
        });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-define-properties-map-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-define-properties-getter-map-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptor = { get: () => Store, enumerable: true };
        const descriptors = { Store: descriptor };
        const hidden = {};
        Object.defineProperties(hidden, {
          ...descriptors,
          Store: { value: undefined, enumerable: true },
        });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-define-properties-getter-map-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-descriptor-alias-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptor = { get: () => Store, enumerable: false };
        const hidden = {};
        Object.defineProperty(hidden, 'Store', descriptor);
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-descriptor-alias-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-set-prototype-of/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const proto = {};
        export const api = {};
        Object.setPrototypeOf(api, proto);
        proto.Store = Store;
      `,
      'src/features/getter-set-prototype-of/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-set-prototype-stale-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const proto = {};
        export let api = {};
        Object.setPrototypeOf(api, proto);
        api = {};
        proto.Store = Store;
      `,
      'src/features/getter-set-prototype-stale-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-overwritten-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        hidden.Store = undefined;
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-overwritten-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-create-descriptor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = Object.create(null, {
          Store: { get: () => Store },
        });
      `,
      'src/features/getter-object-create-descriptor/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-create-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const proto = {};
        export const api = Object.create(proto);
        proto.Store = Store;
      `,
      'src/features/getter-object-create-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-commonjs-reset-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const oldApi = module.exports;
        module.exports = {};
        Object.defineProperty(oldApi, 'OldStore', { get: () => Store });
        exports.Store = Store;
        exports = {};
        exports.OtherStore = Store;
      `,
      'src/features/getter-commonjs-reset-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-overwritten-public-target-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target = {};
        Object.defineProperty(target, 'Store', { get: () => Store });
      `,
      'src/features/getter-overwritten-public-target-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-constructor-body/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            this.Store = Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/getter-constructor-body/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/getter-constructor-internal-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          #store = new Store();
          constructor() {
            Store.bootstrap();
            const local = new Store();
            void local;
          }
          refresh() {
            Store.bootstrap();
          }
        }
        export const api = new Api();
      `,
      'src/features/getter-constructor-internal-safe/main/infrastructure/Store.ts': `
        export class Store {
          static bootstrap() {}
        }
      `,
      'src/features/getter-constructor-private-assignment-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          #store;
          private cached;
          protected fallback;
          constructor() {
            this.#store = Store;
            this.cached = Store;
            this.fallback = Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/getter-constructor-private-assignment-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-constructor-nested-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          refresh() {
            [1].map(() => {
              return Store;
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/getter-constructor-nested-return-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-destructured-esm-target/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const root = { api: {} };
        const { api } = root;
        api.Store = Store;
      `,
      'src/features/getter-destructured-esm-target/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-destructured-commonjs-target/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.api = {};
        const { api } = exports;
        api.Store = Store;
      `,
      'src/features/getter-destructured-commonjs-target/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-reassigned-before-export/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let target = {};
        target = {};
        export const api = { target };
        target.Store = Store;
      `,
      'src/features/getter-reassigned-before-export/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-reassigned-after-publication/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let target = {};
        export const api = { target };
        target.Store = Store;
        target = {};
      `,
      'src/features/getter-reassigned-after-publication/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-assigned-before-export/main/index.ts': `
        import { Store } from './infrastructure/Store';
        let target;
        target = {};
        export const api = { target };
        target.Store = Store;
      `,
      'src/features/getter-assigned-before-export/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-logical-assignment-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        api.target ||= {};
        target.Store = Store;
      `,
      'src/features/getter-logical-assignment-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-commonjs-member-alias/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.api = {};
        const api = exports.api;
        api.Store = Store;
      `,
      'src/features/getter-commonjs-member-alias/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-chained-left/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports = module.exports = {};
        exports.Store = Store;
      `,
      'src/features/getter-commonjs-chained-left/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-chained-right/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        module.exports = exports = {};
        exports.Store = Store;
      `,
      'src/features/getter-commonjs-chained-right/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-relinked/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        module.exports = exports;
        exports.Store = Store;
      `,
      'src/features/getter-commonjs-relinked/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-object-create-descriptor-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptors = {
          Store: { get: () => Store },
        };
        export const api = Object.create(null, descriptors);
      `,
      'src/features/getter-object-create-descriptor-alias/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-create-member-prototype/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const registry = { proto: {} };
        export const api = Object.create(registry.proto);
        registry.proto.Store = Store;
      `,
      'src/features/getter-object-create-member-prototype/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-define-property-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        Object.defineProperty(api, 'target', { value: {} });
        target.Store = Store;
      `,
      'src/features/getter-define-property-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-block-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const target = {};
        export const api = { target };
        {
          api.target = {};
        }
        target.Store = Store;
      `,
      'src/features/getter-block-overwrite-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-nonenumerable-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        Object.defineProperty(hidden, 'Store', {
          enumerable: false,
          get: () => Store,
        });
        export const api = { ...hidden };
      `,
      'src/features/getter-spread-nonenumerable-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-spread-sibling-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const root = { visible: {}, hidden: {} };
        root.hidden.Store = Store;
        export const api = { ...root.visible };
      `,
      'src/features/getter-spread-sibling-safe/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-create-descriptor-reference/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const descriptors = {
          Store: { get: () => Store },
        };
        export const api = Object.create(null, descriptors);
      `,
      'src/features/getter-object-create-descriptor-reference/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-object-create-getter-reference/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const getStore = () => Store;
        const descriptors = {
          Store: { get: getStore },
        };
        export const api = Object.create(null, descriptors);
      `,
      'src/features/getter-object-create-getter-reference/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-commonjs-final-reset-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.Store = Store;
        module.exports = {};
      `,
      'src/features/getter-commonjs-final-reset-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-module-final-reset-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        module.exports.Store = Store;
        module.exports = {};
      `,
      'src/features/getter-commonjs-module-final-reset-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-spread/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = { ...hidden };
      `,
      'src/features/getter-commonjs-spread/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-function-constructor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        function Api() {
          this.Store = Store;
        }
        export const api = new Api();
      `,
      'src/features/getter-function-constructor/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-nested-constructor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            this.Store = Store;
          }
        }
        export const root = { api: new Api() };
      `,
      'src/features/getter-nested-constructor/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-default-constructor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            this.Store = Store;
          }
        }
        export default new Api();
      `,
      'src/features/getter-default-constructor/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-commonjs-false-reset/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.Store = Store;
        if (false) module.exports = {};
      `,
      'src/features/getter-commonjs-false-reset/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-commonjs-false-exports-reset/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        if (false) exports = {};
        exports.Store = Store;
      `,
      'src/features/getter-commonjs-false-exports-reset/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/getter-constructor-spread/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            this.Store = Store;
          }
        }
        const instance = new Api();
        export const api = { ...instance };
      `,
      'src/features/getter-constructor-spread/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-constructor-wrapper/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            this.Store = Store;
          }
        }
        export const api = Object.freeze(new Api());
      `,
      'src/features/getter-constructor-wrapper/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/getter-factory-safe/main/index.ts': `
        import { Concrete } from './infrastructure/Concrete';
        interface PublicPort {}
        const createFeature = (): PublicPort => new Concrete();
        export { createFeature };
      `,
      'src/features/getter-factory-safe/main/infrastructure/Concrete.ts':
        'export class Concrete {}',
      'src/features/getter-field-factory-safe/main/index.ts': `
        import { Concrete } from './infrastructure/Concrete';
        interface PublicPort {}
        const createFeature = (): PublicPort => new Concrete();
        export const api = { get: createFeature };
        Object.defineProperty({}, 'private', api);
      `,
      'src/features/getter-field-factory-safe/main/infrastructure/Concrete.ts':
        'export class Concrete {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const implementationViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
      );
      assert.deepEqual(implementationViolations.map(({ specifier }) => specifier).sort(), [
        './infrastructure/Aliased',
        './infrastructure/Assigned',
        './infrastructure/Repository',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
        './infrastructure/Store',
      ]);
      assert.ok(
        implementationViolations.some(
          ({ source }) =>
            source === 'src/features/getter-object-create-descriptor-reference/main/index.ts'
        )
      );
      assert.ok(
        implementationViolations.some(
          ({ source }) =>
            source === 'src/features/getter-object-create-getter-reference/main/index.ts'
        )
      );
      for (const source of [
        'src/features/getter-object-assign-copy/main/index.ts',
        'src/features/getter-freeze-member/main/index.ts',
        'src/features/getter-set-prototype-of/main/index.ts',
        'src/features/getter-spread-define-properties/main/index.ts',
        'src/features/getter-spread-define-properties-getter-map/main/index.ts',
        'src/features/getter-spread-define-properties-map/main/index.ts',
        'src/features/getter-spread-descriptor-alias/main/index.ts',
      ]) {
        assert.ok(
          implementationViolations.some((violation) => violation.source === source),
          `${source} must expose its implementation reference`
        );
      }
      for (const source of [
        'src/features/getter-commonjs-final-reset-safe/main/index.cjs',
        'src/features/getter-commonjs-module-final-reset-safe/main/index.cjs',
        'src/features/getter-constructor-internal-safe/main/index.ts',
        'src/features/getter-constructor-nested-return-safe/main/index.ts',
        'src/features/getter-constructor-private-assignment-safe/main/index.ts',
        'src/features/getter-copy-after-publication-safe/main/index.ts',
        'src/features/getter-copy-descriptor-overwrite-safe/main/index.ts',
        'src/features/getter-copy-nested-initializer-overwrite-safe/main/index.ts',
        'src/features/getter-copy-nested-target-overwrite-safe/main/index.ts',
        'src/features/getter-copy-overwrite-before-publication-safe/main/index.ts',
        'src/features/getter-copy-parent-overwrite-safe/main/index.ts',
        'src/features/getter-copy-source-order-safe/main/index.ts',
        'src/features/getter-copy-target-overwrite-safe/main/index.ts',
        'src/features/getter-object-assign-overwritten-safe/main/index.ts',
        'src/features/getter-set-prototype-stale-safe/main/index.ts',
        'src/features/getter-spread-descriptor-alias-safe/main/index.ts',
        'src/features/getter-spread-define-properties-getter-map-safe/main/index.ts',
        'src/features/getter-spread-define-properties-map-safe/main/index.ts',
        'src/features/getter-spread-nonenumerable-safe/main/index.ts',
        'src/features/getter-spread-sibling-safe/main/index.ts',
      ]) {
        assert.ok(
          !implementationViolations.some((violation) => violation.source === source),
          `${source} must remain private`
        );
      }
    }
  );
});

test('tracks object mutators on constructed public instances', () => {
  withFixture(
    {
      'src/features/constructor-assign/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, { Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/constructor-assign/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/constructor-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperties(this, {
              Store: { value: Store },
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/constructor-define-properties/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/constructor-define-property/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'Store', { value: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/constructor-define-property/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/constructor-reflect-set/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Reflect.set(this, 'Store', Store);
          }
        }
        export const api = new Api();
      `,
      'src/features/constructor-reflect-set/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/constructor-callback-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, {
              refresh: () => Store.bootstrap(),
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/constructor-callback-safe/main/infrastructure/Store.ts': `
        export class Store {
          static bootstrap() {}
        }
      `,
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const implementationSources = violations
        .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
        .map(({ source }) => source)
        .sort();
      assert.deepEqual(implementationSources, [
        'src/features/constructor-assign/main/index.ts',
        'src/features/constructor-define-properties/main/index.ts',
        'src/features/constructor-define-property/main/index.ts',
        'src/features/constructor-reflect-set/main/index.ts',
      ]);
    }
  );
});

test('honors dynamic source ordering within one copy operation', () => {
  withFixture(
    {
      'src/features/copy-source-order/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const hidden = {};
        hidden.Store = Store;
        const safe = {};
        safe.Store = undefined;
        const alias = Object.assign({}, hidden, safe);
        export const api = { ...alias };
      `,
      'src/features/copy-source-order/main/infrastructure/Store.ts': 'export class Store {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      assert.ok(
        !violations.some(
          ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
        )
      );
    }
  );
});

test('respects inherited constructor member visibility', () => {
  withFixture(
    {
      'src/features/inherited-protected/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Base {
          protected cached: unknown;
        }
        class Api extends Base {
          constructor() {
            super();
            this.cached = Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/inherited-protected/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/inherited-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Base {
          cached: unknown;
        }
        class Api extends Base {
          constructor() {
            super();
            this.cached = Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/inherited-public/main/infrastructure/Store.ts': 'export class Store {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const implementationSources = violations
        .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
        .map(({ source }) => source);
      assert.deepEqual(implementationSources, ['src/features/inherited-public/main/index.ts']);
    }
  );
});

test('tracks public constructor parameter properties only', () => {
  withFixture(
    {
      'src/features/parameter-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(public store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/parameter-public/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/parameter-protected/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(protected store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/parameter-protected/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/parameter-private/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(private store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/parameter-private/main/infrastructure/Store.ts': 'export class Store {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const implementationSources = violations
        .filter(({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport)
        .map(({ source }) => source);
      assert.deepEqual(implementationSources, ['src/features/parameter-public/main/index.ts']);
    }
  );
});

test('tracks CommonJS object copies with last-write semantics', () => {
  withFixture(
    {
      'src/features/commonjs-assign-exports/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        Object.assign(exports, hidden);
      `,
      'src/features/commonjs-assign-exports/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-module/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        Object.assign(module.exports, hidden);
      `,
      'src/features/commonjs-assign-module/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-spread-alias/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        const alias = { ...hidden };
        Object.assign(exports, alias);
      `,
      'src/features/commonjs-assign-spread-alias/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-object-assign/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = Object.assign({}, hidden);
      `,
      'src/features/commonjs-root-object-assign/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-freeze/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = Object.freeze(hidden);
      `,
      'src/features/commonjs-root-freeze/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-freeze-member/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const container = { api: {} };
        container.api.Store = Store;
        module.exports = Object.freeze(container.api);
      `,
      'src/features/commonjs-root-freeze-member/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-prevent-extensions/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = Object.preventExtensions(hidden);
      `,
      'src/features/commonjs-root-prevent-extensions/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-seal/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = Object.seal(hidden);
      `,
      'src/features/commonjs-root-seal/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-create/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const proto = {};
        module.exports = Object.create(proto);
        proto.Store = Store;
      `,
      'src/features/commonjs-root-create/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-set-prototype/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const proto = {};
        module.exports = Object.setPrototypeOf({}, proto);
        proto.Store = Store;
      `,
      'src/features/commonjs-root-set-prototype/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-spread-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = { ...hidden, Store: undefined };
      `,
      'src/features/commonjs-spread-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-inline-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        Object.assign(exports, { Store }, { Store: undefined });
      `,
      'src/features/commonjs-assign-inline-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-alias-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const safe = { Store: undefined };
        Object.assign(exports, { Store }, safe);
      `,
      'src/features/commonjs-assign-alias-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-spread-alias-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        const safe = { Store: undefined };
        const safeAlias = { ...safe };
        Object.assign(exports, hidden, safeAlias);
      `,
      'src/features/commonjs-assign-spread-alias-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-copy-alias-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        const safe = { Store: undefined };
        hidden.Store = Store;
        Object.assign(exports, hidden, safe);
      `,
      'src/features/commonjs-assign-copy-alias-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-copy-after-publication-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        const alias = {};
        module.exports = { ...alias };
        Object.assign(alias, hidden);
      `,
      'src/features/commonjs-copy-after-publication-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-copy-overwrite-before-publication-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        hidden.Store = undefined;
        const alias = { ...hidden };
        module.exports = { ...alias };
      `,
      'src/features/commonjs-copy-overwrite-before-publication-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-copy-parent-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = { api: {} };
        hidden.api.Store = Store;
        hidden.api = {};
        Object.assign(exports, hidden.api);
      `,
      'src/features/commonjs-copy-parent-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-copy-source-order-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const safe = {};
        safe.Store = undefined;
        const hidden = {};
        hidden.Store = Store;
        const alias = Object.assign({}, hidden, safe);
        module.exports = { ...alias };
      `,
      'src/features/commonjs-copy-source-order-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-copy-descriptor-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        Object.defineProperty(hidden, 'Store', { value: undefined });
        const alias = { ...hidden };
        module.exports = { ...alias };
      `,
      'src/features/commonjs-copy-descriptor-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-late-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        Object.assign(exports, hidden);
        exports.Store = undefined;
      `,
      'src/features/commonjs-assign-late-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-spread-late-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = { ...hidden };
        module.exports.Store = undefined;
      `,
      'src/features/commonjs-spread-late-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assignment-late-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.Store = Store;
        exports.Store = undefined;
      `,
      'src/features/commonjs-assignment-late-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-object-late-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        module.exports = { Store };
        module.exports.Store = undefined;
      `,
      'src/features/commonjs-root-object-late-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-assign-second-call-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        Object.assign(exports, hidden);
        Object.assign(exports, { Store: undefined });
      `,
      'src/features/commonjs-assign-second-call-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-define-property-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        exports.Store = Store;
        Object.defineProperty(exports, 'Store', { value: undefined });
      `,
      'src/features/commonjs-define-property-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-define-properties-alias-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const baseDescriptors = {
          Store: { value: undefined },
        };
        const descriptors = { ...baseDescriptors };
        exports.Store = Store;
        Object.defineProperties(exports, descriptors);
      `,
      'src/features/commonjs-define-properties-alias-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-object-assign-overwrite-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const hidden = {};
        hidden.Store = Store;
        module.exports = Object.assign({}, hidden, { Store: undefined });
      `,
      'src/features/commonjs-root-object-assign-overwrite-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/commonjs-root-freeze-member-detached-safe/main/index.cjs': `
        const Store = require('./infrastructure/Store');
        const container = { api: {} };
        module.exports = Object.freeze(container.api);
        container.api = {};
        container.api.Store = Store;
      `,
      'src/features/commonjs-root-freeze-member-detached-safe/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      const implementationViolations = violations.filter(
        ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
      );

      assert.deepEqual(
        implementationViolations.map(({ source, specifier }) => ({ source, specifier })),
        [
          {
            source: 'src/features/commonjs-assign-exports/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-assign-module/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-assign-spread-alias/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-create/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-freeze-member/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-freeze/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-object-assign/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-prevent-extensions/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-seal/main/index.cjs',
            specifier: './infrastructure/Store',
          },
          {
            source: 'src/features/commonjs-root-set-prototype/main/index.cjs',
            specifier: './infrastructure/Store',
          },
        ]
      );
    }
  );
});

test('preserves string-literal member selection for indexed import types', () => {
  withFixture(
    {
      'src/features/indexed-infra/main/index.ts': `
        export type Infra = import('./mixedBarrel')['Infra'];
      `,
      'src/features/indexed-infra/main/mixedBarrel.ts': `
        export { Infra } from './infrastructure/Infra';
        export { Safe } from './safe';
      `,
      'src/features/indexed-infra/main/infrastructure/Infra.ts': 'export interface Infra {}',
      'src/features/indexed-infra/main/safe.ts': 'export interface Safe {}',
      'src/features/indexed-safe/main/index.ts': `
        export type Safe = import('./mixedBarrel')[('Safe')];
        export type SafeUnion = import('./mixedBarrel')['Safe' | ('AlsoSafe')];
      `,
      'src/features/indexed-safe/main/mixedBarrel.ts': `
        export { AlsoSafe } from './alsoSafe';
        export { Infra } from './infrastructure/Infra';
        export { Safe } from './safe';
      `,
      'src/features/indexed-safe/main/alsoSafe.ts': 'export interface AlsoSafe {}',
      'src/features/indexed-safe/main/infrastructure/Infra.ts': 'export interface Infra {}',
      'src/features/indexed-safe/main/safe.ts': 'export interface Safe {}',
      'src/features/indexed-union-infra/main/index.ts': `
        export type Mixed = import('./mixedBarrel')[('Safe') | 'Infra'];
      `,
      'src/features/indexed-union-infra/main/mixedBarrel.ts': `
        export { Infra } from './infrastructure/Infra';
        export { Safe } from './safe';
      `,
      'src/features/indexed-union-infra/main/infrastructure/Infra.ts': 'export interface Infra {}',
      'src/features/indexed-union-infra/main/safe.ts': 'export interface Safe {}',
    },
    (root) => {
      const { violations } = collectFeatureArchitectureViolations(root);
      assert.deepEqual(
        uniqueBaselineLocations(
          violations.filter(
            ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
          )
        ),
        [
          {
            publicEntrypoint: 'src/features/indexed-infra/main/index.ts',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/indexed-infra/main/mixedBarrel.ts',
            specifier: './infrastructure/Infra',
          },
          {
            publicEntrypoint: 'src/features/indexed-union-infra/main/index.ts',
            rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
            source: 'src/features/indexed-union-infra/main/mixedBarrel.ts',
            specifier: './infrastructure/Infra',
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
        uniqueBaselineLocations(
          violations.filter(
            ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
          )
        ),
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

test('analyzes the base source when the base predates the baseline manifest', () => {
  withFixture(
    {
      'scripts/ci/feature-architecture-baseline.json': '',
      'src/features/example/core/domain/policy.ts': `import path from 'node:path';`,
    },
    (root) => {
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['add', '--', 'src'], { cwd: root });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Architecture Guard',
          '-c',
          'user.email=architecture-guard@example.test',
          'commit',
          '--quiet',
          '-m',
          'test: create pre-manifest base',
        ],
        { cwd: root }
      );
      const baselineRef = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();

      writeFileSync(
        path.join(root, 'src/features/example/core/domain/policy.ts'),
        `import electron from 'electron'; import path from 'node:path';`
      );
      const { violations } = collectFeatureArchitectureViolations(root);
      writeFileSync(
        path.join(root, 'scripts/ci/feature-architecture-baseline.json'),
        `${JSON.stringify(
          { version: 2, violations: violations.map(toBaselineEntry) },
          null,
          2
        )}\n`
      );

      assert.throws(
        () => verifyFeatureArchitecture({ baselineRef, root }),
        /baseline-expansion.*electron/s
      );
    }
  );
});

test('treats the all-zero first-push base SHA as no comparison', () => {
  withFixture(
    {
      'scripts/ci/feature-architecture-baseline.json':
        '{"version":2,"violations":[]}\n',
      'src/features/example/core/domain/policy.ts': 'export const safe = true;',
    },
    (root) => {
      const result = verifyFeatureArchitecture({
        baselineRef: '0000000000000000000000000000000000000000',
        root,
      });
      assert.equal(result.violations.length, 0);
    }
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
    version: 2,
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
