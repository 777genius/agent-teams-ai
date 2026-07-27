import ts from 'typescript';

import { callableTarget, callMethod } from './feature-callable-analysis.mjs';
import { containsReference, propertyNameText, unwrapExpression } from './feature-export-ast.mjs';
import {
  staticNullishness,
  staticPropertyKey,
  staticStrictEquality,
  staticTruthiness,
  staticUndefinedness,
} from './feature-static-value-analysis.mjs';
import { executedSynchronousArrayCallbackForCall } from './feature-synchronous-array-callback-analysis.mjs';

export { staticNullishness, staticStrictEquality, staticTruthiness };

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
  const calledCallable = method?.name === 'call' ? callableTarget(method.receiver) : null;
  return calledCallable
    ? {
        arguments: [...node.arguments].slice(1),
        call: node,
        callable: calledCallable,
      }
    : null;
}

export function executedInvocationForCall(node) {
  return executedIifeForCall(node) ?? executedSynchronousArrayCallbackForCall(node);
}

export function immediateIifeInvocation(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
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
    ((ts.isPropertyAccessExpression(method) &&
      method.expression === current &&
      method.name.text === 'call') ||
      (ts.isElementAccessExpression(method) &&
        method.expression === current &&
        method.argumentExpression &&
        ts.isStringLiteralLike(unwrapExpression(method.argumentExpression)) &&
        unwrapExpression(method.argumentExpression).text === 'call')) &&
    methodCall &&
    ts.isCallExpression(methodCall) &&
    methodCall.expression === method &&
    executedIifeForCall(methodCall)?.callable === node
    ? methodCall
    : null;
}

export function immediateSynchronousArrayCallbackInvocation(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  const call = current.parent;
  return call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === current &&
    executedSynchronousArrayCallbackForCall(call)?.callable === node
    ? call
    : null;
}

export function immediateExecutedInvocation(node) {
  return (
    immediateIifeInvocation(node) ??
    immediateSynchronousArrayCallbackInvocation(node)
  );
}

const MISSING_ARGUMENT = Symbol('missing-argument');
const UNKNOWN_SELECTION = Symbol('unknown-selection');
const DEFINED_SELECTION = Symbol('defined-selection');

function selectionUndefinedness(expression) {
  if (expression === MISSING_ARGUMENT) return true;
  if (expression === UNKNOWN_SELECTION) return null;
  if (expression === DEFINED_SELECTION) return false;
  return staticUndefinedness(expression);
}

export function isPotentiallyExecutedAtTopLevel(node, sourceFile) {
  let current = node;
  while (current && current !== sourceFile) {
    const parent = current.parent;
    if (!parent) return false;
    if (ts.isFunctionLike(parent)) {
      const invocation = immediateExecutedInvocation(parent);
      if (!invocation) return false;
      current = invocation;
      continue;
    }
    if (ts.isClassLike(parent)) return false;
    if (ts.isIfStatement(parent)) {
      const condition = staticTruthiness(parent.expression);
      if (
        (condition === true && current === parent.elseStatement) ||
        (condition === false && current === parent.thenStatement)
      ) {
        return false;
      }
    } else if (ts.isConditionalExpression(parent)) {
      const condition = staticTruthiness(parent.condition);
      if (
        (condition === true && current === parent.whenFalse) ||
        (condition === false && current === parent.whenTrue)
      ) {
        return false;
      }
    } else if (ts.isBinaryExpression(parent) && current === parent.right) {
      const left = staticTruthiness(parent.left);
      if (
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) ||
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) ||
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          staticNullishness(parent.left) === false)
      ) {
        return false;
      }
    } else if (
      (ts.isWhileStatement(parent) || ts.isForStatement(parent)) &&
      current === parent.statement
    ) {
      const condition = ts.isForStatement(parent) ? parent.condition : parent.expression;
      if (condition && staticTruthiness(condition) === false) return false;
    }
    current = parent;
  }
  return current === sourceFile;
}

