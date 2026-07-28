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

const domainRule = FEATURE_ARCHITECTURE_RULES.coreDomainIsolation;
const publicApiRule = FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport;

test('rejects value dependencies on runtime packages from core domain by default', () => {
  const violations = violationsFor(
    {
      'src/features/runtime-package/core/domain/policy.ts': `
        import Database from 'better-sqlite3';
        import { createGateway } from '@terminal-platform/workspace-gateway-node';
        import YAML from 'yaml';
        import { z } from 'zod';
        import type { GraphNode } from '@claude-teams/agent-graph';
        export const policy = { Database, createGateway, YAML, z };
        export type Node = GraphNode;
      `,
    },
    domainRule
  );

  assert.deepEqual(violations.map(({ specifier }) => specifier).sort(), [
    '@terminal-platform/workspace-gateway-node',
    'better-sqlite3',
  ]);
});

test('rejects ambient NodeJS types while respecting local type bindings', () => {
  const violations = withFeatureFixture(
    {
      'src/features/ambient-node/core/application/useCase.ts': `
        export type Platform = NodeJS.Platform;
      `,
      'src/features/ambient-node/core/domain/model.js': `
        /** @typedef {NodeJS.ProcessEnv} Environment */
        export const marker = true;
      `,
      'src/features/ambient-node/core/domain/policy.ts': `
        export type Environment = NodeJS.ProcessEnv;
        export type Timer = NodeJS.Timeout;
      `,
      'src/features/local-node/core/domain/imported.ts': `
        import type { LocalTypes as NodeJS } from './localTypes';
        export type Environment = NodeJS.ProcessEnv;
      `,
      'src/features/local-node/core/domain/localTypes.ts': `
        export namespace LocalTypes {
          export interface ProcessEnv {}
        }
      `,
      'src/features/local-node/core/domain/namespace.ts': `
        namespace NodeJS {
          export interface ProcessEnv {}
        }
        export type Environment = NodeJS.ProcessEnv;
      `,
    },
    (root) => collectFeatureArchitectureViolations(root).violations
  );

  assert.deepEqual(
    violations.map(({ rule, source, specifier }) => ({ rule, source, specifier })),
    [
      {
        rule: FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
        source: 'src/features/ambient-node/core/application/useCase.ts',
        specifier: 'node:types',
      },
      {
        rule: domainRule,
        source: 'src/features/ambient-node/core/domain/model.js',
        specifier: 'node:types',
      },
      {
        rule: domainRule,
        source: 'src/features/ambient-node/core/domain/policy.ts',
        specifier: 'node:types',
      },
    ]
  );
});

test('resolves imported values only when they are not lexically shadowed', () => {
  const violations = violationsFor(
    {
      'src/features/shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {
          get Store() {
            const Store = 'safe';
            return Store;
          },
        };
      `,
      'src/features/shadow-safe/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/shadow-unsafe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const api = {
          get Store() {
            return Store;
          },
        };
      `,
      'src/features/shadow-unsafe/main/infrastructure/Store.ts': 'export class Store {}',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source }) => source),
    ['src/features/shadow-unsafe/main/index.ts']
  );
});

test('substitutes emitted ESM and CommonJS extensions before barrel traversal', () => {
  const violations = violationsFor(
    {
      'src/features/js-substitution/main/index.ts': `export * from './barrel.js';`,
      'src/features/js-substitution/main/barrel.ts': `
        export { Store } from './infrastructure/Store.js';
      `,
      'src/features/js-substitution/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/mjs-substitution/main/index.mts': `export * from './barrel.mjs';`,
      'src/features/mjs-substitution/main/barrel.mts': `
        export { Store } from './infrastructure/Store.mjs';
      `,
      'src/features/mjs-substitution/main/infrastructure/Store.mts': 'export class Store {}',
      'src/features/cjs-substitution/main/index.cts': `export * from './barrel.cjs';`,
      'src/features/cjs-substitution/main/barrel.cts': `
        export { Store } from './infrastructure/Store.cjs';
      `,
      'src/features/cjs-substitution/main/infrastructure/Store.cts': 'export class Store {}',
      'src/features/js-precedence/main/index.ts': `export * from './barrel.js';`,
      'src/features/js-precedence/main/barrel.ts': 'export const safe = true;',
      'src/features/js-precedence/main/barrel.js': `
        export { Store } from './infrastructure/Store.js';
      `,
      'src/features/js-precedence/main/infrastructure/Store.js': 'export class Store {}',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/cjs-substitution/main/barrel.cts',
        specifier: './infrastructure/Store.cjs',
      },
      {
        source: 'src/features/js-substitution/main/barrel.ts',
        specifier: './infrastructure/Store.js',
      },
      {
        source: 'src/features/mjs-substitution/main/barrel.mts',
        specifier: './infrastructure/Store.mjs',
      },
    ]
  );
});

