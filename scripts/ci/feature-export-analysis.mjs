import ts from 'typescript';

import {
  definiteTopLevelExpressionBoundary,
  isReachableThroughContainingStatementLists,
} from './feature-definite-execution.mjs';
import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import { immediateInvocation, topLevelExpressionBoundary } from './feature-export-flow-analysis.mjs';
import {
  executedInvocationParameterReferences,
  isPotentiallyExecutedAtTopLevel,
} from './feature-executed-iife-analysis.mjs';
import {
  dynamicThenCallbackMember,
  exportAssignmentValueSelection,
  expressionGetterSelection,
  variableValueSelection,
} from './feature-export-value-analysis.mjs';

export { memberAccess, propertyNameText, unwrapExpression };

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

function isExportedNamespaceStatement(statement) {
  return (
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  );
}

function isReferenceInExportedNamespaceMember(node, namespaceDeclaration) {
  let current = node;
  while (current && current !== namespaceDeclaration) {
    if (current.parent && ts.isModuleBlock(current.parent)) {
      if (!isExportedNamespaceStatement(current)) return false;
      current = current.parent.parent;
      continue;
    }
    current = current.parent;
  }
  return current === namespaceDeclaration;
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
  if (!ts.isIdentifier(current)) return null;
  const isPublicPath =
    commonJsTargetAliases.hasPath?.(current.text, path) || commonJsTargetAliases.has(current.text);
  return isPublicPath ? path : null;
}

export function isCommonJsExportsObject(expression) {
  return commonJsExportPath(expression) !== null;
}

