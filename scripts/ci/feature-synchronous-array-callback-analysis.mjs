import ts from 'typescript';

import { callableTarget, callMethod } from './feature-callable-analysis.mjs';
import { unwrapExpression } from './feature-export-ast.mjs';
import { staticTruthiness } from './feature-static-value-analysis.mjs';

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
const STOPS_ON_TRUTHY_METHODS = new Set([
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
]);

function callbackCompletion(callable) {
  if (!ts.isBlock(callable.body)) {
    return { throws: false, truthiness: staticTruthiness(callable.body) };
  }
  for (const statement of callable.body.statements) {
    if (ts.isReturnStatement(statement)) {
      return {
        throws: false,
        truthiness: statement.expression ? staticTruthiness(statement.expression) : false,
      };
    }
    if (ts.isThrowStatement(statement)) return { throws: true, truthiness: null };
    if (
      !ts.isExpressionStatement(statement) &&
      !ts.isVariableStatement(statement) &&
      !ts.isEmptyStatement(statement)
    ) {
      return { throws: false, truthiness: null };
    }
  }
  return { throws: false, truthiness: false };
}

function callbackStopsAfterFirstCall(method, callable) {
  const completion = callbackCompletion(callable);
  return (
    completion.throws ||
    (STOPS_ON_TRUTHY_METHODS.has(method) && completion.truthiness === true) ||
    (method === 'every' && completion.truthiness === false)
  );
}

function callbackArguments(element, receiver) {
  return [element.element, ts.factory.createNumericLiteral(element.index), receiver];
}

function reducerArguments(elements, receiver, initialValue) {
  const callbackElements = initialValue ? elements : elements.slice(1);
  const initialAccumulator = initialValue ?? elements[0].element;
  return callbackElements.map((element) => [
    initialAccumulator,
    element.element,
    ts.factory.createNumericLiteral(element.index),
    receiver,
  ]);
}

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
  let elements = REVERSE_ARRAY_CALLBACK_METHODS.has(method.name)
    ? [...definiteElements].reverse()
    : definiteElements;
  const isReducer = method.name === 'reduce' || method.name === 'reduceRight';
  const initialValue = isReducer && node.arguments.length >= 2 ? node.arguments[1] : null;
  if (callbackStopsAfterFirstCall(method.name, callback)) {
    elements = elements.slice(0, isReducer && !initialValue ? 2 : 1);
  }
  const invocationArguments = isReducer
    ? reducerArguments(elements, receiver, initialValue)
    : elements.map((element) => callbackArguments(element, receiver));
  const elementBindings =
    isReducer
      ? elements.map((element, index) => ({
          element: element.element,
          index: element.index,
          parameterIndex: initialValue || index > 0 ? 1 : 0,
        }))
      : elements.map((element) => ({
          element: element.element,
          index: element.index,
          parameterIndex: 0,
        }));
  return {
    arguments: invocationArguments[0],
    call: node,
    callable: callback,
    elementBindings,
    invocations: invocationArguments.map((argumentsForCall) => ({
      arguments: argumentsForCall,
    })),
    method: method.name,
    receiver,
  };
}
