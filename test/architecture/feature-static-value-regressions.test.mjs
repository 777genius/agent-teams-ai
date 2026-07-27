import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import {
  staticNullishness,
  staticTruthiness,
} from '../../scripts/ci/feature-static-value-analysis.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

const infrastructureSource = 'export class Store {}';

function iifeSource(body) {
  return `
    import { Store } from './infrastructure/Store';
    export const api = {};
    ${body}
  `;
}

function implementationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function expressionFrom(source, statementIndex = 0) {
  const sourceFile = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements[statementIndex];
  assert.ok(statement && ts.isExpressionStatement(statement));
  return statement.expression;
}

test('activates IIFE defaults for explicit global and terminal sequence undefined values', () => {
  const cases = {
    'global-this-undefined': iifeSource(`
      ((value = Store) => { api.Store = value; })(globalThis.undefined);
    `),
    'sequence-terminal-undefined': iifeSource(`
      ((value = Store) => { api.Store = value; })((0, undefined));
    `),
    'shadowed-global-this-safe': iifeSource(`
      const globalThis = { undefined: null };
      ((value = Store) => { api.Store = value; })(globalThis.undefined);
    `),
    'sequence-nonterminal-undefined-safe': iifeSource(`
      ((value = Store) => { api.Store = value; })((undefined, 1));
    `),
    'sequence-runtime-terminal-safe': iifeSource(`
      declare const valueAtRuntime: unknown;
      ((value = Store) => { api.Store = value; })((0, valueAtRuntime));
    `),
  };
  const files = Object.fromEntries(
    Object.entries(cases).flatMap(([name, source]) => [
      [`src/features/${name}/main/index.ts`, source],
      [`src/features/${name}/main/infrastructure/Store.ts`, infrastructureSource],
    ])
  );

  withFeatureFixture(files, (root) => {
    assert.deepEqual(implementationSources(root), [
      'src/features/global-this-undefined/main/index.ts',
      'src/features/sequence-terminal-undefined/main/index.ts',
    ]);
  });
});

test('classifies global and sequence undefined forms without widening runtime values', () => {
  const globalThisUndefined = expressionFrom('globalThis.undefined;');
  assert.equal(staticTruthiness(globalThisUndefined), false);
  assert.equal(staticNullishness(globalThisUndefined), true);

  const sequenceUndefined = expressionFrom('(0, undefined);');
  assert.equal(staticTruthiness(sequenceUndefined), false);
  assert.equal(staticNullishness(sequenceUndefined), true);

  const nonterminalUndefined = expressionFrom('(undefined, 1);');
  assert.equal(staticTruthiness(nonterminalUndefined), true);
  assert.equal(staticNullishness(nonterminalUndefined), false);

  const runtimeTerminal = expressionFrom('(undefined, runtimeValue);');
  assert.equal(staticTruthiness(runtimeTerminal), null);
  assert.equal(staticNullishness(runtimeTerminal), null);

  const shadowedGlobalThis = expressionFrom(
    'const globalThis = { undefined: 1 }; globalThis.undefined;',
    1
  );
  assert.equal(staticTruthiness(shadowedGlobalThis), null);
  assert.equal(staticNullishness(shadowedGlobalThis), null);
});
