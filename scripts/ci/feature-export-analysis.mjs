import ts from 'typescript';

const MUTATING_OBJECT_METHODS = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'set',
  'setPrototypeOf',
]);

export function rootBindingName(expression) {
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

export function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
  );
}

export function statementBindingNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }
  return 'name' in statement && statement.name && ts.isIdentifier(statement.name)
    ? [statement.name.text]
    : [];
}

function unwrapParenthesizedType(node) {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

export function importTypeSelectedNames(node) {
  let current = node.qualifier;
  while (current && ts.isQualifiedName(current)) current = current.left;
  if (current && ts.isIdentifier(current)) return [current.text];

  let selectedType = node;
  while (
    selectedType.parent &&
    ts.isParenthesizedTypeNode(selectedType.parent) &&
    selectedType.parent.type === selectedType
  ) {
    selectedType = selectedType.parent;
  }
  const parent = selectedType.parent;
  if (!parent || !ts.isIndexedAccessTypeNode(parent) || parent.objectType !== selectedType) {
    return ['*'];
  }
  const selected = unwrapParenthesizedType(parent.indexType);
  const selectedTypes = ts.isUnionTypeNode(selected) ? selected.types : [selected];
  const names = selectedTypes.map((selectedTypeNode) => {
    const unwrapped = unwrapParenthesizedType(selectedTypeNode);
    return ts.isLiteralTypeNode(unwrapped) && ts.isStringLiteralLike(unwrapped.literal)
      ? unwrapped.literal.text
      : null;
  });
  return names.every((name) => name !== null) ? [...new Set(names)] : ['*'];
}

export function isIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  ) {
    return false;
  }
  if (
    'name' in parent &&
    parent.name === node &&
    !ts.isShorthandPropertyAssignment(parent) &&
    !ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  return !(
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent)
  );
}

export function isShadowedTypeReference(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (
      'typeParameters' in current &&
      current.typeParameters?.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === node.text
      )
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function assignmentLocalNames(target) {
  const current = unwrapExpression(target);
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
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

function assignmentTargetSelections(expression, exportedLocalNames) {
  const current = unwrapExpression(expression);
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
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
    const localNames = assignmentLocalNames(target).filter((name) => exportedLocalNames.has(name));
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

export function commonJsExportPath(expression) {
  let current = unwrapExpression(expression);
  if ((ts.isIdentifier(current) && current.text === 'exports') || isModuleExports(current)) {
    return [];
  }

  const path = [];
  while (true) {
    const access =
      memberAccess(current) ??
      (ts.isElementAccessExpression(current)
        ? { name: '*', receiver: unwrapExpression(current.expression) }
        : null);
    if (!access) return null;
    path.unshift(access.name);
    current = access.receiver;
    if (ts.isIdentifier(current) && current.text === 'exports') return path;
    if (isModuleExports(current)) return path;
  }
}

function commonJsTargetPath(expression, commonJsTargetAliases = new Set()) {
  const directPath = commonJsExportPath(expression);
  if (directPath !== null) {
    const root = rootBindingName(expression);
    if (root === 'exports' && commonJsTargetAliases.directExportsActive === false) return null;
    if (root === 'module' && commonJsTargetAliases.directModuleExportsActive === false) {
      return null;
    }
    return directPath;
  }

  let current = unwrapExpression(expression);
  const path = [];
  while (true) {
    const access = memberAccess(current);
    if (!access) break;
    path.unshift(access.name);
    current = access.receiver;
  }
  return ts.isIdentifier(current) && commonJsTargetAliases.has(current.text) ? path : null;
}

export function isCommonJsExportsObject(expression) {
  return commonJsExportPath(expression) !== null;
}

function commonJsAssignmentExportName(expression, commonJsTargetAliases) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }

  const target = unwrapExpression(expression.left);
  const exportPath = commonJsTargetPath(target, commonJsTargetAliases);
  return exportPath === null ? null : (exportPath[0] ?? '*');
}

function commonJsCreateBindingSelection(expression, reference, commonJsTargetAliases = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return null;

  const method = memberAccess(current.expression);
  const callee = unwrapExpression(current.expression);
  const helperName = ts.isIdentifier(callee) ? callee.text : method?.name;
  if (
    helperName !== '__createBinding' ||
    !current.arguments[0] ||
    commonJsTargetPath(current.arguments[0], commonJsTargetAliases) === null ||
    !current.arguments[1] ||
    (reference && !containsReference(current.arguments[1], reference))
  ) {
    return null;
  }

  const importedName = current.arguments[2];
  const exportedName = current.arguments[3] ?? importedName;
  const targetPath = commonJsTargetPath(current.arguments[0], commonJsTargetAliases);
  return {
    exportedName:
      targetPath && targetPath.length > 0
        ? targetPath[0]
        : exportedName && ts.isStringLiteralLike(exportedName)
          ? exportedName.text
          : '*',
    importedName: importedName && ts.isStringLiteralLike(importedName) ? importedName.text : '*',
  };
}

export function commonJsExportNamesForExpression(expression, commonJsTargetAliases = new Set()) {
  const assignmentName = commonJsAssignmentExportName(expression, commonJsTargetAliases);
  if (assignmentName) return [assignmentName];

  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return [];

  const method = memberAccess(current.expression);
  const callee = unwrapExpression(current.expression);
  const helperName = ts.isIdentifier(callee) ? callee.text : method?.name;
  if (
    (helperName === '__exportStar' || helperName === '_exportStar') &&
    current.arguments[1] &&
    isCommonJsExportsObject(current.arguments[1])
  ) {
    return [commonJsExportPath(current.arguments[1])?.[0] ?? '*'];
  }
  const createBinding = commonJsCreateBindingSelection(current, undefined, commonJsTargetAliases);
  if (createBinding) return [createBinding.exportedName];
  const target = current.arguments[0];
  const targetPath = target ? commonJsTargetPath(target, commonJsTargetAliases) : null;
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    !MUTATING_OBJECT_METHODS.has(method.name) ||
    targetPath === null
  ) {
    return [];
  }

  if (targetPath.length > 0) return [targetPath[0]];
  if (method.name !== 'defineProperty' && method.name !== 'set') return ['*'];
  const exportName = current.arguments[1];
  return exportName && ts.isStringLiteralLike(exportName) ? [exportName.text] : ['*'];
}

