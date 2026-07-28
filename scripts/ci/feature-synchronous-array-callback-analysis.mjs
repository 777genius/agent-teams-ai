import ts from 'typescript';

import { callableTarget, callMethod } from './feature-callable-analysis.mjs';
import { containsReference, unwrapExpression } from './feature-export-ast.mjs';
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
const REVERSE_ARRAY_CALLBACK_METHODS = new Set(['findLast', 'findLastIndex', 'reduceRight']);
const VISITS_ARRAY_HOLES_METHODS = new Set(['find', 'findIndex', 'findLast', 'findLastIndex']);
const STOPS_ON_TRUTHY_METHODS = new Set(['find', 'findIndex', 'findLast', 'findLastIndex', 'some']);
const UNKNOWN_REDUCER_ACCUMULATOR = ts.factory.createObjectLiteralExpression();

function statementOutcomes(statement) {
  if (ts.isReturnStatement(statement)) {
    return [{ expression: statement.expression, kind: 'return' }];
  }
  if (ts.isThrowStatement(statement)) return [{ kind: 'throw' }];
  if (ts.isBlock(statement)) return statementListOutcomes(statement.statements);
  if (ts.isIfStatement(statement)) {
    const truthiness = staticTruthiness(statement.expression);
    const thenOutcomes = statementOutcomes(statement.thenStatement);
    const elseOutcomes = statement.elseStatement
      ? statementOutcomes(statement.elseStatement)
      : [{ kind: 'normal' }];
    if (truthiness === true) return thenOutcomes;
    if (truthiness === false) return elseOutcomes;
    return [...thenOutcomes, ...elseOutcomes];
  }
  if (
    ts.isExpressionStatement(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isEmptyStatement(statement)
  ) {
    return [{ kind: 'normal' }];
  }
  return [{ kind: 'normal' }, { kind: 'unknown' }];
}

function statementListOutcomes(statements) {
  let outcomes = [{ kind: 'normal' }];
  for (const statement of statements) {
    outcomes = outcomes.flatMap((outcome) =>
      outcome.kind === 'normal' ? statementOutcomes(statement) : [outcome]
    );
  }
  return outcomes;
}

function callbackOutcomes(callable) {
  const outcomes = ts.isBlock(callable.body)
    ? statementListOutcomes(callable.body.statements)
    : [{ expression: callable.body, kind: 'return' }];
  return outcomes.map((outcome) =>
    outcome.kind === 'normal' ? { expression: undefined, kind: 'return' } : outcome
  );
}

function callbackCompletion(callable) {
  const outcomes = callbackOutcomes(callable);
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === 'throw')) {
    return { throws: true, truthiness: null };
  }
  const truthiness = outcomes.map((outcome) =>
    outcome.kind === 'return'
      ? outcome.expression
        ? staticTruthiness(outcome.expression)
        : false
      : null
  );
  const first = truthiness[0] ?? null;
  return {
    throws: false,
    truthiness:
      first !== null && truthiness.every((candidate) => candidate === first) ? first : null,
  };
}

function callbackStopsAfterFirstCall(method, callable) {
  return callbackOutcomes(callable).every(
    (outcome) =>
      outcome.kind === 'throw' ||
      (outcome.kind === 'return' &&
        ((STOPS_ON_TRUTHY_METHODS.has(method) &&
          outcome.expression &&
          staticTruthiness(outcome.expression) === true) ||
          (method === 'every' &&
            (!outcome.expression || staticTruthiness(outcome.expression) === false))))
  );
}

function callbackArguments(element, receiver) {
  return [element.element, ts.factory.createNumericLiteral(element.index), receiver];
}

function reducerResultCandidates(callable, invocation) {
  return [
    ...new Set(
      callbackOutcomes(callable).flatMap((outcome) => {
        if (outcome.kind === 'throw') return [];
        if (outcome.kind === 'unknown') return [UNKNOWN_REDUCER_ACCUMULATOR];
        const current = outcome.expression && unwrapExpression(outcome.expression);
        const parameterIndex =
          current && ts.isIdentifier(current)
            ? callable.parameters.findIndex(
                (parameter) =>
                  ts.isIdentifier(parameter.name) && parameter.name.text === current.text
              )
            : -1;
        if (parameterIndex >= 0) {
          return (
            invocation.argumentCandidates?.[parameterIndex] ?? [
              invocation.arguments[parameterIndex],
            ]
          ).filter(Boolean);
        }
        return [outcome.expression ?? UNKNOWN_REDUCER_ACCUMULATOR];
      })
    ),
  ];
}

function reducerInvocations(elements, receiver, initialValue, callable) {
  const callbackElements = initialValue ? elements : elements.slice(1);
  let accumulatorCandidates = [initialValue ?? elements[0].element];
  return callbackElements.map((element) => {
    const invocation = {
      argumentCandidates: [
        accumulatorCandidates,
        [element.element],
        [ts.factory.createNumericLiteral(element.index)],
        [receiver],
      ],
      arguments: [
        accumulatorCandidates[0],
        element.element,
        ts.factory.createNumericLiteral(element.index),
        receiver,
      ],
    };
    accumulatorCandidates = reducerResultCandidates(callable, invocation);
    return invocation;
  });
}

export function executedSynchronousArrayCallbackForCall(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken || node.expression.questionDotToken) {
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
  const definiteElements = receiver.elements.flatMap((element, index) => {
    if (ts.isSpreadElement(element)) return [];
    if (ts.isOmittedExpression(element)) {
      return VISITS_ARRAY_HOLES_METHODS.has(method.name)
        ? [{ element: ts.factory.createVoidZero(), index }]
        : [];
    }
    return [{ element, index }];
  });
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
  const completion = callbackCompletion(callback);
  if (callbackStopsAfterFirstCall(method.name, callback)) {
    elements = elements.slice(0, isReducer && !initialValue ? 2 : 1);
  }
  const invocations = isReducer
    ? reducerInvocations(elements, receiver, initialValue, callback)
    : elements.map((element) => ({ arguments: callbackArguments(element, receiver) }));
  const elementBindings = isReducer
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
    arguments: invocations[0].arguments,
    call: node,
    callable: callback,
    completion,
    elementBindings,
    invocations,
    method: method.name,
    receiver,
  };
}

export function synchronousArrayResultDiscardsReference(reference, boundary) {
  let current = reference;
  while (current) {
    if (ts.isCallExpression(current)) {
      const invocation = executedSynchronousArrayCallbackForCall(current);
      if (invocation && containsReference(invocation.receiver, reference)) {
        if (invocation.method === 'findIndex' || invocation.method === 'findLastIndex') {
          return true;
        }
        if (invocation.method === 'find' || invocation.method === 'findLast') {
          return (
            invocation.completion.throws ||
            invocation.completion.truthiness === false ||
            !invocation.elementBindings.some(({ element }) => containsReference(element, reference))
          );
        }
      }
    }
    if (current === boundary) break;
    current = current.parent;
  }
  return false;
}
