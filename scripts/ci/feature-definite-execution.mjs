import ts from 'typescript';

import {
  executedIifeForCall,
  staticNullishness,
  staticTruthiness,
} from './feature-executed-iife-analysis.mjs';

function visitDefiniteExpression(node, visitor) {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
  visitor(node);
  if (ts.isConditionalExpression(node)) {
    visitDefiniteExpression(node.condition, visitor);
    const truthiness = staticTruthiness(node.condition);
    if (truthiness === true) visitDefiniteExpression(node.whenTrue, visitor);
    if (truthiness === false) visitDefiniteExpression(node.whenFalse, visitor);
    return;
  }
  if (ts.isCallExpression(node) && (node.questionDotToken || node.expression.questionDotToken)) {
    visitDefiniteExpression(node.expression, visitor);
    return;
  }
  if (ts.isElementAccessExpression(node) && node.questionDotToken) {
    visitDefiniteExpression(node.expression, visitor);
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)
  ) {
    visitDefiniteExpression(node.left, visitor);
    const truthiness = staticTruthiness(node.left);
    const rightIsDefinite =
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && truthiness === true) ||
      (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && truthiness === false) ||
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        staticNullishness(node.left) === true);
    if (rightIsDefinite) visitDefiniteExpression(node.right, visitor);
    return;
  }
  if (ts.isCallExpression(node)) {
    const invocation = executedIifeForCall(node);
    if (invocation) {
      visitDefiniteExpression(node.expression, visitor);
      for (const argument of node.arguments) {
        visitDefiniteExpression(argument, visitor);
      }
      if (ts.isBlock(invocation.callable.body)) {
        visitDefiniteStatement(invocation.callable.body, visitor);
      } else {
        visitDefiniteExpression(invocation.callable.body, visitor);
      }
      return;
    }
  }
  ts.forEachChild(node, (child) => visitDefiniteExpression(child, visitor));
}

function visitDefiniteStatement(statement, visitor) {
  if (ts.isExpressionStatement(statement)) {
    visitDefiniteExpression(statement.expression, visitor);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer) {
        visitDefiniteExpression(declaration.initializer, visitor);
      }
    }
  } else if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    if (statement.expression) visitDefiniteExpression(statement.expression, visitor);
    return ts.isReturnStatement(statement) ? 'return' : 'throw';
  } else if (ts.isBlock(statement)) {
    for (const child of statement.statements) {
      const termination = visitDefiniteStatement(child, visitor);
      if (termination) return termination;
    }
  } else if (ts.isIfStatement(statement)) {
    visitDefiniteExpression(statement.expression, visitor);
    const truthiness = staticTruthiness(statement.expression);
    if (truthiness === true) {
      return visitDefiniteStatement(statement.thenStatement, visitor);
    }
    if (truthiness === false && statement.elseStatement) {
      return visitDefiniteStatement(statement.elseStatement, visitor);
    }
  } else if (ts.isDoStatement(statement)) {
    const terminates = visitDefiniteStatement(statement.statement, visitor);
    if (!terminates) visitDefiniteExpression(statement.expression, visitor);
    return terminates;
  } else if (ts.isTryStatement(statement)) {
    const tryTerminates = visitDefiniteStatement(statement.tryBlock, visitor);
    const completion =
      tryTerminates === 'throw' && statement.catchClause
        ? visitDefiniteStatement(statement.catchClause.block, visitor)
        : tryTerminates;
    const finallyTerminates = statement.finallyBlock
      ? visitDefiniteStatement(statement.finallyBlock, visitor)
      : null;
    return finallyTerminates ?? completion;
  }
  return null;
}

export function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  for (const statement of sourceFile.statements) {
    visitDefiniteStatement(statement, visitor);
  }
}