function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    ts.isAssignmentOperator(parent.operatorToken.kind) &&
    unwrapExpression(parent.left) === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ('name' in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent))
  ) {
    return false;
  }
  return !(ts.isBindingElement(parent) && parent.propertyName === node);
}

function bindingEntries(bindingName, path = []) {
  if (ts.isIdentifier(bindingName)) return [{ identifier: bindingName, path }];
  return bindingName.elements.flatMap((element, index) => {
    if (!ts.isBindingElement(element)) return [];
    const selected = element.dotDotDotToken
      ? '*'
      : ts.isObjectBindingPattern(bindingName)
        ? propertyNameText(element.propertyName ?? element.name)
        : String(index);
    return bindingEntries(element.name, [...path, selected]);
  });
}

function directLexicalBindings(node) {
  const names = new Set();
  const add = (bindingName) => {
    for (const { identifier } of bindingEntries(bindingName)) {
      names.add(identifier.text);
    }
  };
  const statements =
    ts.isBlock(node) || ts.isSourceFile(node)
      ? node.statements
      : ts.isCaseBlock(node)
        ? node.clauses.flatMap((clause) => [...clause.statements])
        : [];
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        add(declaration.name);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    add(node.variableDeclaration.name);
  }
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
  ) {
    for (const declaration of node.initializer.declarations) add(declaration.name);
  }
  return names;
}

function callableBindsName(callable, name) {
  return (
    callable.parameters.some((parameter) =>
      bindingEntries(parameter.name).some(({ identifier }) => identifier.text === name)
    ) ||
    (callable.name && ts.isIdentifier(callable.name) && callable.name.text === name)
  );
}

function expressionReadsBinding(expression, name) {
  let found = false;
  const visit = (node) => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isIdentifier(node) && node.text === name && isValueReference(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function bindingLiveAfterExpression(expression, name, live) {
  const current = unwrapExpression(expression);
  if (ts.isBinaryExpression(current)) {
    const assignmentTarget = unwrapExpression(current.left);
    if (
      ts.isIdentifier(assignmentTarget) &&
      assignmentTarget.text === name &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(current.operatorToken.kind)
    ) {
      // A live implementation value is truthy and non-nullish on the path carrying this taint.
      if (
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      ) {
        return live && expressionReadsBinding(current.right, name);
      }
      return live;
    }
    if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      const afterLeft = bindingLiveAfterExpression(current.left, name, live);
      return bindingLiveAfterExpression(current.right, name, afterLeft);
    }
    if (
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) {
      const afterLeft = bindingLiveAfterExpression(current.left, name, live);
      const truthiness = staticTruthiness(current.left);
      const rightIsDefinite =
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          truthiness === true) ||
        (current.operatorToken.kind === ts.SyntaxKind.BarBarToken && truthiness === false) ||
        (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          staticNullishness(current.left) === true);
      if (rightIsDefinite) {
        return bindingLiveAfterExpression(current.right, name, afterLeft);
      }
      return afterLeft || bindingLiveAfterExpression(current.right, name, afterLeft);
    }
  }
  if (ts.isConditionalExpression(current)) {
    const afterCondition = bindingLiveAfterExpression(current.condition, name, live);
    const truthiness = staticTruthiness(current.condition);
    if (truthiness === true) {
      return bindingLiveAfterExpression(current.whenTrue, name, afterCondition);
    }
    if (truthiness === false) {
      return bindingLiveAfterExpression(current.whenFalse, name, afterCondition);
    }
    return (
      bindingLiveAfterExpression(current.whenTrue, name, afterCondition) ||
      bindingLiveAfterExpression(current.whenFalse, name, afterCondition)
    );
  }
  if (ts.isCallExpression(current)) {
    const invocation = executedInvocationForCall(current);
    if (
      invocation?.callable.body &&
      !callableBindsName(invocation.callable, name) &&
      ts.isBlock(invocation.callable.body)
    ) {
      let afterArguments = live;
      for (const argument of invocation.arguments) {
        afterArguments = bindingLiveAfterExpression(argument, name, afterArguments);
      }
      return bindingLiveAfterStatement(invocation.callable.body, name, afterArguments);
    }
  }
  return live;
}

