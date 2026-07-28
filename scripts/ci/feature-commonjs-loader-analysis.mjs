import ts from 'typescript';

import { memberAccess, unwrapExpression } from './feature-export-analysis.mjs';
import {
  isCommonJsRequireCall,
  isCommonJsRequireReference,
  isLexicallyShadowedValueReference,
} from './feature-lexical-binding-analysis.mjs';
import {
  reachingLocalValueWrites,
  resolvedLocalValueNodes,
} from './feature-constructor-local-value-analysis.mjs';
import { staticStringValue } from './feature-static-value-analysis.mjs';

const NODE_MODULE_SPECIFIERS = new Set(['module', 'node:module']);

function createRequireImports(sourceFile) {
  const factories = new Set();
  const namespaces = new Set();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      NODE_MODULE_SPECIFIERS.has(statement.moduleSpecifier.text) &&
      !statement.importClause?.isTypeOnly
    ) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) namespaces.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) === 'createRequire'
          ) {
            factories.add(element.name.text);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression) &&
      NODE_MODULE_SPECIFIERS.has(statement.moduleReference.expression.text)
    ) {
      namespaces.add(statement.name.text);
    }
  }

  return { factories, namespaces };
}

export function createCommonJsLoaderReference(sourceFile) {
  const { factories, namespaces } = createRequireImports(sourceFile);
  const resolveStaticBinding = (identifier) =>
    resolvedLocalValueNodes(identifier, sourceFile, { captureOuter: true });
  const isNodeModuleSpecifier = (expression) => {
    const specifier = staticStringValue(expression, resolveStaticBinding);
    return specifier !== null && NODE_MODULE_SPECIFIERS.has(specifier);
  };
  const tracesLocalWrite = (reference, visited, predicate, selectedName = null) =>
    ts.isIdentifier(reference) &&
    reachingLocalValueWrites(reference, sourceFile, { captureOuter: true }).some((write) => {
      if (!write.value || visited.has(write.key)) return false;
      const nextVisited = new Set(visited).add(write.key);
      return (
        (selectedName !== null &&
          write.selected.length === 1 &&
          write.selected[0] === selectedName &&
          isNodeModuleNamespaceReference(write.value, nextVisited)) ||
        predicate(write.value, nextVisited)
      );
    });
  const isNodeModuleNamespaceReference = (expression, visited = new Set()) => {
    const reference = expression && unwrapExpression(expression);
    if (!reference) return false;
    if (
      ts.isIdentifier(reference) &&
      namespaces.has(reference.text) &&
      !isLexicallyShadowedValueReference(reference, sourceFile)
    ) {
      return true;
    }
    if (ts.isAwaitExpression(reference)) {
      return isNodeModuleNamespaceReference(reference.expression, visited);
    }
    if (
      ts.isCallExpression(reference) &&
      reference.arguments.length >= 1 &&
      isNodeModuleSpecifier(reference.arguments[0]) &&
      (reference.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isCommonJsRequireCall(reference, sourceFile))
    ) {
      return true;
    }
    return tracesLocalWrite(
      reference,
      visited,
      isNodeModuleNamespaceReference
    );
  };
  const isCreateRequireFactoryReference = (expression, visited = new Set()) => {
    const reference = expression && unwrapExpression(expression);
    if (!reference) return false;
    if (
      ts.isIdentifier(reference) &&
      factories.has(reference.text) &&
      !isLexicallyShadowedValueReference(reference, sourceFile)
    ) {
      return true;
    }
    const access = memberAccess(reference);
    if (
      access?.name === 'createRequire' &&
      isNodeModuleNamespaceReference(access.receiver, visited)
    ) {
      return true;
    }
    return tracesLocalWrite(
      reference,
      visited,
      isCreateRequireFactoryReference,
      'createRequire'
    );
  };
  const isCommonJsLoaderReference = (expression, visited = new Set()) => {
    const reference = expression && unwrapExpression(expression);
    if (!reference) return false;
    if (isCommonJsRequireReference(reference, sourceFile)) return true;
    if (
      ts.isCallExpression(reference) &&
      reference.arguments.length >= 1 &&
      isCreateRequireFactoryReference(reference.expression)
    ) {
      return true;
    }
    return tracesLocalWrite(reference, visited, isCommonJsLoaderReference);
  };

  return isCommonJsLoaderReference;
}
