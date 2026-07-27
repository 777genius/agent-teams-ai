import ts from 'typescript';

import {
  executedIifeForCall,
  staticNullishness,
  staticStrictEquality,
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
const COMPLETION_BREAK = 1 << 3;
const COMPLETION_CONTINUE = 1 << 4;
const COMPLETION_ABRUPT =
  COMPLETION_RETURN | COMPLETION_THROW | COMPLETION_BREAK | COMPLETION_CONTINUE;

function sequenceCompletion(statements) {
  let completion = COMPLETION_NORMAL;
  for (const statement of statements) {
    if ((completion & COMPLETION_NORMAL) === 0) break;
    completion = (completion & COMPLETION_ABRUPT) | statementCompletion(statement);
  }
  return completion;
}

function possibleSwitchEntries(statement) {
  const clauses = statement.caseBlock.clauses;
  const entries = [];
  for (const [index, clause] of clauses.entries()) {
    if (!ts.isCaseClause(clause)) continue;
    const matches = staticStrictEquality(statement.expression, clause.expression);
    if (matches !== false) entries.push(index);
    if (matches === true) return { entries, noMatch: false };
  }

  const defaultIndex = clauses.findIndex(ts.isDefaultClause);
  if (defaultIndex >= 0) entries.push(defaultIndex);
  return { entries, noMatch: defaultIndex < 0 };
}

function selectedSwitchClause(statement) {
  const { entries, noMatch } = possibleSwitchEntries(statement);
  return !noMatch && entries.length === 1 ? entries[0] : null;
}

function switchCompletionFrom(statement, startIndex) {
  if (startIndex < 0) return COMPLETION_NORMAL;
  const statements = statement.caseBlock.clauses
    .slice(startIndex)
    .flatMap((clause) => [...clause.statements]);
  const completion = sequenceCompletion(statements);
  return (
    (completion & ~COMPLETION_BREAK) |
    ((completion & COMPLETION_BREAK) !== 0 ? COMPLETION_NORMAL : 0)
  );
}

function switchCompletion(statement) {
  const { entries, noMatch } = possibleSwitchEntries(statement);
  let completion = entries.reduce(
    (combined, index) => combined | switchCompletionFrom(statement, index),
    0
  );
  if (noMatch) completion |= COMPLETION_NORMAL;
  return completion;
}

function loopCompletion(statement) {
  const bodyCompletion = statementCompletion(statement.statement);
  const abrupt = bodyCompletion & (COMPLETION_RETURN | COMPLETION_THROW);
  const breaks = (bodyCompletion & COMPLETION_BREAK) !== 0 ? COMPLETION_NORMAL : 0;
  const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
  const truthiness = condition ? staticTruthiness(condition) : true;

  if (ts.isDoStatement(statement)) {
    const reachesCondition = (bodyCompletion & (COMPLETION_NORMAL | COMPLETION_CONTINUE)) !== 0;
    const exitsAfterCondition = reachesCondition && truthiness !== true ? COMPLETION_NORMAL : 0;
    return abrupt | breaks | exitsAfterCondition;
  }
  if (truthiness === false) return COMPLETION_NORMAL;
  if (truthiness === true) return abrupt | breaks;
  return abrupt | COMPLETION_NORMAL;
}

function statementCompletion(statement) {
  if (ts.isReturnStatement(statement)) return COMPLETION_RETURN;
  if (ts.isThrowStatement(statement)) return COMPLETION_THROW;
  if (ts.isBreakStatement(statement)) return COMPLETION_BREAK;
  if (ts.isContinueStatement(statement)) return COMPLETION_CONTINUE;
  if (ts.isBlock(statement)) return sequenceCompletion(statement.statements);
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
  if (ts.isSwitchStatement(statement)) return switchCompletion(statement);
  if (
    ts.isWhileStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isDoStatement(statement)
  ) {
    return loopCompletion(statement);
  }
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

function visitVariableDeclarationList(declarationList, visitor) {
  for (const declaration of declarationList.declarations) {
    if (declaration.initializer) visitDefiniteExpression(declaration.initializer, visitor);
  }
}

function visitSelectedSwitch(statement, visitor) {
  visitDefiniteExpression(statement.expression, visitor);
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    visitDefiniteExpression(clause.expression, visitor);
    if (staticStrictEquality(statement.expression, clause.expression) !== false) break;
  }
  const selected = selectedSwitchClause(statement);
  if (selected === null || selected < 0) return;

  let completion = COMPLETION_NORMAL;
  for (const clause of statement.caseBlock.clauses.slice(selected)) {
    for (const child of clause.statements) {
      if ((completion & COMPLETION_NORMAL) === 0) return;
      completion = (completion & COMPLETION_ABRUPT) | visitDefiniteStatement(child, visitor);
    }
  }
}

function visitLoop(statement, visitor) {
  if (ts.isForStatement(statement)) {
    if (statement.initializer) {
      if (ts.isVariableDeclarationList(statement.initializer)) {
        visitVariableDeclarationList(statement.initializer, visitor);
      } else {
        visitDefiniteExpression(statement.initializer, visitor);
      }
    }
    if (statement.condition) visitDefiniteExpression(statement.condition, visitor);
  } else if (!ts.isDoStatement(statement)) {
    visitDefiniteExpression(statement.expression, visitor);
  }

  const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
  const truthiness = condition ? staticTruthiness(condition) : true;
  if (ts.isDoStatement(statement) || truthiness === true) {
    const bodyCompletion = visitDefiniteStatement(statement.statement, visitor);
    if (
      ts.isForStatement(statement) &&
      statement.incrementor &&
      (bodyCompletion & (COMPLETION_NORMAL | COMPLETION_CONTINUE)) !== 0
    ) {
      visitDefiniteExpression(statement.incrementor, visitor);
    }
    if (
      ts.isDoStatement(statement) &&
      (bodyCompletion & (COMPLETION_NORMAL | COMPLETION_CONTINUE)) !== 0
    ) {
      visitDefiniteExpression(statement.expression, visitor);
    }
  }
}

function visitDefiniteStatement(statement, visitor) {
  if (ts.isExpressionStatement(statement)) {
    visitDefiniteExpression(statement.expression, visitor);
  } else if (ts.isVariableStatement(statement)) {
    visitVariableDeclarationList(statement.declarationList, visitor);
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
  } else if (ts.isSwitchStatement(statement)) {
    visitSelectedSwitch(statement, visitor);
  } else if (
    ts.isWhileStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isDoStatement(statement)
  ) {
    visitLoop(statement, visitor);
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

const definiteExpressionsBySource = new WeakMap();

export function definiteTopLevelExpressionBoundary(node, sourceFile) {
  let expressions = definiteExpressionsBySource.get(sourceFile);
  if (!expressions) {
    expressions = new Set();
    visitDefiniteTopLevelExpressions(sourceFile, (candidate) => {
      if (ts.isExpression(candidate)) expressions.add(candidate);
    });
    definiteExpressionsBySource.set(sourceFile, expressions);
  }

  let boundary = null;
  let current = node;
  while (current && current !== sourceFile) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) break;
    if (ts.isExpression(current) && expressions.has(current)) boundary = current;
    current = current.parent;
  }
  return boundary;
}