function bindingLiveAfterStatement(statement, name, live) {
  if (ts.isExpressionStatement(statement)) {
    return bindingLiveAfterExpression(statement.expression, name, live);
  }
  if (ts.isBlock(statement)) {
    if (directLexicalBindings(statement).has(name)) return live;
    return statement.statements.reduce(
      (current, child) => bindingLiveAfterStatement(child, name, current),
      live
    );
  }
  if (ts.isIfStatement(statement)) {
    const afterCondition = bindingLiveAfterExpression(statement.expression, name, live);
    const truthiness = staticTruthiness(statement.expression);
    if (truthiness === true) {
      return bindingLiveAfterStatement(statement.thenStatement, name, afterCondition);
    }
    if (truthiness === false) {
      return statement.elseStatement
        ? bindingLiveAfterStatement(statement.elseStatement, name, afterCondition)
        : afterCondition;
    }
    return (
      bindingLiveAfterStatement(statement.thenStatement, name, afterCondition) ||
      (statement.elseStatement
        ? bindingLiveAfterStatement(statement.elseStatement, name, afterCondition)
        : afterCondition)
    );
  }
  return live;
}

function bindingIsLiveAtReference(callable, name, reference) {
  const preceding = [];
  let current = reference;
  while (current && current !== callable.body) {
    const parent = current.parent;
    if (!parent) break;
    if (ts.isBlock(parent) && parent.statements.includes(current)) {
      preceding.unshift(...parent.statements.slice(0, parent.statements.indexOf(current)));
    } else if (
      (ts.isIfStatement(parent) &&
        (current === parent.thenStatement || current === parent.elseStatement)) ||
      (ts.isConditionalExpression(parent) &&
        (current === parent.whenTrue || current === parent.whenFalse))
    ) {
      preceding.unshift(parent.expression ?? parent.condition);
    }
    current = parent;
  }
  return preceding.reduce(
    (live, node) =>
      ts.isStatement(node)
        ? bindingLiveAfterStatement(node, name, live)
        : bindingLiveAfterExpression(node, name, live),
    true
  );
}

function parameterReferences(callable, identifier) {
  if (!callable.body) return [];
  const references = [];
  const visit = (node, shadowed = false) => {
    if (node !== callable.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      if (
        ts.isFunctionLike(node) &&
        immediateExecutedInvocation(node) &&
        node.body &&
        !callableBindsName(node, identifier.text)
      ) {
        visit(node.body, shadowed);
      }
      return;
    }
    const nestedShadow =
      shadowed ||
      (node !== callable.body &&
        (ts.isBlock(node) ||
          ts.isCaseBlock(node) ||
          ts.isCatchClause(node) ||
          ts.isForStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isForOfStatement(node)) &&
        directLexicalBindings(node).has(identifier.text));
    if (
      !nestedShadow &&
      ts.isIdentifier(node) &&
      node.text === identifier.text &&
      isValueReference(node)
    ) {
      if (bindingIsLiveAtReference(callable, identifier.text, node)) references.push(node);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, nestedShadow));
  };
  visit(callable.body);
  return references;
}

function referencePath(expression, reference) {
  if (!containsReference(expression, reference)) return null;
  const path = [];
  let current = reference;
  while (current !== expression) {
    const parent = current.parent;
    if (!parent || !containsReference(parent, reference)) return null;
    if (ts.isPropertyAssignment(parent) && containsReference(parent.initializer, reference)) {
      path.unshift(propertyNameText(parent.name));
    } else if (
      ts.isShorthandPropertyAssignment(parent) &&
      containsReference(parent.name, reference)
    ) {
      path.unshift(propertyNameText(parent.name));
    } else if (ts.isArrayLiteralExpression(parent)) {
      path.unshift(String(parent.elements.indexOf(current)));
    } else if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) {
      path.unshift('*');
    }
    current = parent;
  }
  return path;
}

