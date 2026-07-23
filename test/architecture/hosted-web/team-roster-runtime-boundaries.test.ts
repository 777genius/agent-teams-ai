import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW_PLAN_CREATOR = 'createCompositeRuntimePlan';
const RAW_PLAN_CREATOR_ALLOWLIST = new Set([
  'src/features/team-runtime-control/core/application/planning/CreateRuntimePlanFromPersistedRoster.ts',
  'src/features/team-runtime-control/core/application/planning/createCompositeRuntimePlan.ts',
]);
const ROSTER_CORE_PATHS = [
  'src/features/team-lifecycle/core/application/AdoptTeamRoster.ts',
  'src/features/team-lifecycle/core/application/ports/TeamRosterPorts.ts',
  'src/features/team-lifecycle/core/domain/TeamRoster.ts',
  'src/features/team-lifecycle/core/domain/adoptLegacyTeamRoster.ts',
  'src/features/team-runtime-control/core/application/planning/CreateRuntimePlanFromPersistedRoster.ts',
  'src/features/team-runtime-control/core/application/ports/PersistedTeamRosterPlanSource.ts',
] as const;
const CORE_FORBIDDEN_DEPENDENCY =
  /^(?:electron|fastify|@main(?:\/|$)|@renderer(?:\/|$)|@preload(?:\/|$)|@features\/internal-storage\/main(?:\/|$)|node:(?:crypto|fs|path|child_process)(?:\/|$))/;
const ROSTER_REPOSITORY_FORBIDDEN_DEPENDENCY =
  /(?:^|\/)(?:Json[^/]*|json[^/]*|worker)(?:\/|$)|^@main(?:\/|$)|^node:fs(?:\/|$)/i;
const HOSTED_RUNTIME_ENABLEMENT_DEPENDENCY =
  /(?:^|\/)team-runtime-control(?:\/|$)|(?:^|\/)(?:ExecutionBackendRegistry|ProcessSupervisorPort)(?:\.[cm]?[jt]sx?)?$/;
const HOSTED_RUNTIME_ENABLEMENT_SYMBOLS = new Set([
  'CreateRuntimePlanFromPersistedRoster',
  'ExecutionBackendRegistry',
  'ProcessSupervisorPort',
  'createCompositeRuntimePlan',
]);

interface DependencyDiagnostic {
  readonly kind: 'forbidden-dependency' | 'raw-plan-bypass';
  readonly path: string;
  readonly value: string;
}

function source(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function normalizedRelative(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(absolutePath));
    } else if (
      (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') &&
      !entry.name.includes('.test.')
    ) {
      files.push(normalizedRelative(absolutePath));
    }
  }
  return files.sort();
}

function moduleName(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function sourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function collectModuleDependencies(path: string, text: string): ReadonlySet<string> {
  const dependencies = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const name = node.moduleSpecifier ? moduleName(node.moduleSpecifier) : null;
      if (name) dependencies.add(name);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const name = node.arguments[0] ? moduleName(node.arguments[0]) : null;
      if (name) dependencies.add(name);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const name = moduleName(node.moduleReference.expression);
      if (name) dependencies.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path, text));
  return dependencies;
}

function collectImportedSymbols(path: string, text: string): ReadonlySet<string> {
  const symbols = new Set<string>();
  for (const statement of sourceFile(path, text).statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      symbols.add(element.propertyName?.text ?? element.name.text);
    }
  }
  return symbols;
}

function moduleMayExposeRawPlanCreator(specifier: string): boolean {
  return (
    specifier.includes('team-runtime-control') ||
    /(?:^|\/)createCompositeRuntimePlan$/.test(specifier)
  );
}

function loadedModuleName(node: ts.Expression): string | null {
  const expression = ts.isAwaitExpression(node) ? node.expression : node;
  if (
    !ts.isCallExpression(expression) ||
    (expression.expression.kind !== ts.SyntaxKind.ImportKeyword &&
      !(ts.isIdentifier(expression.expression) && expression.expression.text === 'require'))
  ) {
    return null;
  }
  return expression.arguments[0] ? moduleName(expression.arguments[0]) : null;
}