function containsReference(node, reference) {
  return reference.pos >= node.pos && reference.end <= node.end;
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

function descriptorGetterContainsReference(descriptorExpression, reference) {
  const descriptor = descriptorExpression && unwrapExpression(descriptorExpression);
  if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) return false;
  return descriptor.properties.some((property) => {
    const name = property.name;
    const isGetProperty =
      name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'get';
    if (!isGetProperty) return false;
    if (ts.isPropertyAssignment(property)) {
      return containsReference(property.initializer, reference);
    }
    return ts.isMethodDeclaration(property) && containsReference(property, reference);
  });
}

function descriptorMapGetterMember(descriptorsExpression, reference) {
  const descriptors = descriptorsExpression && unwrapExpression(descriptorsExpression);
  if (!descriptors || !ts.isObjectLiteralExpression(descriptors)) return null;
  const property = descriptors.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      descriptorGetterContainsReference(candidate.initializer, reference)
  );
  return property && ts.isPropertyAssignment(property) ? propertyNameText(property.name) : null;
}

function objectGetterMember(objectExpression, reference) {
  const object = objectExpression && unwrapExpression(objectExpression);
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const getter = object.properties.find(
    (property) => ts.isGetAccessorDeclaration(property) && containsReference(property, reference)
  );
  return getter && ts.isGetAccessorDeclaration(getter) ? propertyNameText(getter.name) : null;
}

