import ts from 'typescript';

import {
  commonJsExportPath,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import {
  staticOverwrittenPaths,
  staticOverwrittenPropertyPaths,
} from './feature-public-object-analysis.mjs';

function containsReference(node, reference) {
  return node.pos <= reference.pos && reference.end <= node.end;
}

function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  const visitExpression = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    visitor(node);
    ts.forEachChild(node, visitExpression);
  };
  const visitStatement = (statement) => {
    if (ts.isExpressionStatement(statement)) {
      visitExpression(statement.expression);
    } else if (ts.isBlock(statement)) {
      for (const child of statement.statements) visitStatement(child);
    } else if (
      ts.isIfStatement(statement) &&
      statement.expression.kind === ts.SyntaxKind.TrueKeyword
    ) {
      visitStatement(statement.thenStatement);
    }
  };
  for (const statement of sourceFile.statements) visitStatement(statement);
}

function literalPropertyPath(expression, reference) {
  if (!containsReference(expression, reference)) return null;
  const path = [];
  let current = reference;
  while (current !== expression) {
    const parent = current.parent;
    if (!parent || !containsReference(parent, reference)) return null;
    if (
      ts.isPropertyAssignment(parent) &&
      containsReference(parent.initializer, reference)
    ) {
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

function pathIsOverwritten(path, overwrittenPaths) {
  return overwrittenPaths.some(
    (overwritten) =>
      overwritten.length <= path.length &&
      overwritten.every((segment, index) => segment === path[index])
  );
}

export function pathWasOverwrittenAfter(writes, path, position) {
  return writes.some(
    (write) =>
      write.position > position &&
      write.path.length <= path.length &&
      write.path.every((segment, index) => segment === path[index])
  );
}

export function collectFinalCommonJsPropertyWrites(sourceFile, targetIsActive) {
  const writes = [];
  const addPaths = (target, paths, position) => {
    const targetPath = commonJsExportPath(target);
    if (targetPath === null || !targetIsActive(target, position)) return;
    for (const path of paths) {
      writes.push({ path: [...targetPath, ...path], position });
    }
  };
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    const position = node.getStart(sourceFile);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const targetPath = commonJsExportPath(node.left);
      if (targetPath?.length && targetIsActive(node.left, position)) {
        writes.push({ path: targetPath, position: node.end });
      }
      return;
    }
    if (!ts.isCallExpression(node) || !node.arguments[0]) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      !['Object', 'Reflect'].includes(method.receiver.text)
    ) {
      return;
    }
    if (method.name === 'assign') {
      addPaths(
        node.arguments[0],
        staticOverwrittenPaths([...node.arguments].slice(1)),
        node.end
      );
    } else if (
      ['defineProperty', 'set'].includes(method.name) &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addPaths(node.arguments[0], [[unwrapExpression(node.arguments[1]).text]], node.end);
    } else if (method.name === 'defineProperties' && node.arguments[1]) {
      const descriptors = unwrapExpression(node.arguments[1]);
      if (ts.isObjectLiteralExpression(descriptors)) {
        addPaths(
          node.arguments[0],
          staticOverwrittenPropertyPaths([...descriptors.properties]),
          node.end
        );
      }
    }
  });
  return writes;
}

function objectAssignReferencePath(sources, reference, targetPath) {
  const sourceIndex = sources.findIndex((source) => containsReference(source, reference));
  if (sourceIndex < 0) return null;
  const valuePath = literalPropertyPath(sources[sourceIndex], reference);
  if (
    valuePath === null ||
    pathIsOverwritten(valuePath, staticOverwrittenPaths(sources.slice(sourceIndex + 1)))
  ) {
    return valuePath === null ? null : false;
  }
  return [...targetPath, ...valuePath];
}

function assignedReferencePath(expression, reference) {
  const current = unwrapExpression(expression);
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const targetPath = commonJsExportPath(current.left);
    if (targetPath === null) return null;
    const value = unwrapExpression(current.right);
    if (ts.isCallExpression(value)) {
      const method = memberAccess(value.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'assign'
      ) {
        return objectAssignReferencePath(
          [...value.arguments],
          reference,
          targetPath
        );
      }
    }
    const valuePath = literalPropertyPath(current.right, reference);
    return valuePath === null ? null : [...targetPath, ...valuePath];
  }
  if (!ts.isCallExpression(current) || !current.arguments[0]) return null;
  const method = memberAccess(current.expression);
  const targetPath = commonJsExportPath(current.arguments[0]);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    targetPath === null
  ) {
    return null;
  }
  if (method.name === 'assign') {
    const sources = [...current.arguments].slice(1);
    return objectAssignReferencePath(sources, reference, targetPath);
  }
  if (
    ['defineProperty', 'set'].includes(method.name) &&
    current.arguments[1] &&
    ts.isStringLiteralLike(unwrapExpression(current.arguments[1]))
  ) {
    return [...targetPath, unwrapExpression(current.arguments[1]).text];
  }
  if (method.name === 'defineProperties' && current.arguments[1]) {
    const valuePath = literalPropertyPath(current.arguments[1], reference);
    return valuePath?.length ? [...targetPath, valuePath[0]] : null;
  }
  return null;
}

export function commonJsReferenceIsPublic(
  expression,
  reference,
  finalPropertyWrites
) {
  const publicPath = assignedReferencePath(expression, reference);
  if (publicPath === false) return false;
  return (
    publicPath === null ||
    !pathWasOverwrittenAfter(finalPropertyWrites, publicPath, expression.end)
  );
}
