import ts from 'typescript';

import { unwrapExpression } from './feature-export-analysis.mjs';
import {
  isCommonJsRequireCall,
  isCommonJsRequireReference,
  isLexicallyShadowedValueReference,
} from './feature-lexical-binding-analysis.mjs';
import {
  reachingLocalValueWrites,
  resolvedLocalValueNodes,
} from './feature-constructor-local-value-analysis.mjs';
import { staticMemberAccess, staticStringValue } from './feature-static-value-analysis.mjs';

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

export function createCommonJsLoaderCallAnalysis(sourceFile) {
  const { factories, namespaces } = createRequireImports(sourceFile);
  const resolveStaticBinding = (identifier) =>
    resolvedLocalValueNodes(identifier, sourceFile, { captureOuter: true });
  const isNodeModuleSpecifier = (expression) => {
    const specifier = staticStringValue(expression, resolveStaticBinding);
    return specifier !== null && NODE_MODULE_SPECIFIERS.has(specifier);
  };
  const tracesLocalWrites = (reference, visited, resolve) => {
    if (!ts.isIdentifier(reference)) return [];
    return reachingLocalValueWrites(reference, sourceFile, { captureOuter: true }).flatMap(
      (write) => {
        if (!write.value || visited.has(write.key)) return [];
        return resolve(write, new Set(visited).add(write.key));
      }
    );
  };
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
    return tracesLocalWrites(reference, visited, (write, nextVisited) => [
      (write.selected.length === 0 || (write.selected.length === 1 && write.selected[0] === '*')) &&
        isNodeModuleNamespaceReference(write.value, nextVisited),
    ]).some(Boolean);
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
    const access = staticMemberAccess(reference, resolveStaticBinding);
    if (
      access?.name === 'createRequire' &&
      isNodeModuleNamespaceReference(access.receiver, visited)
    ) {
      return true;
    }
    return tracesLocalWrites(reference, visited, (write, nextVisited) => [
      (write.selected.length === 1 &&
        write.selected[0] === 'createRequire' &&
        isNodeModuleNamespaceReference(write.value, nextVisited)) ||
        isCreateRequireFactoryReference(write.value, nextVisited),
    ]).some(Boolean);
  };
  const arrayElementExpressions = (expression, index, visited = new Set()) => {
    const reference = expression && unwrapExpression(expression);
    if (!reference) return [];
    if (ts.isArrayLiteralExpression(reference)) {
      const element = reference.elements[index];
      if (!element || ts.isOmittedExpression(element)) return [];
      if (!ts.isSpreadElement(element)) return [element];
      return arrayElementExpressions(element.expression, index, visited);
    }
    return tracesLocalWrites(reference, visited, (write, nextVisited) =>
      write.selected.length === 0 ? arrayElementExpressions(write.value, index, nextVisited) : []
    );
  };
  const exactStaticExpression = (expressions) => {
    if (expressions.length === 0) return null;
    const values = expressions.map((expression) =>
      staticStringValue(expression, resolveStaticBinding)
    );
    if (values.some((value) => value === null) || new Set(values).size !== 1) return null;
    return expressions[0];
  };
  const loaderCallableDescriptors = (expression, visited = new Set()) => {
    const reference = expression && unwrapExpression(expression);
    if (!reference) return [];
    if (isCommonJsRequireReference(reference, sourceFile)) {
      return [{ boundArguments: [] }];
    }
    if (
      ts.isCallExpression(reference) &&
      reference.arguments.length >= 1 &&
      isCreateRequireFactoryReference(reference.expression)
    ) {
      return [{ boundArguments: [] }];
    }

    if (ts.isCallExpression(reference)) {
      const access = staticMemberAccess(reference.expression, resolveStaticBinding);
      if (access?.name === 'bind') {
        return loaderCallableDescriptors(access.receiver, visited).map((descriptor) => ({
          boundArguments: [...descriptor.boundArguments, ...reference.arguments.slice(1)],
        }));
      }
    }

    return tracesLocalWrites(reference, visited, (write, nextVisited) =>
      write.selected.length === 0 ? loaderCallableDescriptors(write.value, nextVisited) : []
    );
  };
  const describeCommonJsLoaderCall = (node) => {
    if (!ts.isCallExpression(node)) return null;
    const access = staticMemberAccess(node.expression, resolveStaticBinding);
    const isCallWrapper = access?.name === 'call';
    const isApplyWrapper = access?.name === 'apply';
    const callable = isCallWrapper || isApplyWrapper ? access.receiver : node.expression;
    const descriptors = loaderCallableDescriptors(callable);
    if (descriptors.length === 0) return null;

    const invocationArguments = isCallWrapper
      ? node.arguments.slice(1, 2)
      : isApplyWrapper
        ? arrayElementExpressions(node.arguments[1], 0)
        : node.arguments.slice(0, 1);
    const moduleSpecifiers = descriptors.flatMap(({ boundArguments }) =>
      boundArguments.length > 0 ? [boundArguments[0]] : invocationArguments
    );
    const moduleSpecifier = exactStaticExpression(moduleSpecifiers);
    return moduleSpecifier
      ? {
          moduleSpecifier,
          selectionReference: node,
        }
      : null;
  };

  return describeCommonJsLoaderCall;
}
