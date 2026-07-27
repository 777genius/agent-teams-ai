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
} from '../../scripts/ci/feature-executed-iife-analysis.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

const infrastructureSource = 'export class Store {}';

function fixtureFiles(cases) {
  return Object.fromEntries(
    Object.entries(cases).flatMap(([name, source]) => [
      [`src/features/${name}/main/index.ts`, source],
      [`src/features/${name}/main/infrastructure/Store.ts`, infrastructureSource],
    ])
  );
}

function implementationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function expectedSources(names) {
  return names.map((name) => `src/features/${name}/main/index.ts`).sort();
}

function assertImplementationCases(cases, dangerous) {
  withFeatureFixture(fixtureFiles(cases), (root) => {
    assert.deepEqual(implementationSources(root), expectedSources(dangerous));
  });
}

function controlFlowSource(flow) {
  return `
    import { Store } from './infrastructure/Store';
    const runtime = Math.random();
    export const api = { Store };
    (() => {
      ${flow}
      api.Store = undefined;
    })();
  `;
}

function iifeSource(body) {
  return `
    import { Store } from './infrastructure/Store';
    export const api = {};
    ${body}
  `;
}

test('models selected switch completion, fallthrough, defaults, and breaks', () => {
  const cases = {
    'switch-bigint-selected': controlFlowSource(`
      switch (-1n) {
        case -1n: return;
        default: break;
      }
    `),
    'switch-default-selected': controlFlowSource(`
      switch ('missing') {
        case 'other': break;
        default: return;
      }
    `),
    'switch-fallthrough-break': controlFlowSource(`
      switch (1) {
        case 1: api.ready = true;
        case 2: break;
        default: return;
      }
    `),
    'switch-fallthrough-return': controlFlowSource(`
      switch (1) {
        case 1: api.ready = true;
        case 2: return;
        default: break;
      }
    `),
    'switch-no-match-no-default': controlFlowSource(`
      switch (3) {
        case 1: return;
        case 2: throw new Error('stop');
      }
    `),
    'switch-known-after-unknown': controlFlowSource(`
      switch (1) {
        case runtime: return;
        case 1: return;
        default: break;
      }
    `),
    'switch-selected-break': controlFlowSource(`
      switch (1) {
        case 1: break;
        default: return;
      }
    `),
    'switch-selected-return': controlFlowSource(`
      switch (2) {
        case 1: break;
        case 2: return;
        default: break;
      }
    `),
    'switch-undefined-selected': controlFlowSource(`
      switch (undefined) {
        case void 0: return;
        default: break;
      }
    `),
  };

  assertImplementationCases(cases, [
    'switch-bigint-selected',
    'switch-default-selected',
    'switch-fallthrough-return',
    'switch-known-after-unknown',
    'switch-selected-return',
    'switch-undefined-selected',
  ]);
});

test('joins exhaustive runtime switch entries without inventing a default path', () => {
  const cases = {
    'switch-runtime-break-path': controlFlowSource(`
      switch (runtime) {
        case 0: return;
        default: break;
      }
    `),
    'switch-runtime-continue-or-return': controlFlowSource(`
      for (;;) {
        switch (runtime) {
          case 0: return;
          default: continue;
        }
      }
    `),
    'switch-runtime-exhaustive': controlFlowSource(`
      switch (runtime) {
        case 0: return;
        case 1: throw new Error('stop');
        default: return;
      }
    `),
    'switch-runtime-fallthrough-exhaustive': controlFlowSource(`
      switch (runtime) {
        case 0:
        case 1: return;
        default: throw new Error('stop');
      }
    `),
    'switch-runtime-no-default': controlFlowSource(`
      switch (runtime) {
        case 0: return;
        case 1: throw new Error('stop');
      }
    `),
  };

  assertImplementationCases(cases, [
    'switch-runtime-continue-or-return',
    'switch-runtime-exhaustive',
    'switch-runtime-fallthrough-exhaustive',
  ]);
});

