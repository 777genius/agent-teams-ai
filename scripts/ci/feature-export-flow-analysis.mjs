import ts from 'typescript';

import {
  immediateIifeInvocation,
  staticNullishness,
  staticTruthiness,
} from './feature-executed-iife-analysis.mjs';

function isDefinitelyExecutedChild(statement, parent) {
  if (ts.isBlock(parent)) {
    if (ts.isTryStatement(parent.parent)) {
      return parent === parent.parent.tryBlock || parent === parent.parent.finallyBlock;
    }
    return true;
  }
  if (ts.isIfStatement(parent)) {
    const condition = staticTruthiness(parent.expression);
    return condition === true
      ? statement === parent.thenStatement
      : condition === false && statement === parent.elseStatement;
  }
  if (ts.isDoStatement(parent)) return statement === parent.statement;
  return false;
}

export function immediateInvocation(node) {
  return immediateIifeInvocation(node);
}

function isStaticallyDeadExpression(node) {
  let current = node;
  while (current.parent && !ts.isExpressionStatement(current.parent)) {
    const parent = current.parent;
    if (ts.isConditionalExpression(parent)) {
      const condition = staticTruthiness(parent.condition);
      if (
        (condition === true && current === parent.whenFalse) ||
        (condition === false && current === parent.whenTrue)
      ) {
        return true;
      }
    } else if (ts.isBinaryExpression(parent) && current === parent.right) {
      const left = staticTruthiness(parent.left);
      if (
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          left === false) ||
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) ||
        (
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          staticNullishness(parent.left) === false
        )
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

export function topLevelExpressionBoundary(node, sourceFile) {
  let expressionStatement = node;
  while (expressionStatement && !ts.isExpressionStatement(expressionStatement)) {
    if (ts.isFunctionLike(expressionStatement)) {
      const invocation = immediateInvocation(expressionStatement);
      const body = expressionStatement.body;
      return invocation &&
        !isStaticallyDeadExpression(invocation) &&
        body &&
        !ts.isBlock(body) &&
        topLevelExpressionBoundary(invocation, sourceFile)
        ? body
        : null;
    }
    if (ts.isClassLike(expressionStatement)) {
      return null;
    }
    expressionStatement = expressionStatement.parent;
  }
  if (!expressionStatement) return null;

  let statement = expressionStatement;
  while (statement.parent !== sourceFile) {
    const parent = statement.parent;
    if (parent && ts.isFunctionLike(parent)) {
      const invocation = immediateInvocation(parent);
      return invocation &&
        !isStaticallyDeadExpression(invocation) &&
        topLevelExpressionBoundary(invocation, sourceFile)
        ? expressionStatement
        : null;
    }
    if (!parent || !isDefinitelyExecutedChild(statement, parent)) return null;
    statement = ts.isBlock(parent) && ts.isTryStatement(parent.parent)
      ? parent.parent
      : parent;
  }
  return expressionStatement;
}
