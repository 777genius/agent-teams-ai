import ts from 'typescript';

import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import { IDENTITY_WRAPPERS } from './feature-identity-wrappers.mjs';

function callable(node) {
  const current = node && unwrapExpression(node);
  return current && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ? current
    : null;
}

function returnedExpressions(callback) {
  if (!callback) return [];
  if (!ts.isBlock(callback.body)) return [callback.body];

  const returned = [];
  const visit = (node) => {
    if (node !== callback && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returned.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return returned;
}

function bindingSelections(bindingName, path = [], selections = new Map()) {
  if (ts.isIdentifier(bindingName)) {
    selections.set(bindingName.text, path[0] ?? '*');
    return selections;
  }
  for (const [index, element] of bindingName.elements.entries()) {
    if (!ts.isBindingElement(element)) continue;
    const selected =
      ts.isObjectBindingPattern(bindingName) && !element.dotDotDotToken
        ? propertyNameText(element.propertyName ?? element.name)
        : ts.isArrayBindingPattern(bindingName) && !element.dotDotDotToken
          ? String(index)
          : '*';
    bindingSelections(element.name, [...path, selected], selections);
  }
  return selections;
}

function selectedNamesFromReturn(expression, parameter) {
  const selections = bindingSelections(parameter.name);
  const names = new Set();
  const visit = (node) => {
    if (!ts.isIdentifier(node) || !selections.has(node.text)) {
      ts.forEachChild(node, visit);
      return;
    }

    const selected = selections.get(node.text);
    if (selected !== '*') {
      names.add(selected);
      return;
    }
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      names.add(parent.name.text);
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const argument = parent.argumentExpression && unwrapExpression(parent.argumentExpression);
      names.add(
        argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
          ? argument.text
          : '*'
      );
    } else {
      names.add('*');
    }
  };
  visit(expression);
  return names;
}

export function dynamicThenCallbackMember(callbackExpression) {
  const callback = callable(callbackExpression);
  const [parameter] = callback?.parameters ?? [];
  if (!callback || !parameter) return null;

  const names = new Set();
  for (const expression of returnedExpressions(callback)) {
    for (const name of selectedNamesFromReturn(expression, parameter)) names.add(name);
  }
  return names.size === 1 ? [...names][0] : names.size > 1 ? '*' : null;
}

function returnedMemberForReference(callback, reference) {
  const returned = returnedExpressions(callback).find((expression) =>
    containsReference(expression, reference)
  );
  if (!returned) return null;

  let current = reference;
  while (current && current !== returned) {
    const parent = current.parent;
    if (!parent || !containsReference(parent, reference)) break;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.name
    ) {
      return { localMember: propertyNameText(parent.name) };
    }
    current = parent;
  }
  return { localMember: undefined };
}

export function iifeSelectionForReference(initializer, reference) {
  const current = initializer && unwrapExpression(initializer);
  if (!current || !ts.isCallExpression(current)) return null;
  const callback = callable(current.expression);
  return callback && containsReference(callback, reference)
    ? returnedMemberForReference(callback, reference)
    : null;
}

function descriptorContainsReference(descriptorExpression, reference, includeValue = false) {
  const descriptor = descriptorExpression && unwrapExpression(descriptorExpression);
  if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) return false;
  return descriptor.properties.some((property) => {
    if (!property.name) return false;
    const name = propertyNameText(property.name);
    if (name !== 'get' && (!includeValue || name !== 'value')) return false;
    return containsReference(property, reference);
  });
}

export function descriptorMapGetterMember(descriptorsExpression, reference) {
  const descriptors = descriptorsExpression && unwrapExpression(descriptorsExpression);
  if (!descriptors) return null;
  if (ts.isConditionalExpression(descriptors)) {
    return (
      descriptorMapGetterMember(descriptors.whenTrue, reference) ??
      descriptorMapGetterMember(descriptors.whenFalse, reference)
    );
  }
  if (!ts.isObjectLiteralExpression(descriptors)) return null;
  const property = descriptors.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      descriptorContainsReference(candidate.initializer, reference)
  );
  return property && ts.isPropertyAssignment(property) ? propertyNameText(property.name) : null;
}