function pathsOverlap(bindingPath, selectedPath) {
  const length = Math.min(bindingPath.length, selectedPath.length);
  return Array.from({ length }, (_, index) => index).every(
    (index) =>
      bindingPath[index] === '*' ||
      selectedPath[index] === '*' ||
      bindingPath[index] === selectedPath[index]
  );
}

function referencesForBindingSelection(callable, bindingName, selectedPath) {
  return bindingEntries(bindingName)
    .filter(({ path }) => pathsOverlap(path, selectedPath))
    .flatMap(({ identifier }) => parameterReferences(callable, identifier));
}

function referencesForSelection(callable, parameter, selectedPath) {
  return referencesForBindingSelection(callable, parameter.name, selectedPath);
}

function staticPropertyName(name) {
  return staticPropertyKey(name);
}

function objectLiteralSelection(object, key) {
  for (const property of [...object.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      const selected = literalSelection(property.expression, key, false);
      if (selected !== MISSING_ARGUMENT) return selected;
      continue;
    }
    const propertyKey = staticPropertyName(property.name);
    if (propertyKey === null) return UNKNOWN_SELECTION;
    if (propertyKey !== key) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    return DEFINED_SELECTION;
  }
  return MISSING_ARGUMENT;
}

function arrayLiteralSelection(array, index) {
  if (array.elements.some(ts.isSpreadElement)) return UNKNOWN_SELECTION;
  const element = array.elements[index];
  return !element || ts.isOmittedExpression(element) ? MISSING_ARGUMENT : element;
}

function literalSelection(source, key, arrayPattern) {
  if (source === MISSING_ARGUMENT || source === UNKNOWN_SELECTION) return UNKNOWN_SELECTION;
  const current = unwrapExpression(source);
  if (arrayPattern && ts.isArrayLiteralExpression(current)) {
    return arrayLiteralSelection(current, Number(key));
  }
  if (!arrayPattern && ts.isObjectLiteralExpression(current)) {
    return objectLiteralSelection(current, key);
  }
  if (!arrayPattern && staticNullishness(current) === false && staticTruthiness(current) !== null) {
    return MISSING_ARGUMENT;
  }
  return UNKNOWN_SELECTION;
}

function bindingPatternContains(pattern, target) {
  if (ts.isIdentifier(pattern)) return false;
  return pattern.elements.some(
    (element) =>
      ts.isBindingElement(element) &&
      (element === target || bindingPatternContains(element.name, target))
  );
}

function bindingElementKey(pattern, element, index) {
  if (ts.isArrayBindingPattern(pattern)) return String(index);
  const name = element.propertyName ?? element.name;
  return staticPropertyName(name);
}

function bindingElementDefaultExecutes(pattern, source, target) {
  if (ts.isIdentifier(pattern)) return false;
  for (const [index, element] of pattern.elements.entries()) {
    if (!ts.isBindingElement(element)) continue;
    if (element !== target && !bindingPatternContains(element.name, target)) continue;
    const key = bindingElementKey(pattern, element, index);
    if (key === null || element.dotDotDotToken) return false;
    let selected = literalSelection(source, key, ts.isArrayBindingPattern(pattern));
    const undefinedness = selectionUndefinedness(selected);
    if (element === target) return undefinedness === true;
    if (undefinedness === true) {
      if (!element.initializer) return false;
      selected = element.initializer;
    } else if (undefinedness === null) {
      return false;
    }
    return bindingElementDefaultExecutes(element.name, selected, target);
  }
  return false;
}

function parameterDefaultExecutes(argument) {
  return argument === undefined || staticUndefinedness(argument) === true;
}

