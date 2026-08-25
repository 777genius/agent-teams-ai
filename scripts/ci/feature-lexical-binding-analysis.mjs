import ts from 'typescript';

import { bindingNames, statementBindingNames } from './feature-export-ast.mjs';
import { staticMemberAccess } from './feature-static-value-analysis.mjs';

function statementDeclaresValue(statement, name) {
  if (ts.isVariableStatement(statement)) {
    return statementBindingNames(statement).includes(name);
  }
  const runtimeDeclaration =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return (
    runtimeDeclaration &&
    statement.name &&
    ts.isIdentifier(statement.name) &&
    statement.name.text === name
  );
}

function blockDeclaresValue(block, name) {
  const statements = ts.isCaseBlock(block)
    ? block.clauses.flatMap((clause) => clause.statements)
    : block.statements;
  return statements.some((statement) => statementDeclaresValue(statement, name));
}

function functionDeclaresValue(functionLike, name) {
  if (
    (ts.isFunctionDeclaration(functionLike) || ts.isFunctionExpression(functionLike)) &&
    functionLike.name?.text === name
  ) {
    return true;
  }
  if (functionLike.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) {
    return true;
  }

  let found = false;
  const visit = (node) => {
    if (found || (node !== functionLike && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (functionLike.body) visit(functionLike.body);
  return found;
}

function loopInitializerDeclaresValue(node, name) {
  if (
    (ts.isForStatement(node) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)) ||
    ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      ts.isVariableDeclarationList(node.initializer))
  ) {
    return node.initializer.declarations.some((declaration) =>
      bindingNames(declaration.name).includes(name)
    );
  }
  return false;
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

export function isLexicallyShadowedValueReference(reference, sourceFile) {
  const name = reference.text;
  let current = reference.parent;
  while (current && current !== sourceFile) {
    if ((ts.isBlock(current) || ts.isCaseBlock(current)) && blockDeclaresValue(current, name)) {
      return true;
    }
    if (ts.isCatchClause(current) && current.variableDeclaration) {
      if (bindingNames(current.variableDeclaration.name).includes(name)) return true;
    }
    if (ts.isFunctionLike(current) && functionDeclaresValue(current, name)) return true;
    if (ts.isClassExpression(current) && current.name?.text === name) return true;
    if (loopInitializerDeclaresValue(current, name)) return true;
    current = current.parent;
  }

  return blockDeclaresValue(sourceFile, name);
}

export function isUnshadowedGlobalValueReference(reference) {
  const sourceFile = reference.getSourceFile();
  return (
    !sourceFileImportsValue(sourceFile, reference.text) &&
    !isLexicallyShadowedValueReference(reference, sourceFile)
  );
}

export function isCommonJsRequireReference(reference, sourceFile) {
  if (ts.isIdentifier(reference) && reference.text === 'require') {
    return (
      !sourceFileImportsValue(sourceFile, reference.text) &&
      !isLexicallyShadowedValueReference(reference, sourceFile)
    );
  }
  const access = staticMemberAccess(reference);
  return (
    access?.name === 'require' &&
    ts.isIdentifier(access.receiver) &&
    access.receiver.text === 'module' &&
    !sourceFileImportsValue(sourceFile, access.receiver.text) &&
    !isLexicallyShadowedValueReference(access.receiver, sourceFile)
  );
}

export function isCommonJsRequireCall(node, sourceFile) {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length >= 1 &&
    isCommonJsRequireReference(node.expression, sourceFile)
  );
}