function isObjectCreateDescriptorMap(declaration) {
  if (!ts.isIdentifier(declaration.name)) return false;
  const sourceFile = declaration.getSourceFile();
  let found = false;
  const visit = (node) => {
    if (found || (node !== sourceFile && (ts.isFunctionLike(node) || ts.isClassLike(node)))) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const method = memberAccess(node.expression);
      const descriptors = node.arguments[1] && unwrapExpression(node.arguments[1]);
      if (
        method?.name === 'create' &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        ts.isIdentifier(descriptors) &&
        descriptors.text === declaration.name.text
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function publicSurfaceExpressions(expression) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  if (!ts.isCallExpression(current)) return [current];
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    method.receiver.text !== 'Object' ||
    !IDENTITY_WRAPPERS.has(method.name)
  ) {
    return [current];
  }
  const argumentsToInspect =
    method.name === 'assign' ? current.arguments : current.arguments.slice(0, 1);
  return argumentsToInspect.flatMap(publicSurfaceExpressions);
}

function objectGetterMember(objectExpression, reference) {
  for (const object of publicSurfaceExpressions(objectExpression)) {
    if (!ts.isObjectLiteralExpression(object)) continue;
    const getter = object.properties.find(
      (property) => ts.isGetAccessorDeclaration(property) && containsReference(property, reference)
    );
    if (getter && ts.isGetAccessorDeclaration(getter)) return propertyNameText(getter.name);
  }
  return null;
}

function objectCallableMember(objectExpression, reference) {
  for (const object of publicSurfaceExpressions(objectExpression)) {
    if (!ts.isObjectLiteralExpression(object)) continue;
    const member = object.properties.find((property) => {
      if (ts.isMethodDeclaration(property)) return containsReference(property, reference);
      if (!ts.isPropertyAssignment(property)) return false;
      const initializer = unwrapExpression(property.initializer);
      return ts.isFunctionLike(initializer) && containsReference(initializer, reference);
    });
    if (member?.name) return propertyNameText(member.name);
  }
  return null;
}

function objectCreateGetterMember(expression, reference) {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return null;
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    method.receiver.text !== 'Object' ||
    method.name !== 'create'
  ) {
    return null;
  }
  return descriptorMapGetterMember(current.arguments[1], reference);
}

function descriptorInitializerSelection(expression, reference) {
  const current = expression && unwrapExpression(expression);
  if (!current || !ts.isCallExpression(current)) return null;
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text)
  ) {
    return null;
  }
  if (method.name === 'defineProperty') {
    if (!descriptorContainsReference(current.arguments[2], reference, true)) return null;
    const exportName = current.arguments[1] && unwrapExpression(current.arguments[1]);
    return {
      localMember:
        exportName && (ts.isStringLiteralLike(exportName) || ts.isNumericLiteral(exportName))
          ? exportName.text
          : '*',
    };
  }
  if (method.name !== 'defineProperties') return null;
  const descriptors = current.arguments[1] && unwrapExpression(current.arguments[1]);
  if (!descriptors || !ts.isObjectLiteralExpression(descriptors)) return null;
  const property = descriptors.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      descriptorContainsReference(candidate.initializer, reference, true)
  );
  return property?.name ? { localMember: propertyNameText(property.name) } : null;
}

export function variableValueSelection(declaration, reference, exported) {
  if (!declaration.initializer || !containsReference(declaration.initializer, reference)) {
    return null;
  }
  const objectMember = objectGetterMember(declaration.initializer, reference);
  if (objectMember !== null) return { localMember: objectMember };
  const callableMember = objectCallableMember(declaration.initializer, reference);
  if (callableMember !== null) return { getterOnly: true, localMember: callableMember };
  const createdMember = objectCreateGetterMember(declaration.initializer, reference);
  if (createdMember !== null) return { localMember: createdMember };
  const descriptorInitializer = descriptorInitializerSelection(declaration.initializer, reference);
  if (descriptorInitializer) return descriptorInitializer;
  if (descriptorContainsReference(declaration.initializer, reference)) {
    return { localMember: null };
  }
  const descriptorMember = descriptorMapGetterMember(declaration.initializer, reference);
  if (descriptorMember !== null) {
    return {
      descriptorGetter: true,
      getterOnly: !isObjectCreateDescriptorMap(declaration),
      localMember: descriptorMember,
    };
  }
  const iifeSelection = iifeSelectionForReference(declaration.initializer, reference);
  if (iifeSelection) return iifeSelection;
  const initializer = unwrapExpression(declaration.initializer);
  return !exported && ts.isFunctionLike(initializer)
    ? { getterOnly: true, localMember: undefined }
    : null;
}

export function expressionGetterSelection(expression, reference) {
  const current = unwrapExpression(expression);
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const localMember = objectGetterMember(current.right, reference);
    if (localMember !== null) return { localMember };
    const initializer = unwrapExpression(current.right);
    return ts.isFunctionLike(initializer) && containsReference(initializer, reference)
      ? { getterOnly: true, localMember: undefined }
      : null;
  }
  if (!ts.isCallExpression(current)) return null;

  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text)
  ) {
    return null;
  }
  if (method.name === 'defineProperty') {
    if (!descriptorContainsReference(current.arguments[2], reference)) return null;
    const exportName = current.arguments[1];
    return {
      localMember: exportName && ts.isStringLiteralLike(exportName) ? exportName.text : '*',
    };
  }
  if (method.name === 'defineProperties') {
    const localMember = descriptorMapGetterMember(current.arguments[1], reference);
    return localMember === null ? null : { descriptorGetter: true, getterOnly: true, localMember };
  }
  if (method.name !== 'assign') return null;
  for (const source of current.arguments.slice(1)) {
    const localMember = objectGetterMember(source, reference);
    if (localMember !== null) return { localMember };
  }
  return null;
}

export function exportAssignmentValueSelection(expression, reference) {
  const localMember = objectGetterMember(expression, reference);
  if (localMember !== null) return { localMember };
  return iifeSelectionForReference(expression, reference);
}
