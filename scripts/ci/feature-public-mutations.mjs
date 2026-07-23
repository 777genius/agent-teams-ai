import ts from 'typescript';

const MUTATING_OBJECT_METHODS = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'set',
  'setPrototypeOf',
]);

function rootBindingName(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

export function findPublicMutationOwner(expression, exportedLocalNames) {
  let target = ts.isAssignmentExpression(expression) ? expression.left : null;
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const receiver = rootBindingName(expression.expression.expression);
    if (receiver && exportedLocalNames.has(receiver)) return receiver;
    if (
      (receiver === 'Object' || receiver === 'Reflect') &&
      MUTATING_OBJECT_METHODS.has(expression.expression.name.text)
    ) {
      [target] = expression.arguments;
    }
  }
  const targetName = target && rootBindingName(target);
  return targetName && exportedLocalNames.has(targetName) ? targetName : null;
}