function objectCallableMember(objectExpression, reference) {
  const object = objectExpression && unwrapExpression(objectExpression);
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const member = object.properties.find((property) => {
    if (ts.isMethodDeclaration(property)) return containsReference(property, reference);
    if (!ts.isPropertyAssignment(property)) return false;
    const initializer = unwrapExpression(property.initializer);
    return (
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      containsReference(initializer, reference)
    );
  });
  return member?.name ? propertyNameText(member.name) : null;
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

function expressionGetterSelection(expression, reference) {
  const current = unwrapExpression(expression);
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const localMember = objectGetterMember(current.right, reference);
    if (localMember !== null) return { localMember };
    const initializer = unwrapExpression(current.right);
    return (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      containsReference(initializer, reference)
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
    if (!descriptorGetterContainsReference(current.arguments[2], reference)) return null;
    const exportName = current.arguments[1];
    return {
      localMember: exportName && ts.isStringLiteralLike(exportName) ? exportName.text : '*',
    };
  }
  if (method.name === 'defineProperties') {
    const localMember = descriptorMapGetterMember(current.arguments[1], reference);
    return localMember === null ? null : { localMember };
  }
  if (method.name !== 'assign') return null;
  for (const source of current.arguments.slice(1)) {
    const localMember = objectGetterMember(source, reference);
    if (localMember !== null) return { localMember };
  }
  return null;
}

export function getterSelectionForReference(reference, boundary) {
  if (ts.isVariableStatement(boundary)) {
    for (const declaration of boundary.declarationList.declarations) {
      if (!declaration.initializer || !containsReference(declaration.initializer, reference)) {
        continue;
      }
      const objectMember = objectGetterMember(declaration.initializer, reference);
      if (objectMember !== null) return { localMember: objectMember };
      const callableMember = objectCallableMember(declaration.initializer, reference);
      if (callableMember !== null) return { getterOnly: true, localMember: callableMember };
      const createdMember = objectCreateGetterMember(declaration.initializer, reference);
      if (createdMember !== null) return { localMember: createdMember };
      if (descriptorGetterContainsReference(declaration.initializer, reference)) {
        return { localMember: null };
      }
      const descriptorMember = descriptorMapGetterMember(declaration.initializer, reference);
      if (descriptorMember !== null) return { localMember: descriptorMember };
      const initializer = unwrapExpression(declaration.initializer);
      if (
        !hasModifier(boundary, ts.SyntaxKind.ExportKeyword) &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        return { getterOnly: true, localMember: undefined };
      }
    }
    return null;
  }
  if (ts.isFunctionDeclaration(boundary) && !hasModifier(boundary, ts.SyntaxKind.ExportKeyword)) {
    return { getterOnly: true, localMember: undefined };
  }
  if (ts.isExpressionStatement(boundary)) {
    return expressionGetterSelection(boundary.expression, reference);
  }
  if (ts.isExportAssignment(boundary)) {
    const localMember = objectGetterMember(boundary.expression, reference);
    return localMember === null ? null : { localMember };
  }
  return null;
}

export function commonJsExportNamesForReference(
  expression,
  reference,
  insideFunctionBody,
  commonJsTargetAliases = new Set()
) {
  const createBinding = commonJsCreateBindingSelection(
    expression,
    undefined,
    commonJsTargetAliases
  );
  if (
    createBinding &&
    !commonJsCreateBindingSelection(expression, reference, commonJsTargetAliases)
  ) {
    return [];
  }

  const exportNames = commonJsExportNamesForExpression(expression, commonJsTargetAliases);
  if (
    exportNames.length > 0 &&
    commonJsTargetAliases.isReferencePublic?.(expression, reference) === false
  ) {
    return [];
  }
  if (!insideFunctionBody || exportNames.length === 0) return exportNames;

  const selection = expressionGetterSelection(expression, reference);
  if (!selection) return [];
  return exportNames.includes('*') && selection.localMember ? [selection.localMember] : exportNames;
}

export function findPublicReferenceOwner(
  node,
  sourceFile,
  publicTargetOwners,
  commonJsTargetAliases = new Set(),
  publicConstructorNames = new Set(),
  selectPublicConstructorMember = () => null
) {
  let current = node;
  let insideFunctionBody = false;
  while (current && current !== sourceFile) {
    if (
      ts.isFunctionLike(current) &&
      current.body &&
      node.getStart(sourceFile) >= current.body.getStart(sourceFile)
    ) {
      insideFunctionBody = true;
    }
    if (current.parent === sourceFile) break;
    current = current.parent;
  }
  if (!current || current.parent !== sourceFile) return null;
  const isPublicConstructor =
    (ts.isClassDeclaration(current) || ts.isFunctionDeclaration(current)) &&
    current.name &&
    publicConstructorNames.has(current.name.text);
  const getterSelection = isPublicConstructor
    ? selectPublicConstructorMember(node, current)
    : insideFunctionBody
      ? getterSelectionForReference(node, current)
      : null;
  if ((insideFunctionBody || isPublicConstructor) && !getterSelection) return null;

  let bindingSelections = null;
  let localNames = [];
  if (ts.isVariableStatement(current)) {
    const declaration = current.declarationList.declarations.find((candidate) =>
      containsReference(candidate, node)
    );
    if (declaration) {
      bindingSelections = objectBindingSelections(declaration.name);
      localNames = bindingNames(declaration.name);
      localNames = localNames.map((localName) => publicTargetOwners.get(localName) ?? localName);
    }
  } else if ('name' in current && current.name && ts.isIdentifier(current.name)) {
    localNames = [current.name.text];
  } else if (ts.isExpressionStatement(current)) {
    const commonJsExportNames = commonJsExportNamesForReference(
      current.expression,
      node,
      insideFunctionBody,
      commonJsTargetAliases
    );
    if (commonJsExportNames.length > 0) {
      return {
        bindingSelections: null,
        exportedNames: commonJsExportNames,
        localMember: commonJsCreateBindingSelection(current.expression, node, commonJsTargetAliases)
          ?.importedName,
        localNames: [],
      };
    }
    ({ bindingSelections, localNames } = publicMutationBinding(
      current.expression,
      publicTargetOwners
    ));
    if (
      localNames.length === 0 &&
      getterSelection?.getterOnly &&
      ts.isBinaryExpression(current.expression) &&
      current.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      localNames = assignmentLocalNames(current.expression.left);
    }
  }

  if (ts.isExportAssignment(current)) {
    return {
      bindingSelections,
      exportedNames: ['default'],
      getterOnly: getterSelection?.getterOnly,
      localMember: getterSelection?.localMember,
      localNames: [],
    };
  }
  if (!hasModifier(current, ts.SyntaxKind.ExportKeyword)) {
    return {
      bindingSelections,
      exportedNames: [],
      getterOnly: getterSelection?.getterOnly,
      localMember: getterSelection?.localMember,
      localNames,
    };
  }
  return {
    bindingSelections,
    exportedNames: hasModifier(current, ts.SyntaxKind.DefaultKeyword) ? ['default'] : localNames,
    getterOnly: getterSelection?.getterOnly,
    localMember: getterSelection?.localMember,
    localNames,
  };
}

export function findPublicMutationOwner(expression, publicTargetOwners) {
  const current = unwrapExpression(expression);
  let target = ts.isAssignmentExpression(current) ? current.left : null;
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const receiver = rootBindingName(current.expression.expression);
    if (receiver && publicTargetOwners.has(receiver)) {
      return publicTargetOwners.get(receiver);
    }
    if (
      (receiver === 'Object' || receiver === 'Reflect') &&
      MUTATING_OBJECT_METHODS.has(current.expression.name.text)
    ) {
      [target] = current.arguments;
    }
  }
  const targetName = target && rootBindingName(target);
  return targetName ? (publicTargetOwners.get(targetName) ?? null) : null;
}

