import ts from 'typescript';

import { callableTarget, callMethod } from './feature-callable-analysis.mjs';
import { unwrapExpression } from './feature-export-ast.mjs';

const SYNCHRONOUS_ARRAY_CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);
const REVERSE_ARRAY_CALLBACK_METHODS = new Set([
  'findLast',
  'findLastIndex',
  'reduceRight',
]);

export function executedSynchronousArrayCallbackForCall(node) {
  if (
    !ts.isCallExpression(node) ||
    node.questionDotToken ||
    node.expression.questionDotToken
  ) {
    return null;
  }
  const method = callMethod(node.expression);
  const receiver = method && unwrapExpression(method.receiver);
  const callback = node.arguments[0] && callableTarget(node.arguments[0]);
  if (
    !method ||
    !SYNCHRONOUS_ARRAY_CALLBACK_METHODS.has(method.name) ||
    !receiver ||
    !ts.isArrayLiteralExpression(receiver) ||
    !callback
  ) {
    return null;
  }
  const definiteElements = receiver.elements.flatMap((element, index) =>
    ts.isOmittedExpression(element) || ts.isSpreadElement(element)
      ? []
      : [{ element, index }]
  );
  const minimumElements =
    method.name === 'reduce' || method.name === 'reduceRight'
      ? node.arguments.length >= 2
        ? 1
        : 2
      : 1;
  if (definiteElements.length < minimumElements) return null;
  const elements = REVERSE_ARRAY_CALLBACK_METHODS.has(method.name)
    ? [...definiteElements].reverse()
    : definiteElements;
  const [first, second] = elements;
  const argumentsForFirstCall =
    method.name === 'reduce' || method.name === 'reduceRight'
      ? node.arguments.length >= 2
        ? [node.arguments[1], first.element, ts.factory.createNumericLiteral(first.index), receiver]
        : [
            first.element,
            second.element,
            ts.factory.createNumericLiteral(second.index),
            receiver,
          ]
      : [first.element, ts.factory.createNumericLiteral(first.index), receiver];
  return {
    arguments: argumentsForFirstCall,
    call: node,
    callable: callback,
    elements,
    method: method.name,
    receiver,
  };
}