test('distinguishes terminal static loops from runtime and break exits', () => {
  const cases = {
    'do-break-exit': controlFlowSource(`
      do {
        if (runtime) return;
        else break;
      } while (true);
    `),
    'do-return-or-continue': controlFlowSource(`
      do {
        if (runtime) return;
        else continue;
      } while (true);
    `),
    'do-return-once': controlFlowSource(`
      do { return; } while (false);
    `),
    'for-exhaustive-terminal': controlFlowSource(`
      for (;;) {
        if (runtime) return;
        else continue;
      }
    `),
    'for-return-terminal': controlFlowSource(`
      for (;;) { return; }
    `),
    'runtime-for-exit': controlFlowSource(`
      for (; runtime;) { return; }
    `),
    'runtime-while-exit': controlFlowSource(`
      while (runtime) { return; }
    `),
    'while-break-exit': controlFlowSource(`
      while (true) { break; }
    `),
    'while-continue-terminal': controlFlowSource(`
      while (true) { continue; }
    `),
    'while-false-exit': controlFlowSource(`
      while (false) { return; }
    `),
    'while-return-terminal': controlFlowSource(`
      while (true) { return; }
    `),
  };

  assertImplementationCases(cases, [
    'do-return-once',
    'do-return-or-continue',
    'for-exhaustive-terminal',
    'for-return-terminal',
    'while-continue-terminal',
    'while-return-terminal',
  ]);
});

test('lets finally completion override loop and switch control flow', () => {
  const cases = {
    'finally-break-overrides-return': controlFlowSource(`
      while (true) {
        try { return; }
        finally { break; }
      }
    `),
    'finally-continue-overrides-break': controlFlowSource(`
      while (true) {
        try { break; }
        finally { continue; }
      }
    `),
    'finally-return-overrides-break': controlFlowSource(`
      while (true) {
        try { break; }
        finally { return; }
      }
    `),
    'switch-finally-break': controlFlowSource(`
      switch (1) {
        case 1:
          try { return; }
          finally { break; }
        default: return;
      }
    `),
    'try-terminal-loop-finally-normal': controlFlowSource(`
      try {
        while (true) { return; }
      } finally {
        api.ready = true;
      }
    `),
  };

  assertImplementationCases(cases, [
    'finally-continue-overrides-break',
    'finally-return-overrides-break',
    'try-terminal-loop-finally-normal',
  ]);
});

test('activates direct IIFE defaults only for missing or static undefined arguments', () => {
  const cases = {
    'default-defined-safe': iifeSource(`
      ((value = Store) => { api.Store = value; })(class Safe {});
    `),
    'default-missing': iifeSource(`
      ((value = Store) => { api.Store = value; })();
    `),
    'default-null-safe': iifeSource(`
      ((value = Store) => { api.Store = value; })(null);
    `),
    'default-shadowed-undefined-safe': iifeSource(`
      const undefined = null;
      ((value = Store) => { api.Store = value; })(undefined);
    `),
    'default-undefined': iifeSource(`
      ((value = Store) => { api.Store = value; })(undefined);
    `),
    'default-unknown-safe': iifeSource(`
      declare const valueAtRuntime: unknown;
      ((value = Store) => { api.Store = value; })(valueAtRuntime);
    `),
    'default-void': iifeSource(`
      ((value = Store) => { api.Store = value; })(void 0);
    `),
    'target-default-missing': iifeSource(`
      ((target = api) => { target.Store = Store; })();
    `),
    'target-default-null-safe': iifeSource(`
      ((target = api) => { target.Store = Store; })(null);
    `),
    'target-default-undefined': iifeSource(`
      ((target = api) => { target.Store = Store; })(undefined);
    `),
    'target-default-void': iifeSource(`
      ((target = api) => { target.Store = Store; })(void 0);
    `),
  };

  assertImplementationCases(cases, [
    'default-missing',
    'default-undefined',
    'default-void',
    'target-default-missing',
    'target-default-undefined',
    'target-default-void',
  ]);
});

