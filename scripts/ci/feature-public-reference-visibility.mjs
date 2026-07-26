import ts from 'typescript';

import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import {
  accessPath,
  propertyPathWasOverwrittenAfter,
  staticOverwrittenPaths,
} from './feature-public-object-analysis.mjs';

function directObjectReferencePath(initializer, reference) {
  const object = unwrapExpression(initializer);
  if (
    !ts.isObjectLiteralExpression(object) ||
    reference.pos < object.pos ||
    reference.end > object.end
  ) {
    return null;
  }
  const path = [];
  let current = reference;
  while (current && current !== object) {
    const parent = current.parent;
    if (!parent || reference.pos < parent.pos || reference.end > parent.end) return null;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.name
    ) {
      path.unshift(propertyNameText(parent.name));
    } else if (ts.isSpreadAssignment(parent)) {
      return null;
    }
    current = parent;
  }
  return current === object && path.length > 0 ? path : null;
}

function literalReferencePath(expression, reference) {
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
    } else if (ts.isSpreadAssignment(parent)) {
      return null;
    }
    current = parent;
  }
  return path;
}

function mutationReferencePath(expression, reference, bindingModel, sourceFile) {
  const current = unwrapExpression(expression);
  let target;
  let valuePath;
  if (ts.isBinaryExpression(current) && ts.isAssignmentOperator(current.operatorToken.kind)) {
    target = accessPath(current.left);
    valuePath = literalReferencePath(current.right, reference);
  } else if (ts.isCallExpression(current)) {
    const method = memberAccess(current.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      !['Object', 'Reflect'].includes(method.receiver.text) ||
      !current.arguments[0]
    ) {
      return null;
    }
    target = accessPath(current.arguments[0]);
    if (method.name === 'assign') {
      const sources = [...current.arguments].slice(1);
      const sourceIndex = sources.findIndex((source) => containsReference(source, reference));
      if (sourceIndex < 0) return null;
      valuePath = literalReferencePath(sources[sourceIndex], reference);
      if (
        valuePath &&
        staticOverwrittenPaths(
          sources.slice(sourceIndex + 1),
          bindingModel,
          current.getStart(sourceFile)
        ).some(
          (path) =>
            path.length <= valuePath.length &&
            path.every((segment, index) => segment === valuePath[index])
        )
      ) {
        return false;
      }
    } else if (
      ['defineProperty', 'set'].includes(method.name) &&
      current.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(current.arguments[1])) &&
      current.arguments.some(
        (argument, index) => index >= 2 && containsReference(argument, reference)
      )
    ) {
      valuePath = [unwrapExpression(current.arguments[1]).text];
    } else if (
      method.name === 'defineProperties' &&
      current.arguments[1] &&
      containsReference(current.arguments[1], reference)
    ) {
      const descriptorPath = literalReferencePath(current.arguments[1], reference);
      valuePath = descriptorPath?.length ? [descriptorPath[0]] : null;
    } else {
      return null;
    }
  }
  if (!target || valuePath === null || valuePath === undefined) return null;
  const position = current.getStart(sourceFile);
  const key = bindingModel.bindingAt(target.root, position);
  return key ? { key, path: [...target.path, ...valuePath], position: current.end } : null;
}

export function attachPublicReferenceQueries(
  owners,
  {
    bindingModel,
    capturedReferenceIsPublic,
    publicBindingNames,
    propertyWrites,
    referenceOwner,
    referenceOwnerForSelection,
    sourceFile,
  }
) {
  owners.ownerForReference = (reference, selection) =>
    selection ? (referenceOwnerForSelection?.(reference, selection) ?? null) : referenceOwner;
  owners.isBindingVersionPublic = (declaration) =>
    !ts.isIdentifier(declaration.name) ||
    !publicBindingNames.has(declaration.name.text) ||
    owners.has(declaration.name.text);
  owners.isReferencePublic = (reference, declaration) => {
    if (capturedReferenceIsPublic?.(reference)) return true;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return true;
    const path = directObjectReferencePath(declaration.initializer, reference);
    if (!path) return true;
    const key = bindingModel.bindingAt(declaration.name.text, reference.getStart(sourceFile));
    return !propertyPathWasOverwrittenAfter(
      propertyWrites,
      key,
      path,
      declaration.getStart(sourceFile)
    );
  };
  owners.isMutationReferencePublic = (reference, expression) => {
    if (capturedReferenceIsPublic?.(reference)) return true;
    const target = mutationReferencePath(expression, reference, bindingModel, sourceFile);
    if (target === false) return false;
    return (
      !target ||
      !propertyPathWasOverwrittenAfter(propertyWrites, target.key, target.path, target.position)
    );
  };
}
