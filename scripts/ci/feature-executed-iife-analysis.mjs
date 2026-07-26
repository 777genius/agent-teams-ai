import ts from 'typescript';

import { containsReference, unwrapExpression } from './feature-export-ast.mjs';

function callableTarget(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    current = unwrapExpression(current.right);
  }
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current)
    ? current
    : null;
}

function callMethod(expression) {
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

export function executedIifeForCall(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken) return null;

  const directCallable = callableTarget(node.expression);
  if (directCallable) {
    return {
      arguments: [...node.arguments],
      call: node,
      callable: directCallable,
    };
  }

  const method = callMethod(node.expression);
  const calledCallable =
    method?.name === 'call' ? callableTarget(method.receiver) : null;
  return calledCallable
    ? {
        arguments: [...node.arguments].slice(1),
        call: node,
        callable: calledCallable,
      }
    : null;
}

export function immediateIifeInvocation(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      parent.right === current
    ) {
      current = parent;
      continue;
    }
    break;
  }

  const directCall = current.parent;
  if (
    directCall &&
    ts.isCallExpression(directCall) &&
    directCall.expression === current &&
    executedIifeForCall(directCall)?.callable === node
  ) {
    return directCall;
  }

  const method = current.parent;
  const methodCall = method?.parent;
  return method &&
    (
      (ts.isPropertyAccessExpression(method) &&
        method.expression === current &&
        method.name.text === 'call') ||
      (ts.isElementAccessExpression(method) &&
        method.expression === current &&
        method.argumentExpression &&
        ts.isStringLiteralLike(unwrapExpression(method.argumentExpression)) &&
        unwrapExpression(method.argumentExpression).text === 'call')
    ) &&
    methodCall &&
    ts.isCallExpression(methodCall) &&
    methodCall.expression === method &&
    executedIifeForCall(methodCall)?.callable === node
    ? methodCall
    : null;
}

export function staticTruthiness(expression) {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  if (ts.isStringLiteralLike(current)) return current.text.length > 0;
  if (ts.isNumericLiteral(current)) return Number(current.text) !== 0;
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = staticTruthiness(current.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

export function staticNullishness(expression) {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.NullKeyword) return true;
  return staticTruthiness(current) === null ? null : false;
}

function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ('name' in parent &&
      parent.name === node &&
      !ts.isShorthandPropertyAssignment(parent))
  ) {
    return false;
  }
  return !(ts.isBindingElement(parent) && parent.propertyName === node);
}

function parameterReferences(callable, parameter) {
  if (!ts.isIdentifier(parameter.name) || !callable.body) return [];
  const references = [];
  const visit = (node) => {
    if (node !== callable.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.name.text &&
      isValueReference(node)
    ) {
      references.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  return references;
}

export function executedIifeParameterReferences(reference) {
  let current = reference;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent)) {
      const invocation = executedIifeForCall(parent);
      const argumentIndex = invocation?.arguments.findIndex((argument) =>
        containsReference(argument, reference)
      );
      if (invocation && argumentIndex !== undefined && argumentIndex >= 0) {
        const parameter =
          invocation.callable.parameters[argumentIndex] ??
          (
            invocation.callable.parameters.at(-1)?.dotDotDotToken
              ? invocation.callable.parameters.at(-1)
              : null
          );
        return parameter ? parameterReferences(invocation.callable, parameter) : [];
      }
    }
    current = parent;
  }
  return [];
}