function effectiveParameterValue(parameter, argument) {
  if (!parameterDefaultExecutes(argument)) {
    return argument === undefined ? UNKNOWN_SELECTION : argument;
  }
  return parameter.initializer ?? UNKNOWN_SELECTION;
}

export function executedInvocationParameterInitializer(parameter, argument) {
  const value = effectiveParameterValue(parameter, argument);
  return value === UNKNOWN_SELECTION || value === MISSING_ARGUMENT ? null : value;
}

function defaultParameterReferences(callable, parameter, reference, argument) {
  let current = reference;
  while (current && current !== parameter) {
    const parent = current.parent;
    if (!parent) return [];
    if (
      ts.isBindingElement(parent) &&
      parent.initializer &&
      containsReference(parent.initializer, reference)
    ) {
      if (
        !bindingElementDefaultExecutes(
          parameter.name,
          effectiveParameterValue(parameter, argument),
          parent
        )
      ) {
        return [];
      }
      const selectedPath = referencePath(parent.initializer, reference) ?? [];
      return referencesForBindingSelection(callable, parent.name, selectedPath);
    }
    current = parent;
  }
  if (
    !parameter.initializer ||
    !containsReference(parameter.initializer, reference) ||
    !parameterDefaultExecutes(argument)
  ) {
    return [];
  }
  const selectedPath = referencePath(parameter.initializer, reference) ?? [];
  return referencesForSelection(callable, parameter, selectedPath);
}

function synchronousCallbackParameterReferences(invocation, reference) {
  const elementPosition = invocation.elements.findIndex(({ element }) =>
    containsReference(element, reference)
  );
  if (elementPosition < 0) return [];
  const { element } = invocation.elements[elementPosition];
  const isReducer = invocation.method === 'reduce' || invocation.method === 'reduceRight';
  const hasInitialValue = isReducer && invocation.call.arguments.length >= 2;
  const valueParameterIndex = isReducer
    ? hasInitialValue || elementPosition > 0
      ? 1
      : 0
    : 0;
  const selections = [
    {
      parameter: invocation.callable.parameters[valueParameterIndex],
      path: referencePath(element, reference),
    },
    {
      parameter: invocation.callable.parameters[isReducer ? 3 : 2],
      path: referencePath(invocation.receiver, reference),
    },
  ];
  return [
    ...new Set(
      selections.flatMap(({ parameter, path }) =>
        parameter && path
          ? referencesForSelection(invocation.callable, parameter, path)
          : []
      )
    ),
  ];
}

export function executedInvocationParameterReferences(reference) {
  let current = reference;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent)) {
      const callbackInvocation = executedSynchronousArrayCallbackForCall(parent);
      const callbackReferences =
        callbackInvocation &&
        synchronousCallbackParameterReferences(callbackInvocation, reference);
      if (callbackReferences && callbackReferences.length > 0) return callbackReferences;
      const invocation = callbackInvocation ?? executedIifeForCall(parent);
      const argumentIndex = invocation?.arguments.findIndex((argument) =>
        argument ? containsReference(argument, reference) : false
      );
      if (invocation && argumentIndex !== undefined && argumentIndex >= 0) {
        const parameter =
          invocation.callable.parameters[argumentIndex] ??
          (invocation.callable.parameters.at(-1)?.dotDotDotToken
            ? invocation.callable.parameters.at(-1)
            : null);
        const selectedPath = referencePath(invocation.arguments[argumentIndex], reference);
        return parameter && selectedPath
          ? referencesForSelection(invocation.callable, parameter, selectedPath)
          : [];
      }
      if (invocation) {
        for (const [index, parameter] of invocation.callable.parameters.entries()) {
          const references = defaultParameterReferences(
            invocation.callable,
            parameter,
            reference,
            invocation.arguments[index]
          );
          if (references.length > 0) return references;
        }
      }
    }
    current = parent;
  }
  return [];
}
