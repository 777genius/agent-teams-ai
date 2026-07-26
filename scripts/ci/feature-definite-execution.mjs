import ts from 'typescript';

function literalTruthiness(node) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  if (ts.isStringLiteralLike(node)) return node.text.length > 0;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  return null;
}

function invocationTarget(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current)
    ? current
    : null;
}

function visitDefiniteExpression(node, visitor) {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
  visitor(node);
  if (ts.isConditionalExpression(node)) {
    visitDefiniteExpression(node.condition, visitor);
    const truthiness = literalTruthiness(node.condition);
    if (truthiness === true) visitDefiniteExpression(node.whenTrue, visitor);
    if (truthiness === false) visitDefiniteExpression(node.whenFalse, visitor);
    return;
  }
  if (
    ts.isCallExpression(node) &&
    (node.questionDotToken || node.expression.questionDotToken)
  ) {
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
    const truthiness = literalTruthiness(node.left);
    const rightIsDefinite =
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        truthiness === true) ||
      (node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        truthiness === false) ||
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        node.left.kind === ts.SyntaxKind.NullKeyword);
    if (rightIsDefinite) visitDefiniteExpression(node.right, visitor);
    return;
  }
  if (ts.isCallExpression(node)) {
    const invokedFunction = invocationTarget(node.expression);
    if (invokedFunction) {
      for (const argument of node.arguments) {
        visitDefiniteExpression(argument, visitor);
      }
      if (ts.isBlock(invokedFunction.body)) {
        visitDefiniteStatement(invokedFunction.body, visitor);
      } else {
        visitDefiniteExpression(invokedFunction.body, visitor);
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
  } else if (ts.isReturnStatement(statement) && statement.expression) {
    visitDefiniteExpression(statement.expression, visitor);
  } else if (ts.isBlock(statement)) {
    for (const child of statement.statements) {
      visitDefiniteStatement(child, visitor);
      if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) break;
    }
  } else if (ts.isIfStatement(statement)) {
    const truthiness = literalTruthiness(statement.expression);
    if (truthiness === true) visitDefiniteStatement(statement.thenStatement, visitor);
    if (truthiness === false && statement.elseStatement) {
      visitDefiniteStatement(statement.elseStatement, visitor);
    }
  }
}

export function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  for (const statement of sourceFile.statements) {
    visitDefiniteStatement(statement, visitor);
  }
}
