import ts from 'typescript';

import { LOGICAL_ASSIGNMENT_KINDS } from './feature-assignment-operators.mjs';
import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import {
  accessPath,
  latestPropertyWriteBefore,
  propertyPathWasOverwrittenAfter,
  staticOverwrittenPaths,
} from './feature-public-object-analysis.mjs';
import { publishedValueReferenceState } from './feature-public-value-flow-analysis.mjs';

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
  return key
    ? {
        key,
        logicalAssignment:
          ts.isBinaryExpression(current) &&
          target.path.length > 0 &&
          LOGICAL_ASSIGNMENT_KINDS.has(current.operatorToken.kind),
        path: [...target.path, ...valuePath],
        position: current.end,
      }
    : null;
}

function mutationValueExpressions(expression) {
  const current = unwrapExpression(expression);
  if (ts.isBinaryExpression(current) && ts.isAssignmentOperator(current.operatorToken.kind)) {
    return [current.right];
  }
  if (!ts.isCallExpression(current)) return [];
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text)
  ) {
    return [];
  }
  if (method.name === 'assign') return [...current.arguments].slice(1);
  if (['defineProperty', 'set'].includes(method.name)) {
    return [...current.arguments].slice(2);
  }
  return method.name === 'defineProperties' && current.arguments[1] ? [current.arguments[1]] : [];
}

function mutationPublishesScalarizedReference(expression, reference) {
  return mutationValueExpressions(expression).some(
    (value) =>
      containsReference(value, reference) &&
      publishedValueReferenceState(value, reference) === 'scalarized'
  );
}

function latestPathWrite(propertyWrites, key, path) {
  return latestPropertyWriteBefore(
    propertyWrites.get(key) ?? [],
    Number.POSITIVE_INFINITY,
    (write) =>
      write.path.length <= path.length &&
      write.path.every((segment, index) => segment === path[index])
  );
}

function writeContainsReference(write, reference) {
  return Boolean(
    write?.referenceRanges?.some(
      (range) => range.start <= reference.getStart() && reference.end <= range.end
    )
  );
}

function sourceWasMaterialized(propertyWrites, sourceKey) {
  return [...propertyWrites.values()].some((writes) =>
    writes.some((write) => write.originSourceKeys?.includes(sourceKey))
  );
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
    const valueState = publishedValueReferenceState(declaration.initializer, reference);
    if (valueState === 'scalarized') return false;
    const path = directObjectReferencePath(declaration.initializer, reference);
    if (!path) return true;
    const key = bindingModel.bindingAt(declaration.name.text, reference.getStart(sourceFile));
    if (
      key &&
      !publicBindingNames.has(declaration.name.text) &&
      !owners.has(declaration.name.text) &&
      sourceWasMaterialized(propertyWrites, key)
    ) {
      return false;
    }
    const latestWrite = key && latestPathWrite(propertyWrites, key, path);
    return latestWrite ? writeContainsReference(latestWrite, reference) : true;
  };
  owners.isMutationReferencePublic = (reference, expression) => {
    if (mutationPublishesScalarizedReference(expression, reference)) return false;
    const target = mutationReferencePath(expression, reference, bindingModel, sourceFile);
    if (target?.logicalAssignment) {
      return writeContainsReference(
        latestPathWrite(propertyWrites, target.key, target.path),
        reference
      );
    }
    if (capturedReferenceIsPublic?.(reference)) return true;
    if (target === false) return false;
    return (
      !target ||
      !propertyPathWasOverwrittenAfter(propertyWrites, target.key, target.path, target.position)
    );
  };
}