export function publicMutationBinding(expression, publicTargetOwners) {
  const bindingSelections = assignmentTargetSelections(expression, publicTargetOwners);
  if (bindingSelections.length > 0) {
    return {
      bindingSelections,
      localNames: bindingSelections.flatMap(({ localNames }) => localNames),
    };
  }

  const mutationOwner = findPublicMutationOwner(expression, publicTargetOwners);
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

function transparentReferenceNode(reference) {
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
  return current;
}

export function selectedMemberAfterTransparentWrappers(reference) {
  const current = transparentReferenceNode(reference);
  const access = memberAccess(current.parent ?? current);
  return access?.receiver === unwrapExpression(current) ? access.name : null;
}

function selectedThenCallbackMember(callback) {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const [parameter] = callback.parameters;
  if (!parameter) return null;

  const returnedExpression = ts.isBlock(callback.body)
    ? callback.body.statements.find(ts.isReturnStatement)?.expression
    : callback.body;
  if (!returnedExpression) return null;

  const returned = unwrapExpression(returnedExpression);
  if (ts.isIdentifier(parameter.name)) {
    const access = memberAccess(returned);
    return access &&
      ts.isIdentifier(access.receiver) &&
      access.receiver.text === parameter.name.text
      ? access.name
      : null;
  }
  if (!ts.isIdentifier(returned)) return null;
  return (
    objectBindingSelections(parameter.name)?.find(({ localNames }) =>
      localNames.includes(returned.text)
    )?.importedName ?? null
  );
}

export function importedNameForCall(reference, isDynamicImport) {
  const selectedName = selectedMemberAfterTransparentWrappers(reference);
  if (!isDynamicImport || selectedName !== 'then') return selectedName ?? '*';

  const current = transparentReferenceNode(reference);
  const thenAccess = current.parent;
  const thenCall = thenAccess?.parent;
  if (
    !thenAccess ||
    !ts.isPropertyAccessExpression(thenAccess) ||
    !thenCall ||
    !ts.isCallExpression(thenCall) ||
    thenCall.expression !== thenAccess
  ) {
    return '*';
  }
  return selectedThenCallbackMember(thenCall.arguments[0]) ?? '*';
}

export function importedNameForReference(reference, importedBinding) {
  if (importedBinding.importedName !== '*') return importedBinding.importedName;
  return selectedMemberForReference(reference) ?? importedBinding.importedName;
}

export function selectImportedName(importedName, selectedName) {
  return importedName === '*' && selectedName ? selectedName : importedName;
}