test('collects module.require dependency edges', () => {
  const violations = violationsFor(
    {
      'src/features/module-require/main/index.cjs': `
        module.exports = module.require('./infrastructure/Store');
      `,
      'src/features/module-require/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source, specifier }) => ({ source, specifier })),
    [
      {
        source: 'src/features/module-require/main/index.cjs',
        specifier: './infrastructure/Store',
      },
    ]
  );
});

test('traces aliased CommonJS loaders into cross-feature and public API rules', () => {
  const violations = withFeatureFixture(
    {
      'src/features/alias-cross-feature/main/index.cjs': `
        const load = require;
        exports.Store = load('@features/alias-target/main/private/Store').Store;
      `,
      'src/features/alias-public/main/index.cjs': `
        const load = module.require;
        module.exports = load('./infrastructure/Store');
      `,
      'src/features/alias-public/main/infrastructure/Store.cjs':
        'module.exports = class Store {};',
      'src/features/alias-target/main/index.ts': 'export const safe = true;',
      'src/features/alias-target/main/private/Store.ts': 'export class Store {}',
    },
    (root) => collectFeatureArchitectureViolations(root).violations
  );

  assert.deepEqual(
    violations.map(({ rule, source, specifier }) => ({ rule, source, specifier })),
    [
      {
        rule: FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint,
        source: 'src/features/alias-cross-feature/main/index.cjs',
        specifier: '@features/alias-target/main/private/Store',
      },
      {
        rule: publicApiRule,
        source: 'src/features/alias-public/main/index.cjs',
        specifier: './infrastructure/Store',
      },
    ]
  );
});

test('ignores bare and module require calls with lexical loader bindings', () => {
  const violations = violationsFor(
    {
      'src/features/local-require/core/domain/policy.ts': `
        function require(specifier: string) {
          return specifier;
        }
        export const value = require('node:fs');
      `,
      'src/features/local-module/core/domain/policy.ts': `
        const module = {
          require(specifier: string) {
            return specifier;
          },
        };
        export const value = module.require('better-sqlite3');
      `,
      'src/features/imported-loader/core/domain/policy.ts': `
        import { load as require } from './safe';
        import module from './safeModule';
        export const values = [
          require('node:fs'),
          module.require('better-sqlite3'),
        ];
      `,
      'src/features/imported-loader/core/domain/safe.ts':
        'export const load = (specifier: string) => specifier;',
      'src/features/imported-loader/core/domain/safeModule.ts': `
        export default {
          require(specifier: string) {
            return specifier;
          },
        };
      `,
    },
    domainRule
  );

  assert.deepEqual(violations, []);
});

test('does not propagate default exports through export stars', () => {
  const violations = violationsFor(
    {
      'src/features/default-star-safe/main/index.ts': `export * from './barrel';`,
      'src/features/default-star-safe/main/barrel.ts': `
        export { default } from './infrastructure/Store';
      `,
      'src/features/default-star-safe/main/infrastructure/Store.ts':
        'export default class Store {}',
      'src/features/named-star-unsafe/main/index.ts': `export * from './barrel';`,
      'src/features/named-star-unsafe/main/barrel.ts': `
        export { Store } from './infrastructure/Store';
      `,
      'src/features/named-star-unsafe/main/infrastructure/Store.ts': 'export class Store {}',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source }) => source),
    ['src/features/named-star-unsafe/main/barrel.ts']
  );
});

test('lets explicit exports shadow same-named star exports', () => {
  const violations = violationsFor(
    {
      'src/features/explicit-shadow-safe/main/index.ts': `export * from './barrel';`,
      'src/features/explicit-shadow-safe/main/barrel.ts': `
        export * from './infrastructure/Store';
        export { Store } from './safe';
      `,
      'src/features/explicit-shadow-safe/main/infrastructure/Store.ts': 'export class Store {}',
      'src/features/explicit-shadow-safe/main/safe.ts': 'export const Store = "safe";',
      'src/features/unshadowed-star-unsafe/main/index.ts': `export * from './barrel';`,
      'src/features/unshadowed-star-unsafe/main/barrel.ts': `
        export * from './infrastructure/Store';
      `,
      'src/features/unshadowed-star-unsafe/main/infrastructure/Store.ts': 'export class Store {}',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source }) => source),
    ['src/features/unshadowed-star-unsafe/main/barrel.ts']
  );
});

test('keeps local and explicit export precedence namespace-aware', () => {
  const violations = violationsFor(
    {
      'src/features/local-type-shadow/main/index.ts': `export * from './barrel';`,
      'src/features/local-type-shadow/main/barrel.ts': `
        export * from './infrastructure/Store';
        export interface Store {}
      `,
      'src/features/local-type-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/explicit-type-shadow/main/index.ts': `export * from './barrel';`,
      'src/features/explicit-type-shadow/main/barrel.ts': `
        export * from './infrastructure/Store';
        export type { Store } from './safe';
      `,
      'src/features/explicit-type-shadow/main/infrastructure/Store.ts':
        'export class Store {}',
      'src/features/explicit-type-shadow/main/safe.ts': 'export interface Store {}',
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source }) => source).sort(),
    [
      'src/features/explicit-type-shadow/main/barrel.ts',
      'src/features/local-type-shadow/main/barrel.ts',
    ]
  );
});

test('omits ambiguous star collisions while preserving unique star exports', () => {
  const violations = violationsFor(
    {
      'src/features/ambiguous-star-safe/main/index.mjs': `export * from './barrel.mjs';`,
      'src/features/ambiguous-star-safe/main/barrel.mjs': `
        export * from './safe.mjs';
        export * from './infrastructure/Store.mjs';
      `,
      'src/features/ambiguous-star-safe/main/safe.mjs': 'export const Store = "safe";',
      'src/features/ambiguous-star-safe/main/infrastructure/Store.mjs': 'export class Store {}',
      'src/features/unique-star-unsafe/main/index.mjs': `export * from './barrel.mjs';`,
      'src/features/unique-star-unsafe/main/barrel.mjs': `
        export * from './safe.mjs';
        export * from './infrastructure/Store.mjs';
      `,
      'src/features/unique-star-unsafe/main/safe.mjs': 'export const Store = "safe";',
      'src/features/unique-star-unsafe/main/infrastructure/Store.mjs': `
        export class Store {}
        export class Leaked {}
      `,
    },
    publicApiRule
  );

  assert.deepEqual(
    violations.map(({ source }) => source),
    ['src/features/unique-star-unsafe/main/barrel.mjs']
  );
});
