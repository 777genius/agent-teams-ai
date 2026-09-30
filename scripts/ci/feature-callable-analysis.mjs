import ts from 'typescript';

import { unwrapExpression } from './feature-export-ast.mjs';

export function callableTarget(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    current = unwrapExpression(current.right);
  }
  if (ts.isArrowFunction(current)) return current;
  return ts.isFunctionExpression(current) && !current.asteriskToken ? current : null;
}

export function callMethod(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return {
      name: current.name.text,
      receiver: current.expression,
    };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    ts.isStringLiteralLike(unwrapExpression(current.argumentExpression))
  ) {
    return {
      name: unwrapExpression(current.argumentExpression).text,
      receiver: current.expression,
    };
  }
  return null;
}
