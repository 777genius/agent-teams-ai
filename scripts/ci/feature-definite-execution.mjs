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

const COMPLETION_NORMAL = 1 << 0;
const COMPLETION_RETURN = 1 << 1;
const COMPLETION_THROW = 1 << 2;
const COMPLETION_ABRUPT = COMPLETION_RETURN | COMPLETION_THROW;

function statementCompletion(statement) {
  if (ts.isReturnStatement(statement)) return COMPLETION_RETURN;
  if (ts.isThrowStatement(statement)) return COMPLETION_THROW;
  if (ts.isBlock(statement)) {
    let completion = COMPLETION_NORMAL;
    for (const child of statement.statements) {
      if ((completion & COMPLETION_NORMAL) === 0) break;
      completion = (completion & COMPLETION_ABRUPT) | statementCompletion(child);
    }
    return completion;
  }
  if (ts.isIfStatement(statement)) {
    const truthiness = staticTruthiness(statement.expression);
    if (truthiness === true) return statementCompletion(statement.thenStatement);
    if (truthiness === false) {
      return statement.elseStatement
        ? statementCompletion(statement.elseStatement)
        : COMPLETION_NORMAL;
    }
    return (
      statementCompletion(statement.thenStatement) |
      (statement.elseStatement ? statementCompletion(statement.elseStatement) : COMPLETION_NORMAL)
    );
  }
  if (ts.isDoStatement(statement)) return statementCompletion(statement.statement);
  if (ts.isTryStatement(statement)) {
    let completion = statementCompletion(statement.tryBlock);
    if (statement.catchClause && (completion & COMPLETION_THROW) !== 0) {
      completion =
        (completion & ~COMPLETION_THROW) | statementCompletion(statement.catchClause.block);
    }
    if (statement.finallyBlock) {
      const finallyCompletion = statementCompletion(statement.finallyBlock);
      completion =
        (finallyCompletion & COMPLETION_NORMAL ? completion : 0) |
        (finallyCompletion & COMPLETION_ABRUPT);
    }
    return completion;
  }
  return COMPLETION_NORMAL;
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
  } else if (ts.isBlock(statement)) {
    for (const child of statement.statements) {
      const completion = visitDefiniteStatement(child, visitor);
      if ((completion & COMPLETION_NORMAL) === 0) break;
    }
  } else if (ts.isIfStatement(statement)) {
    visitDefiniteExpression(statement.expression, visitor);
    const truthiness = staticTruthiness(statement.expression);
    if (truthiness === true) {
      visitDefiniteStatement(statement.thenStatement, visitor);
    } else if (truthiness === false && statement.elseStatement) {
      visitDefiniteStatement(statement.elseStatement, visitor);
    }
  } else if (ts.isDoStatement(statement)) {
    const completion = visitDefiniteStatement(statement.statement, visitor);
    if ((completion & COMPLETION_NORMAL) !== 0) {
      visitDefiniteExpression(statement.expression, visitor);
    }
  } else if (ts.isTryStatement(statement)) {
    const tryCompletion = visitDefiniteStatement(statement.tryBlock, visitor);
    if (tryCompletion === COMPLETION_THROW && statement.catchClause) {
      visitDefiniteStatement(statement.catchClause.block, visitor);
    }
    if (statement.finallyBlock) {
      visitDefiniteStatement(statement.finallyBlock, visitor);
    }
  }
  return statementCompletion(statement);
}

export function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  for (const statement of sourceFile.statements) {
    visitDefiniteStatement(statement, visitor);
  }
}
