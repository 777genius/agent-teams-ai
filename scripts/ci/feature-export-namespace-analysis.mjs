import ts from 'typescript';

import { statementBindingNames } from './feature-export-analysis.mjs';

function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
  );
}

function supportsNamespace(statement, namespace) {
  if (namespace === 'value') {
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return false;
    return (
      ts.isVariableStatement(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    );
  }
  return (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  );
}

export function declarationNamesForNamespace(statement, namespace) {
  return supportsNamespace(statement, namespace) ? statementBindingNames(statement) : [];
}

export function directExportNamesForNamespace(statement, namespace) {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (!supportsNamespace(statement, namespace)) return [];
  return hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ? ['default']
    : statementBindingNames(statement);
}

export function directReexportsForDeclaration(node, edge) {
  if (!edge) return [];
  if (!node.exportClause) {
    return [
      {
        ...edge,
        exportedName: '*',
        importedName: '*',
        isExportStar: true,
      },
    ];
  }
  if (ts.isNamespaceExport(node.exportClause)) {
    return [
      {
        ...edge,
        exportedName: node.exportClause.name.text,
        importedName: '*',
      },
    ];
  }
  return node.exportClause.elements.map((element) => ({
    ...edge,
    exportedName: element.name.text,
    importedName: element.propertyName?.text ?? element.name.text,
    isTypeOnly: edge.isTypeOnly || element.isTypeOnly,
  }));
}

export function importSelectionsForClause(importClause) {
  if (!importClause) return { importedNames: ['*'], typeOnlyImportedNames: [] };
  const importedNames = [];
  const typeOnlyImportedNames = [];
  const add = (name, isTypeOnly) => {
    importedNames.push(name);
    if (isTypeOnly) typeOnlyImportedNames.push(name);
  };
  if (importClause.name) add('default', importClause.isTypeOnly);
  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    add('*', importClause.isTypeOnly);
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      add(
        element.propertyName?.text ?? element.name.text,
        importClause.isTypeOnly || element.isTypeOnly
      );
    }
  }
  return { importedNames, typeOnlyImportedNames };
}
