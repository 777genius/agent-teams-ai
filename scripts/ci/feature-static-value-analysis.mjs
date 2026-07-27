import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-ast.mjs';

const UNKNOWN_STATIC_VALUE = Symbol('unknown-static-value');

function bindingNameContains(bindingName, name) {
  if (ts.isIdentifier(bindingName)) return bindingName.text === name;
  return bindingName.elements.some(
    (element) => ts.isBindingElement(element) && bindingNameContains(element.name, name)
  );
}

function directLexicalBindings(node) {
  const names = new Set();
  const statements =
    ts.isBlock(node) || ts.isSourceFile(node)
      ? node.statements
      : ts.isCaseBlock(node)
        ? node.clauses.flatMap((clause) => [...clause.statements])
        : [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      if (ts.isSourceFile(node) || statement.declarationList.flags & ts.NodeFlags.BlockScoped) {
        for (const declaration of statement.declarationList.declarations) {
          if (bindingNameContains(declaration.name, 'undefined')) names.add('undefined');
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function callableBindsName(callable, name) {
  return (
    callable.parameters.some((parameter) => bindingNameContains(parameter.name, name)) ||
    (callable.name && ts.isIdentifier(callable.name) && callable.name.text === name)
  );
}

function sourceFileImportsValue(sourceFile, name) {
  return sourceFile.statements.some((statement) => {
    if (ts.isImportEqualsDeclaration(statement)) {
      return !statement.isTypeOnly && statement.name.text === name;
    }
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return false;
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => !element.isTypeOnly && element.name.text === name)
    );
  });
}

function scopeHasVarBinding(scope, name) {
  let found = false;
  const visit = (node) => {
    if (found || (node !== scope && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some((declaration) => bindingNameContains(declaration.name, name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function loopInitializerBindsName(node, name) {
  const initializer =
    ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      ? node.initializer
      : null;
  return (
    initializer &&
    ts.isVariableDeclarationList(initializer) &&
    initializer.declarations.some((declaration) => bindingNameContains(declaration.name, name))
  );
}

function isUnshadowedUndefinedReference(reference) {
  const name = reference.text;
  const sourceFile = reference.getSourceFile();
  let current = reference.parent;
  while (current && current !== sourceFile) {
    if (
      (ts.isBlock(current) || ts.isCaseBlock(current)) &&
      directLexicalBindings(current).has(name)
    ) {
      return false;
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration &&
      bindingNameContains(current.variableDeclaration.name, name)
    ) {
      return false;
    }
    if (ts.isFunctionLike(current)) {
      if (callableBindsName(current, name) || scopeHasVarBinding(current, name)) return false;
    }
    if (ts.isClassExpression(current) && current.name?.text === name) return false;
    if (loopInitializerBindsName(current, name)) return false;
    current = current.parent;
  }
  return (
    !sourceFileImportsValue(sourceFile, name) &&
    !directLexicalBindings(sourceFile).has(name) &&
    !scopeHasVarBinding(sourceFile, name)
  );
}

function staticPrimitiveValue(expression) {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isIdentifier(current) &&
    current.text === 'undefined' &&
    isUnshadowedUndefinedReference(current)
  ) {
    return undefined;
  }
  if (ts.isVoidExpression(current)) return undefined;
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  if (ts.isBigIntLiteral(current)) return BigInt(current.text.slice(0, -1));
  if (ts.isPrefixUnaryExpression(current)) {
    if (current.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = staticTruthiness(current.operand);
      return operand === null ? UNKNOWN_STATIC_VALUE : !operand;
    }
    const operand = staticPrimitiveValue(current.operand);
    if (operand === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
    if (current.operator === ts.SyntaxKind.MinusToken) {
      return typeof operand === 'bigint' || typeof operand === 'number'
        ? -operand
        : UNKNOWN_STATIC_VALUE;
    }
    if (current.operator === ts.SyntaxKind.PlusToken && typeof operand === 'number') {
      return +operand;
    }
  }
  return UNKNOWN_STATIC_VALUE;
}

function definitelyDefinedExpression(expression) {
  const current = unwrapExpression(expression);
  return (
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isFunctionLike(current) ||
    ts.isClassLike(current) ||
    ts.isNewExpression(current)
  );
}

export function staticUndefinedness(expression) {
  const value = staticPrimitiveValue(expression);
  if (value !== UNKNOWN_STATIC_VALUE) return value === undefined;
  return definitelyDefinedExpression(expression) ? false : null;
}

export function staticTruthiness(expression) {
  const value = staticPrimitiveValue(expression);
  return value === UNKNOWN_STATIC_VALUE ? null : Boolean(value);
}

export function staticNullishness(expression) {
  const value = staticPrimitiveValue(expression);
  return value === UNKNOWN_STATIC_VALUE ? null : value === null || value === undefined;
}

export function staticStrictEquality(left, right) {
  const leftValue = staticPrimitiveValue(left);
  const rightValue = staticPrimitiveValue(right);
  return leftValue === UNKNOWN_STATIC_VALUE || rightValue === UNKNOWN_STATIC_VALUE
    ? null
    : leftValue === rightValue;
}

export function staticPropertyKey(name) {
  if (!name) return null;
  if (!ts.isComputedPropertyName(name)) return propertyNameText(name);
  const value = staticPrimitiveValue(name.expression);
  return value === UNKNOWN_STATIC_VALUE ? null : String(value);
}
