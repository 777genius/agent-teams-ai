import ts from 'typescript';

import {
  commonJsExportPath,
  isCommonJsExportsObject,
  memberAccess,
  propertyNameText,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import {
  accessPath,
  propertyWriteAvailableAt,
  staticDescriptorMapPaths,
  staticOverwrittenPaths,
} from './feature-public-object-analysis.mjs';

function containsReference(node, reference) {
  return node.pos <= reference.pos && reference.end <= node.end;
}

export function commonJsRootKind(expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current) && current.text === 'exports') return 'exports';
  const access = memberAccess(current);
  return access?.name === 'exports' &&
    ts.isIdentifier(access.receiver) &&
    access.receiver.text === 'module'
    ? 'module'
    : null;
}

function assignmentLinksExports(kind, expression) {
  const current = unwrapExpression(expression);
  const opposite = kind === 'module' ? 'exports' : 'module';
  if (commonJsRootKind(current) === opposite) return true;
  if (
    kind === 'exports' &&
    isCommonJsExportsObject(current) &&
    rootBindingName(current) === 'module'
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    commonJsRootKind(current.left) === opposite
  );
}

export function createExportsState(rootAssignments) {
  return (position) => {
    let active = true;
    for (const assignment of rootAssignments) {
      if (assignment.position >= position) break;
      active = assignmentLinksExports(assignment.kind, assignment.expression);
    }
    return active;
  };
}

export function lastCommonJsRootReplacement(rootAssignments, exportsActiveAt) {
  return (
    [...rootAssignments].reverse().find((assignment) => {
      if (assignment.kind !== 'module') return false;
      const value = unwrapExpression(assignment.expression);
      if (commonJsRootKind(value) === 'module') return false;
      return !(commonJsRootKind(value) === 'exports' && exportsActiveAt(assignment.position));
    }) ?? null
  );
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

export function memberRelationIsAttachedAt(
  writes,
  relation,
  capturedAt,
  position
) {
  return !(writes.get(relation.sourceKey) ?? []).some(
    (write) =>
      propertyWriteAvailableAt(write) > capturedAt &&
      propertyWriteAvailableAt(write) < position &&
      write.path.length <= relation.path.length &&
      write.path.every((segment, index) => segment === relation.path[index])
  );
}

export function commonJsRootWrapperSources(
  expression,
  bindingModel,
  beforePosition
) {
  const collect = (value) => {
    const current = unwrapExpression(value);
    const source = accessPath(current);
    if (source) {
      const sourceKey = bindingModel.bindingAt(source.root, beforePosition);
      return sourceKey ? [{ path: source.path, sourceKey }] : [];
    }
    if (!ts.isCallExpression(current)) return [];
    const method = memberAccess(current.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      method.receiver.text !== 'Object'
    ) {
      return [];
    }
    if (['create', 'freeze', 'preventExtensions', 'seal'].includes(method.name)) {
      return current.arguments[0] ? collect(current.arguments[0]) : [];
    }
    return method.name === 'setPrototypeOf'
      ? [...current.arguments].slice(0, 2).flatMap(collect)
      : [];
  };
  return [
    ...new Map(
      collect(expression).map((source) => [
        `${source.sourceKey}:${source.path.join('.')}`,
        source,
      ])
    ).values(),
  ];
}

export function collectFinalCommonJsPropertyWrites(
  sourceFile,
  targetIsActive,
  bindingModel
) {
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
        staticOverwrittenPaths(
          [...node.arguments].slice(1),
          bindingModel,
          position
        ),
        node.end
      );
    } else if (
      ['defineProperty', 'set'].includes(method.name) &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addPaths(node.arguments[0], [[unwrapExpression(node.arguments[1]).text]], node.end);
    } else if (method.name === 'defineProperties' && node.arguments[1]) {
      addPaths(
        node.arguments[0],
        staticDescriptorMapPaths(
          node.arguments[1],
          bindingModel,
          position
        ),
        node.end
      );
    }
  });
  return writes;
}

function objectAssignReferencePath(
  sources,
  reference,
  targetPath,
  bindingModel,
  beforePosition
) {
  const sourceIndex = sources.findIndex((source) => containsReference(source, reference));
  if (sourceIndex < 0) return null;
  const valuePath = literalPropertyPath(sources[sourceIndex], reference);
  if (
    valuePath === null ||
    pathIsOverwritten(
      valuePath,
      staticOverwrittenPaths(
        sources.slice(sourceIndex + 1),
        bindingModel,
        beforePosition
      )
    )
  ) {
    return valuePath === null ? null : false;
  }
  return [...targetPath, ...valuePath];
}

function assignedReferencePath(expression, reference, bindingModel) {
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
          targetPath,
          bindingModel,
          current.getStart()
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
    return objectAssignReferencePath(
      sources,
      reference,
      targetPath,
      bindingModel,
      current.getStart()
    );
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
  finalPropertyWrites,
  bindingModel
) {
  const publicPath = assignedReferencePath(
    expression,
    reference,
    bindingModel
  );
  if (publicPath === false) return false;
  return (
    publicPath === null ||
    !pathWasOverwrittenAfter(finalPropertyWrites, publicPath, expression.end)
  );
}
