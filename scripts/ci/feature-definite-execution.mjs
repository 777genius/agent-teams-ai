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
  ts.forEachChild(node, (child) => visitDefiniteExpression(child, visitor));
}

export function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  const visitStatement = (statement) => {
    if (ts.isExpressionStatement(statement)) {
      visitDefiniteExpression(statement.expression, visitor);
    } else if (ts.isBlock(statement)) {
      for (const child of statement.statements) visitStatement(child);
    } else if (ts.isIfStatement(statement)) {
      const truthiness = literalTruthiness(statement.expression);
      if (truthiness === true) visitStatement(statement.thenStatement);
      if (truthiness === false && statement.elseStatement) {
        visitStatement(statement.elseStatement);
      }
    }
  };
  for (const statement of sourceFile.statements) visitStatement(statement);
}
