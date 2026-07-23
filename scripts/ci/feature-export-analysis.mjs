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
  while (true) {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

export function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  return bindingName.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function assignmentLocalNames(target) {
  const current = unwrapExpression(target);
  if (ts.isIdentifier(current)) return [current.text];
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentLocalNames(current.left);
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text];
      if (ts.isPropertyAssignment(property)) return assignmentLocalNames(property.initializer);
      if (ts.isSpreadAssignment(property)) return assignmentLocalNames(property.expression);
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : assignmentLocalNames(element)
    );
  }
  return [];
}

function unwrapExpression(expression) {
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

function memberAccess(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return { name: current.name.text, receiver: unwrapExpression(current.expression) };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    ts.isStringLiteralLike(current.argumentExpression)
  ) {
    return { name: current.argumentExpression.text, receiver: unwrapExpression(current.expression) };
  }
  return null;
}

function assignmentTargetSelections(expression, exportedLocalNames) {
  const current = unwrapExpression(expression);
  if (
    !ts.isBinaryExpression(current) ||
    current.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return [];
  }

  const target = unwrapExpression(current.left);
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      let importedName = '*';
      let localNames = [];
      if (ts.isShorthandPropertyAssignment(property)) {
        importedName = property.name.text;
        localNames = [property.name.text];
      } else if (ts.isPropertyAssignment(property)) {
        const name = property.name;
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) importedName = name.text;
        localNames = assignmentLocalNames(property.initializer);
      } else if (ts.isSpreadAssignment(property)) {
        localNames = assignmentLocalNames(property.expression);
      }
      localNames = localNames.filter((name) => exportedLocalNames.has(name));
      return localNames.length > 0 ? [{ importedName, localNames }] : [];
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    const localNames = assignmentLocalNames(target).filter((name) =>
      exportedLocalNames.has(name)
    );
    return localNames.length > 0 ? [{ importedName: '*', localNames }] : [];
  }
  return [];
}

function isModuleExports(expression) {
  const access = memberAccess(expression);
  return (
    access?.name === 'exports' &&
    ts.isIdentifier(access.receiver) &&
    access.receiver.text === 'module'
  );
}

function isCommonJsExportsObject(expression) {
  const current = unwrapExpression(expression);
  return (
    (ts.isIdentifier(current) && current.text === 'exports') || isModuleExports(current)
  );
}

function commonJsAssignmentExportName(expression) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }

  const target = unwrapExpression(expression.left);
  if (isModuleExports(target)) return '*';

  const access = memberAccess(target);
  if (!access) return null;
  if (ts.isIdentifier(access.receiver) && access.receiver.text === 'exports') return access.name;
  return isModuleExports(access.receiver) ? access.name : null;
}

export function commonJsExportNamesForExpression(expression) {
  const assignmentName = commonJsAssignmentExportName(expression);
  if (assignmentName) return [assignmentName];

  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return [];

  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    !['assign', 'defineProperties', 'defineProperty'].includes(method.name) ||
    !current.arguments[0] ||
    !isCommonJsExportsObject(current.arguments[0])
  ) {
    return [];
  }

  if (method.name !== 'defineProperty') return ['*'];
  const exportName = current.arguments[1];
  return exportName && ts.isStringLiteralLike(exportName) ? [exportName.text] : ['*'];
}

export function findPublicMutationOwner(expression, exportedLocalNames) {
  const current = unwrapExpression(expression);
  let target = ts.isAssignmentExpression(current) ? current.left : null;
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const receiver = rootBindingName(current.expression.expression);
    if (receiver && exportedLocalNames.has(receiver)) return receiver;
    if (
      (receiver === 'Object' || receiver === 'Reflect') &&
      MUTATING_OBJECT_METHODS.has(current.expression.name.text)
    ) {
      [target] = current.arguments;
    }
  }
  const targetName = target && rootBindingName(target);
  return targetName && exportedLocalNames.has(targetName) ? targetName : null;
}

export function publicMutationBinding(expression, exportedLocalNames) {
  const bindingSelections = assignmentTargetSelections(expression, exportedLocalNames);
  if (bindingSelections.length > 0) {
    return {
      bindingSelections,
      localNames: bindingSelections.flatMap(({ localNames }) => localNames),
    };
  }

  const mutationOwner = findPublicMutationOwner(expression, exportedLocalNames);
  return { bindingSelections: null, localNames: mutationOwner ? [mutationOwner] : [] };
}

export function objectBindingSelections(bindingName) {
  if (!ts.isObjectBindingPattern(bindingName)) return null;
  return bindingName.elements.map((element) => {
    const selectedName = element.propertyName ?? element.name;
    const importedName =
      !element.dotDotDotToken &&
      (ts.isIdentifier(selectedName) || ts.isStringLiteralLike(selectedName))
        ? selectedName.text
        : '*';
    return { importedName, localNames: bindingNames(element.name) };
  });
}

export function selectedMemberForReference(reference) {
  const parent = reference.parent;
  if (ts.isQualifiedName(parent) && parent.left === reference) return parent.right.text;
  return selectedMemberAfterTransparentWrappers(reference);
}

export function selectedMemberAfterTransparentWrappers(reference) {
  let current = reference;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isAwaitExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    break;
  }

  const access = memberAccess(current.parent ?? current);
  return access?.receiver === unwrapExpression(current) ? access.name : null;
}

export function importedNameForReference(reference, importedBinding) {
  if (importedBinding.importedName !== '*') return importedBinding.importedName;
  return selectedMemberForReference(reference) ?? importedBinding.importedName;
}

export function selectImportedName(importedName, selectedName) {
  return importedName === '*' && selectedName ? selectedName : importedName;
}
