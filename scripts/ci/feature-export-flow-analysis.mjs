import ts from 'typescript';

function literalBoolean(statement) {
  const expression = statement.expression;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function isDefinitelyExecutedChild(statement, parent) {
  if (ts.isBlock(parent)) {
    if (ts.isTryStatement(parent.parent)) {
      return parent === parent.parent.tryBlock || parent === parent.parent.finallyBlock;
    }
    return true;
  }
  if (ts.isIfStatement(parent)) {
    const condition = literalBoolean(parent);
    return condition === true
      ? statement === parent.thenStatement
      : condition === false && statement === parent.elseStatement;
  }
  return false;
}

export function topLevelExpressionBoundary(node, sourceFile) {
  let expressionStatement = node;
  while (expressionStatement && !ts.isExpressionStatement(expressionStatement)) {
    if (ts.isFunctionLike(expressionStatement) || ts.isClassLike(expressionStatement)) {
      return null;
    }
    expressionStatement = expressionStatement.parent;
  }
  if (!expressionStatement) return null;

  let statement = expressionStatement;
  while (statement.parent !== sourceFile) {
    const parent = statement.parent;
    if (!parent || !isDefinitelyExecutedChild(statement, parent)) return null;
    statement = ts.isBlock(parent) && ts.isTryStatement(parent.parent)
      ? parent.parent
      : parent;
  }
  return expressionStatement;
}
