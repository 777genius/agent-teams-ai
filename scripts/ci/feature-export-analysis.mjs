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

function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  return bindingName.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
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