test('applies object and array IIFE binding defaults at exact missing selections', () => {
  const cases = {
    'array-default-defined-safe': iifeSource(`
      (([value = Store]) => { api.Store = value; })([null]);
    `),
    'array-default-missing': iifeSource(`
      (([value = Store]) => { api.Store = value; })([]);
    `),
    'array-default-undefined': iifeSource(`
      (([value = Store]) => { api.Store = value; })([undefined]);
    `),
    'object-default-defined-safe': iifeSource(`
      (({ value = Store }) => { api.Store = value; })({ value: null });
    `),
    'object-default-invalid-undefined-safe': iifeSource(`
      (({ value = Store }) => { api.Store = value; })(undefined);
    `),
    'object-default-missing': iifeSource(`
      (({ value = Store }) => { api.Store = value; })({});
    `),
    'object-default-nested-missing': iifeSource(`
      (({ config: { value = Store } = {} }) => { api.Store = value; })({});
    `),
    'object-default-nested-undefined': iifeSource(`
      (({ config: { value = Store } = {} }) => { api.Store = value; })({
        config: { value: undefined },
      });
    `),
    'object-default-outer-null-safe': iifeSource(`
      (({ value = Store } = { value: null }) => { api.Store = value; })();
    `),
    'object-default-outer-undefined': iifeSource(`
      (({ value = Store } = {}) => { api.Store = value; })(void 0);
    `),
    'object-default-shadowed-undefined-safe': iifeSource(`
      const undefined = null;
      (({ value = Store }) => { api.Store = value; })({ value: undefined });
    `),
    'object-default-undefined': iifeSource(`
      (({ value = Store }) => { api.Store = value; })({ value: undefined });
    `),
    'object-default-void': iifeSource(`
      (({ value = Store }) => { api.Store = value; })({ value: void 0 });
    `),
  };

  assertImplementationCases(cases, [
    'array-default-missing',
    'array-default-undefined',
    'object-default-missing',
    'object-default-nested-missing',
    'object-default-nested-undefined',
    'object-default-outer-undefined',
    'object-default-undefined',
    'object-default-void',
  ]);
});

test('coordinates undefined and void constants with logical IIFE assignment flow', () => {
  const cases = {
    'default-logical-and-kills': iifeSource(`
      ((value = Store) => {
        value &&= undefined;
        api.Store = value;
      })(undefined);
    `),
    'default-logical-nullish-retains': iifeSource(`
      ((value = Store) => {
        value ??= undefined;
        api.Store = value;
      })();
    `),
    'default-logical-or-retains': iifeSource(`
      ((value = Store) => {
        value ||= undefined;
        api.Store = value;
      })(void 0);
    `),
    'shadowed-undefined-or-retains': iifeSource(`
      const undefined = true;
      ((value) => {
        undefined || (value = undefined);
        api.Store = value;
      })(Store);
    `),
    'undefined-and-skips-kill': iifeSource(`
      ((value) => {
        undefined && (value = undefined);
        api.Store = value;
      })(Store);
    `),
    'undefined-or-kills': iifeSource(`
      ((value) => {
        undefined || (value = undefined);
        api.Store = value;
      })(Store);
    `),
    'void-nullish-kills': iifeSource(`
      ((value) => {
        void 0 ?? (value = undefined);
        api.Store = value;
      })(Store);
    `),
  };

  assertImplementationCases(cases, [
    'default-logical-nullish-retains',
    'default-logical-or-retains',
    'shadowed-undefined-or-retains',
    'undefined-and-skips-kill',
  ]);
});

function expressionFrom(source, statementIndex = 0) {
  const sourceFile = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements[statementIndex];
  assert.ok(statement && ts.isExpressionStatement(statement));
  return statement.expression;
}

function returnedExpressionFrom(source) {
  const sourceFile = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  let expression = null;
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression) expression = node.expression;
    if (!expression) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(expression);
  return expression;
}

test('classifies undefined, void, signed bigint, and lexical shadows statically', () => {
  const undefinedExpression = expressionFrom('undefined;');
  assert.equal(staticTruthiness(undefinedExpression), false);
  assert.equal(staticNullishness(undefinedExpression), true);

  const voidExpression = expressionFrom('void unknownCall();');
  assert.equal(staticTruthiness(voidExpression), false);
  assert.equal(staticNullishness(voidExpression), true);

  assert.equal(staticTruthiness(expressionFrom('-1n;')), true);
  assert.equal(staticNullishness(expressionFrom('-1n;')), false);
  assert.equal(staticTruthiness(expressionFrom('-0n;')), false);
  assert.equal(staticNullishness(expressionFrom('-0n;')), false);

  assert.equal(staticTruthiness(expressionFrom('runtimeValue;')), null);
  assert.equal(staticNullishness(expressionFrom('runtimeValue;')), null);

  const shadowed = expressionFrom('const undefined = false; undefined;', 1);
  assert.equal(staticTruthiness(shadowed), null);
  assert.equal(staticNullishness(shadowed), null);

  const parameterShadow = returnedExpressionFrom(`
    function probe(undefined) {
      return undefined;
    }
  `);
  assert.equal(staticTruthiness(parameterShadow), null);
  assert.equal(staticNullishness(parameterShadow), null);
});
