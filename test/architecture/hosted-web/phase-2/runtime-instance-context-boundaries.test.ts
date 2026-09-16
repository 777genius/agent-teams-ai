import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTRACT_PATH = 'src/features/runtime-instance-context/contracts/runtime-instance-context.ts';
const DOMAIN_PATH = 'src/features/runtime-instance-context/core/domain/RuntimeInstanceContext.ts';
const FORBIDDEN_MODULE =
  /^(?:(?:node:)?(?:fs(?:\/promises)?|path|process|child_process)|electron|fastify|react|zustand|@main(?:\/|$)|@renderer(?:\/|$)|@preload(?:\/|$))/;
const FORBIDDEN_RESPONSIBILITY =
  /\b(?:authorize\w*|launch\w*|spawn\w*|orchestrat\w*|provider\w*|serviceLocator)\b/i;

type BoundaryDiagnostic =
  | 'forbidden-runtime-import'
  | 'mutable-exported-state'
  | 'forbidden-runtime-responsibility';

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind) === true
  );
}

function moduleName(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) ? node.text : null;
}

function isMutableInitializer(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isNewExpression(node)
  );
}

function scanBoundary(path: string, source: string): readonly BoundaryDiagnostic[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const diagnostics = new Set<BoundaryDiagnostic>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const name = moduleName(node.moduleSpecifier);
      if (name && FORBIDDEN_MODULE.test(name)) diagnostics.add('forbidden-runtime-import');
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const name = node.arguments[0] ? moduleName(node.arguments[0]) : null;
      if (name && FORBIDDEN_MODULE.test(name)) diagnostics.add('forbidden-runtime-import');
    }
    if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (
        !isConst ||
        node.declarationList.declarations.some((declaration) =>
          isMutableInitializer(declaration.initializer)
        )
      ) {
        diagnostics.add('mutable-exported-state');
      }
    }
    if (ts.isExportAssignment(node) && isMutableInitializer(node.expression)) {
      diagnostics.add('mutable-exported-state');
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (FORBIDDEN_RESPONSIBILITY.test(source)) {
    diagnostics.add('forbidden-runtime-responsibility');
  }
  return [...diagnostics].sort();
}

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('RuntimeInstanceContext boundaries', () => {
  it('keeps the contract and domain browser-safe, transport-neutral, and state-free', () => {
    expect(scanBoundary(CONTRACT_PATH, source(CONTRACT_PATH))).toEqual([]);
    expect(scanBoundary(DOMAIN_PATH, source(DOMAIN_PATH))).toEqual([]);
  });

  it.each(['node:fs', 'node:path', 'node:process', 'child_process', 'electron', '@main/config'])(
    'rejects the forbidden core import %s',
    (specifier) => {
      expect(
        scanBoundary(
          DOMAIN_PATH,
          `import value from '${specifier}';\nexport function fixture() { return value; }`
        )
      ).toContain('forbidden-runtime-import');
    }
  );

  it('rejects mutable exported state and service-locator responsibilities', () => {
    expect(scanBoundary(DOMAIN_PATH, 'export let currentRoot = "root-ref:fixture";')).toContain(
      'mutable-exported-state'
    );
    expect(
      scanBoundary(DOMAIN_PATH, 'export const roots = { current: "root-ref:fixture" };')
    ).toContain('mutable-exported-state');
    expect(scanBoundary(DOMAIN_PATH, 'export function launchProvider() {}')).toContain(
      'forbidden-runtime-responsibility'
    );
  });

  it('permits only the shared value kernel and feature-local contract dependency', () => {
    const domainSource = source(DOMAIN_PATH);
    const sourceFile = ts.createSourceFile(DOMAIN_PATH, domainSource, ts.ScriptTarget.Latest, true);
    const imports = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => moduleName(statement.moduleSpecifier));

    expect(imports).toEqual([
      '@shared/contracts/hosted',
      '../../contracts/runtime-instance-context',
    ]);
  });
});