function scanRawPlanBypass(path: string, text: string): DependencyDiagnostic[] {
  if (RAW_PLAN_CREATOR_ALLOWLIST.has(path)) return [];
  const diagnostics: DependencyDiagnostic[] = [];
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  const parsed = sourceFile(path, text);

  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleName(statement.moduleSpecifier);
    if (!specifier || !moduleMayExposeRawPlanCreator(specifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      diagnostics.push({ kind: 'raw-plan-bypass', path, value: specifier });
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === RAW_PLAN_CREATOR) {
          aliases.add(element.name.text);
          diagnostics.push({ kind: 'raw-plan-bypass', path, value: specifier });
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const specifier = loadedModuleName(node.initializer);
      if (specifier && moduleMayExposeRawPlanCreator(specifier)) {
        if (ts.isIdentifier(node.name)) {
          namespaces.add(node.name.text);
          diagnostics.push({ kind: 'raw-plan-bypass', path, value: specifier });
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const importedName =
              element.propertyName?.getText(parsed) ?? element.name.getText(parsed);
            if (importedName === RAW_PLAN_CREATOR && ts.isIdentifier(element.name)) {
              aliases.add(element.name.text);
              diagnostics.push({ kind: 'raw-plan-bypass', path, value: specifier });
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
        diagnostics.push({ kind: 'raw-plan-bypass', path, value: node.expression.text });
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === RAW_PLAN_CREATOR &&
        ts.isIdentifier(node.expression.expression) &&
        namespaces.has(node.expression.expression.text)
      ) {
        diagnostics.push({
          kind: 'raw-plan-bypass',
          path,
          value: node.expression.getText(parsed),
        });
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === RAW_PLAN_CREATOR
      ) {
        const specifier = loadedModuleName(node.expression.expression);
        if (specifier && moduleMayExposeRawPlanCreator(specifier)) {
          diagnostics.push({ kind: 'raw-plan-bypass', path, value: specifier });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return diagnostics;
}

function scanForbiddenDependencies(
  path: string,
  text: string,
  forbidden: RegExp
): DependencyDiagnostic[] {
  return [...collectModuleDependencies(path, text)]
    .filter((dependency) => forbidden.test(dependency))
    .map((value) => ({ kind: 'forbidden-dependency' as const, path, value }));
}

describe('TeamRoster runtime architecture boundary', () => {
  it('allows raw composite plan construction only behind the persisted-roster boundary', () => {
    const offenders = productionTypeScriptFiles(resolve(ROOT, 'src')).flatMap((path) => {
      const text = source(path);
      if (!text.includes(RAW_PLAN_CREATOR) && !text.includes('team-runtime-control')) return [];
      return scanRawPlanBypass(path, text);
    });
    expect(offenders).toEqual([]);
  });

  it('detects aliased and namespace-import raw-plan bypasses', () => {
    expect(
      scanRawPlanBypass(
        'src/fixture.ts',
        `import { createCompositeRuntimePlan as bypass } from '@features/team-runtime-control';
         bypass({});`
      )
    ).not.toEqual([]);
    expect(
      scanRawPlanBypass(
        'src/fixture.ts',
        `import * as runtimeControl from '@features/team-runtime-control';
         runtimeControl.createCompositeRuntimePlan({});`
      )
    ).not.toEqual([]);
    expect(
      scanRawPlanBypass(
        'src/fixture.ts',
        `const { createCompositeRuntimePlan: bypass } = require('@features/team-runtime-control');
         bypass({});`
      )
    ).not.toEqual([]);
  });

  it('keeps roster core free of persistence, filesystem, transport, and process dependencies', () => {
    const offenders = ROSTER_CORE_PATHS.flatMap((path) =>
      scanForbiddenDependencies(path, source(path), CORE_FORBIDDEN_DEPENDENCY)
    );
    expect(offenders).toEqual([]);
  });

  it('keeps audited Node hashing in the main composition adapter', () => {
    const compositionPath =
      'src/features/team-lifecycle/main/composition/createTeamRosterAdoptionFeature.ts';
    expect([...collectModuleDependencies(compositionPath, source(compositionPath))]).toContain(
      'node:crypto'
    );
    expect([...collectImportedSymbols(compositionPath, source(compositionPath))]).toContain(
      'createHash'
    );
  });

  it('keeps the roster repository on its SQLite gateway contract with no JSON fallback dependency', () => {
    const repositoryPath =
      'src/features/team-lifecycle/main/infrastructure/InternalStorageTeamRosterRepository.ts';
    expect(
      scanForbiddenDependencies(
        repositoryPath,
        source(repositoryPath),
        ROSTER_REPOSITORY_FORBIDDEN_DEPENDENCY
      )
    ).toEqual([]);
    expect(
      scanForbiddenDependencies(
        repositoryPath,
        `import { JsonRosterStore } from '@main/services/JsonRosterStore';`,
        ROSTER_REPOSITORY_FORBIDDEN_DEPENDENCY
      )
    ).not.toEqual([]);
  });

  it('does not enable hosted runtime planning, execution backends, or process launch', () => {
    const hostedPaths = productionTypeScriptFiles(resolve(ROOT, 'src/main/composition/hosted'));
    const dependencyOffenders = hostedPaths.flatMap((path) =>
      scanForbiddenDependencies(path, source(path), HOSTED_RUNTIME_ENABLEMENT_DEPENDENCY)
    );
    const symbolOffenders = hostedPaths.flatMap((path) =>
      [...collectImportedSymbols(path, source(path))]
        .filter((symbol) => HOSTED_RUNTIME_ENABLEMENT_SYMBOLS.has(symbol))
        .map((value) => ({ kind: 'forbidden-dependency' as const, path, value }))
    );
    expect([...dependencyOffenders, ...symbolOffenders]).toEqual([]);
  });
});
