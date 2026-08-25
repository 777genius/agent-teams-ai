import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';
import { accessPath } from './feature-public-object-analysis.mjs';

export function snapshotExportSelection(expression, position) {
  const selected = accessPath(expression);
  return selected
    ? {
        name: selected.root,
        path: selected.path,
        position,
      }
    : null;
}

export function collectSnapshotMemberRelations(snapshotLocalExports, bindingModel) {
  return snapshotLocalExports.flatMap(({ name, path = [], position }) => {
    if (path.length === 0) return [];
    const sourceKey = bindingModel.bindingAt(name, position);
    return sourceKey
      ? [
          {
            copyPosition: position,
            owner: name,
            ownerKey: null,
            path,
            sourceKey,
            targetPath: [],
          },
        ]
      : [];
  });
}

export function snapshotInitializerPathAt(initializer, position, prefix = []) {
  const current = unwrapExpression(initializer);
  if (position < current.getStart() || position > current.end) return null;
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (position < property.getStart() || position > property.end) continue;
      if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isMethodDeclaration(property)
      ) {
        const path = [...prefix, propertyNameText(property.name)];
        const value = ts.isPropertyAssignment(property) ? property.initializer : property;
        return snapshotInitializerPathAt(value, position, path) ?? path;
      }
      return null;
    }
  }
  if (ts.isArrayLiteralExpression(current)) {
    for (const [index, element] of current.elements.entries()) {
      if (position < element.getStart() || position > element.end) continue;
      const path = [...prefix, String(index)];
      return snapshotInitializerPathAt(element, position, path) ?? path;
    }
  }
  return prefix;
}
