import ts from 'typescript';

export function containsReference(node, reference) {
  return reference.pos >= node.pos && reference.end <= node.end;
}

export function unwrapExpression(expression) {
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
  return current;
}

export function memberAccess(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return { name: current.name.text, receiver: unwrapExpression(current.expression) };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteralLike(current.argumentExpression) ||
      ts.isNumericLiteral(current.argumentExpression))
  ) {
    return {
      name: current.argumentExpression.text,
      receiver: unwrapExpression(current.expression),
    };
  }
  return null;
}

export function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return '*';
}
