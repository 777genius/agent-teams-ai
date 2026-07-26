import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-ast.mjs';
import { propertyPathWasOverwrittenAfter } from './feature-public-object-analysis.mjs';

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

export function attachPublicReferenceQueries(
  owners,
  {
    bindingModel,
    propertyWrites,
    referenceOwner,
    referenceOwnerForSelection,
    sourceFile,
  }
) {
  owners.ownerForReference = (reference, selection) =>
    selection
      ? referenceOwnerForSelection?.(reference, selection) ?? null
      : referenceOwner;
  owners.isReferencePublic = (reference, declaration) => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return true;
    const path = directObjectReferencePath(declaration.initializer, reference);
    if (!path) return true;
    const key = bindingModel.bindingAt(declaration.name.text, reference.getStart(sourceFile));
    return !key || !propertyPathWasOverwrittenAfter(
      propertyWrites,
      key,
      path,
      declaration.getStart(sourceFile)
    );
  };
}