function commonJsAssignmentExportName(expression, commonJsTargetAliases) {
  if (
    !ts.isBinaryExpression(expression) ||
    ![
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(expression.operatorToken.kind)
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
    commonJsTargetPath(current.arguments[1], commonJsTargetAliases) !== null
  ) {
    return [commonJsTargetPath(current.arguments[1], commonJsTargetAliases)?.[0] ?? '*'];
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

export function getterSelectionForReference(reference, boundary) {
  if (ts.isVariableStatement(boundary)) {
    for (const declaration of boundary.declarationList.declarations) {
      const selection = variableValueSelection(
        declaration,
        reference,
        hasModifier(boundary, ts.SyntaxKind.ExportKeyword)
      );
      if (selection) return selection;
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
    return exportAssignmentValueSelection(boundary.expression, reference);
  }
  return null;
}

export function commonJsExportNamesForReference(
  expression,
  reference,
  insideFunctionBody,
  commonJsTargetAliases = new Set(),
  publicSelection
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

  const selection = publicSelection ?? expressionGetterSelection(expression, reference);
  if (!selection) return [];
  return exportNames.includes('*') && selection.localMember ? [selection.localMember] : exportNames;
}

function potentialTopLevelExpressionBoundary(node, sourceFile) {
  if (!isPotentiallyExecutedAtTopLevel(node, sourceFile)) return null;
  let current = node;
  while (current && current !== sourceFile) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return null;
    if (ts.isExpressionStatement(current)) return current;
    current = current.parent;
  }
  return null;
}

function nestedPublicMutationExpression(
  expression,
  reference,
  publicTargetOwners,
  commonJsTargetAliases
) {
  let current = reference;
  while (current && current !== expression) {
    if (
      ts.isExpression(current) &&
      (commonJsExportNamesForExpression(current, commonJsTargetAliases).length > 0 ||
        findPublicMutationOwner(current, publicTargetOwners))
    ) {
      return current;
    }
    current = current.parent;
  }
  return expression;
}

function definitePublicMutationExpression(
  node,
  sourceFile,
  publicTargetOwners,
  commonJsTargetAliases
) {
  const boundary = definiteTopLevelExpressionBoundary(node, sourceFile);
  if (!boundary) return null;
  const mutation = nestedPublicMutationExpression(
    boundary,
    node,
    publicTargetOwners,
    commonJsTargetAliases
  );
  return commonJsExportNamesForExpression(mutation, commonJsTargetAliases).length > 0 ||
    findPublicMutationOwner(mutation, publicTargetOwners)
    ? mutation
    : null;
}

export function findPublicReferenceOwner(
  node,
  sourceFile,
  publicTargetOwners,
  commonJsTargetAliases = new Set(),
  classifyPublicClassReference = () => undefined
) {
  for (const parameterReference of executedInvocationParameterReferences(node)) {
    const parameterOwners =
      publicTargetOwners.atPosition?.(parameterReference.getStart(sourceFile)) ??
      publicTargetOwners;
    const parameterCommonJsTargets =
      commonJsTargetAliases.atPosition?.(parameterReference.getStart(sourceFile)) ??
      commonJsTargetAliases;
    const parameterOwner = findPublicReferenceOwner(
      parameterReference,
      sourceFile,
      parameterOwners,
      parameterCommonJsTargets,
      classifyPublicClassReference
    );
    if (
      parameterOwner &&
      (parameterOwner.localNames.length > 0 || parameterOwner.exportedNames.length > 0)
    ) {
      return parameterOwner;
    }
  }

  let current = node;
  let insideFunctionBody = false;
  while (current && current !== sourceFile) {
    if (
      ts.isFunctionLike(current) &&
      !immediateInvocation(current) &&
      current.body &&
      node.getStart(sourceFile) >= current.body.getStart(sourceFile)
    ) {
      insideFunctionBody = true;
    }
    if (current.parent === sourceFile) break;
    current = current.parent;
  }
  if (!current || current.parent !== sourceFile) return null;
  const potentiallyExecutedAtTopLevel =
    isPotentiallyExecutedAtTopLevel(node, sourceFile) &&
    isReachableThroughContainingStatementLists(node);
  const definiteMutation = potentiallyExecutedAtTopLevel
    ? definitePublicMutationExpression(
        node,
        sourceFile,
        publicTargetOwners,
        commonJsTargetAliases
      )
    : null;
  const publicExpressionBoundary = potentiallyExecutedAtTopLevel
    ? (topLevelExpressionBoundary(node, sourceFile) ??
      potentialTopLevelExpressionBoundary(node, sourceFile) ??
      definiteMutation)
    : null;
  current = publicExpressionBoundary ?? current;
  const classReference = classifyPublicClassReference(node);
  const getterSelection = classReference
    ? classReference.selection
    : insideFunctionBody
      ? getterSelectionForReference(node, current)
      : null;
  if ((insideFunctionBody || classReference) && !getterSelection && !definiteMutation) return null;

  let bindingSelections = null;
  let descriptorGetterIsPublic = false;
  let localNames = [];
  if (ts.isVariableStatement(current)) {
    const declaration = current.declarationList.declarations.find((candidate) =>
      containsReference(candidate, node)
    );
    if (declaration) {
      if (
        publicTargetOwners.isBindingVersionPublic?.(declaration) === false ||
        publicTargetOwners.isReferencePublic?.(node, declaration) === false
      ) {
        return null;
      }
      bindingSelections = objectBindingSelections(declaration.name);
      localNames = bindingNames(declaration.name);
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      const referenceOwner = getterSelection?.descriptorGetter
        ? publicTargetOwners.ownerForReference?.(node, {
            localMember: getterSelection.localMember,
            localNames,
          })
        : initializer && ts.isConditionalExpression(initializer)
          ? publicTargetOwners.ownerForReference?.(node)
          : null;
      descriptorGetterIsPublic = Boolean(getterSelection?.descriptorGetter && referenceOwner);
      localNames = referenceOwner
        ? [referenceOwner]
        : localNames.map((localName) => publicTargetOwners.get(localName) ?? localName);
    }
  } else if (ts.isModuleDeclaration(current)) {
    if (!isReferenceInExportedNamespaceMember(node, current)) return null;
    if (current.name && ts.isIdentifier(current.name)) {
      localNames = [current.name.text];
    }
  } else if ('name' in current && current.name && ts.isIdentifier(current.name)) {
    localNames = [current.name.text];
  } else if (ts.isExpressionStatement(current) || ts.isExpression(current)) {
    const boundaryExpression = ts.isExpressionStatement(current) ? current.expression : current;
    const expression = publicExpressionBoundary
      ? nestedPublicMutationExpression(
          boundaryExpression,
          node,
          publicTargetOwners,
          commonJsTargetAliases
        )
      : boundaryExpression;
    if (publicTargetOwners.isMutationReferencePublic?.(node, expression) === false) {
      return null;
    }
    const commonJsExportNames = commonJsExportNamesForReference(
      expression,
      node,
      insideFunctionBody,
      commonJsTargetAliases,
      classReference?.selection
    );
    if (commonJsExportNames.length > 0) {
      return {
        bindingSelections: null,
        exportedNames: commonJsExportNames,
        localMember: commonJsCreateBindingSelection(expression, node, commonJsTargetAliases)
          ?.importedName,
        localNames: [],
      };
    }
    ({ bindingSelections, localNames } = publicMutationBinding(expression, publicTargetOwners));
    if (localNames.length === 0 && classReference?.localName) {
      localNames = [classReference.localName];
    }
    if (getterSelection?.descriptorGetter) {
      const selectionLocalNames = mutationTargetLocalNames(expression);
      const referenceOwner = publicTargetOwners.ownerForReference?.(node, {
        localMember: getterSelection.localMember,
        localNames: selectionLocalNames.length > 0 ? selectionLocalNames : localNames,
      });
      if (referenceOwner) localNames = [referenceOwner];
      descriptorGetterIsPublic = Boolean(referenceOwner);
    }
    if (
      localNames.length === 0 &&
      getterSelection?.getterOnly &&
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      localNames = assignmentLocalNames(expression.left);
    }
  }

  const getterOnly =
    getterSelection?.descriptorGetter && descriptorGetterIsPublic
      ? false
      : getterSelection?.getterOnly;
  if (ts.isExportAssignment(current)) {
    return {
      bindingSelections,
      exportedNames: ['default'],
      getterOnly,
      localMember: getterSelection?.localMember,
      localNames: [],
    };
  }
  if (!hasModifier(current, ts.SyntaxKind.ExportKeyword)) {
    return {
      bindingSelections,
      exportedNames: [],
      getterOnly,
      localMember: getterSelection?.localMember,
      localNames,
    };
  }
  return {
    bindingSelections,
    exportedNames: hasModifier(current, ts.SyntaxKind.DefaultKeyword) ? ['default'] : localNames,
    getterOnly,
    localMember: getterSelection?.localMember,
    localNames,
  };
}

export function findPublicMutationOwner(expression, publicTargetOwners) {
  const current = unwrapExpression(expression);
  let target = ts.isAssignmentExpression(current) ? current.left : null;
  const unwrappedTarget = target && unwrapExpression(target);
  if (unwrappedTarget && ts.isIdentifier(unwrappedTarget)) {
    const ownersAfterAssignment =
      publicTargetOwners.atPosition?.(current.end) ?? publicTargetOwners;
    return ownersAfterAssignment.get(unwrappedTarget.text) ?? null;
  }
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

function mutationTargetLocalNames(expression) {
  const current = unwrapExpression(expression);
  if (ts.isAssignmentExpression(current)) return assignmentLocalNames(current.left);
  if (!ts.isCallExpression(current)) return [];
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    !MUTATING_OBJECT_METHODS.has(method.name)
  ) {
    return [];
  }
  const targetName = current.arguments[0] && rootBindingName(current.arguments[0]);
  return targetName ? [targetName] : [];
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
  return dynamicThenCallbackMember(thenCall.arguments[0]) ?? '*';
}

export function importedNameForReference(reference, importedBinding) {
  if (importedBinding.importedName !== '*') return importedBinding.importedName;
  return selectedMemberForReference(reference) ?? importedBinding.importedName;
}

export function selectImportedName(importedName, selectedName) {
  return importedName === '*' && selectedName ? selectedName : importedName;
}
