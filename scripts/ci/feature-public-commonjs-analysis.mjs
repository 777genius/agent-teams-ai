import ts from 'typescript';

import {
  commonJsExportPath,
  isCommonJsExportsObject,
  memberAccess,
  propertyNameText,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import {
  accessPath,
  propertyWriteAvailableAt,
  staticDescriptorIsConfigurable,
  staticDescriptorIsWritable,
  staticDescriptorMapProperties,
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

export function collectCommonJsRootAssignments(sourceFile) {
  const assignments = [];
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      return;
    }
    const kind = commonJsRootKind(node.left);
    if (kind) {
      assignments.push({
        expression: node.right,
        kind,
        node,
        position: node.getStart(sourceFile),
      });
    }
  });
  return assignments
    .sort((left, right) => {
      if (left.node.pos <= right.node.pos && right.node.end <= left.node.end) return 1;
      if (right.node.pos <= left.node.pos && left.node.end <= right.node.end) return -1;
      return left.position - right.position;
    })
    .map(({ expression, kind, position }, order) => ({
      expression,
      kind,
      order,
      position,
    }));
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

function literalPropertyPath(expression, reference) {
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

export function memberRelationIsAttachedAt(writes, relation, capturedAt, position) {
  return !(writes.get(relation.sourceKey) ?? []).some(
    (write) =>
      propertyWriteAvailableAt(write) > capturedAt &&
      propertyWriteAvailableAt(write) < position &&
      write.path.length <= relation.path.length &&
      write.path.every((segment, index) => segment === relation.path[index])
  );
}

export function commonJsRootWrapperSources(expression, bindingModel, beforePosition) {
  const collect = (value) => {
    const current = unwrapExpression(value);
    const source = accessPath(current);
    if (source) {
      const sourceKey = bindingModel.bindingAt(source.root, beforePosition);
      return sourceKey ? [{ path: source.path, sourceKey }] : [];
    }
    if (!ts.isCallExpression(current)) return [];
    const method = memberAccess(current.expression);
    if (!method || !ts.isIdentifier(method.receiver) || method.receiver.text !== 'Object') {
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
      collect(expression).map((source) => [`${source.sourceKey}:${source.path.join('.')}`, source])
    ).values(),
  ];
}

function literalAssignedProperties(expression, prefix = []) {
  const current = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) => {
      if (
        !property.name ||
        (!ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property) &&
          !ts.isMethodDeclaration(property) &&
          !ts.isGetAccessorDeclaration(property) &&
          !ts.isSetAccessorDeclaration(property))
      ) {
        return [];
      }
      const path = [...prefix, propertyNameText(property.name)];
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : null;
      return [
        {
          configurable: true,
          path,
          valueState: initializer ? staticValueState(initializer) : 'unknown',
          writable: true,
        },
        ...(initializer ? literalAssignedProperties(initializer, path) : []),
      ];
    });
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return [];
      const path = [...prefix, String(index)];
      return [
        {
          configurable: true,
          path,
          valueState: staticValueState(element),
          writable: true,
        },
        ...literalAssignedProperties(element, path),
      ];
    });
  }
  if (!ts.isCallExpression(current)) return [];
  const method = memberAccess(current.expression);
  if (!method || !ts.isIdentifier(method.receiver) || method.receiver.text !== 'Object') {
    return [];
  }
  if (method.name === 'assign') {
    return [...current.arguments]
      .slice(1)
      .flatMap((source) => literalAssignedProperties(source, prefix));
  }
  if (['freeze', 'preventExtensions', 'seal'].includes(method.name) && current.arguments[0]) {
    return literalAssignedProperties(current.arguments[0], prefix).map((property) => ({
      ...property,
      configurable: method.name === 'preventExtensions' ? property.configurable : false,
      writable: method.name === 'freeze' ? false : property.writable,
    }));
  }
  return [];
}

function staticValueState(expression) {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(current)) {
    return 'nullish';
  }
  if (current.kind === ts.SyntaxKind.FalseKeyword) return 'falsy';
  if (current.kind === ts.SyntaxKind.TrueKeyword) return 'truthy';
  if (ts.isNumericLiteral(current)) {
    return Number(current.text) === 0 ? 'falsy' : 'truthy';
  }
  if (ts.isStringLiteralLike(current)) {
    return current.text.length === 0 ? 'falsy' : 'truthy';
  }
  return ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isFunctionExpression(current) ||
    ts.isArrowFunction(current) ||
    ts.isClassExpression(current) ||
    ts.isNewExpression(current)
    ? 'truthy'
    : 'unknown';
}

function resolveTargetPaths(target, position, targetPathsAt) {
  const paths = targetPathsAt(target, position);
  if (paths === null || paths === undefined) return [];
  if (paths.length === 0) return [paths];
  return Array.isArray(paths[0]) ? paths : [paths];
}

export function collectFinalCommonJsPropertyWrites(sourceFile, targetPathsAt, bindingModel) {
  const writes = [];
  const propertyStates = new Map();
  const pathKey = (path) => JSON.stringify(path);
  const rootState = {
    configurable: true,
    path: [],
    writable: true,
  };
  propertyStates.set(pathKey([]), rootState);
  const replacePropertyState = (path, descriptor) => {
    const key = pathKey(path);
    for (const [candidateKey, state] of propertyStates) {
      if (
        state.path.length > path.length &&
        path.every((segment, index) => state.path[index] === segment)
      ) {
        propertyStates.delete(candidateKey);
      }
    }
    propertyStates.set(key, { ...descriptor, path });
  };
  const recordAssignment = (path, position, value) => {
    const current = propertyStates.get(pathKey(path));
    if (current?.writable === false) return;
    replacePropertyState(path, {
      configurable: current?.configurable ?? true,
      valueState: value ? staticValueState(value) : 'unknown',
      writable: current?.writable ?? true,
    });
    writes.push({ path, position });
  };
  const recordConditionalAssignment = (path, operator, position, value) => {
    const current = propertyStates.get(pathKey(path));
    const valueState = current?.valueState ?? 'nullish';
    const taken =
      (operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken && valueState === 'truthy') ||
      (operator === ts.SyntaxKind.BarBarEqualsToken && ['falsy', 'nullish'].includes(valueState)) ||
      (operator === ts.SyntaxKind.QuestionQuestionEqualsToken && valueState === 'nullish');
    if (taken) recordAssignment(path, position, value);
  };
  const recordDefinition = (path, position, descriptor) => {
    const current = propertyStates.get(pathKey(path));
    const requestedConfigurable = descriptor.configurable ?? current?.configurable ?? false;
    const requestedWritable = descriptor.writable ?? current?.writable ?? false;
    replacePropertyState(path, {
      configurable: current?.configurable === false ? false : requestedConfigurable,
      writable: current?.writable === false ? false : requestedWritable,
    });
    writes.push({ path, position });
  };
  const addPaths = (target, properties, position, definitions = false) => {
    for (const targetPath of resolveTargetPaths(target, position, targetPathsAt)) {
      for (const property of properties) {
        const path = Array.isArray(property) ? property : property.path;
        const publicPath = [...targetPath, ...path];
        if (definitions && !Array.isArray(property)) {
          recordDefinition(publicPath, position, property);
        } else {
          recordAssignment(publicPath, position);
        }
      }
    }
  };
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    const position = node.getStart(sourceFile);
    if (ts.isDeleteExpression(node)) {
      for (const targetPath of resolveTargetPaths(node.expression, position, targetPathsAt)) {
        const key = pathKey(targetPath);
        if (propertyStates.get(key)?.configurable === true) {
          writes.push({ path: targetPath, position: node.end });
          propertyStates.delete(key);
        }
      }
      return;
    }
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      for (const targetPath of resolveTargetPaths(node.left, position, targetPathsAt)) {
        if (targetPath.length > 0) {
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            recordAssignment(targetPath, node.end, node.right);
          } else if (
            [
              ts.SyntaxKind.AmpersandAmpersandEqualsToken,
              ts.SyntaxKind.BarBarEqualsToken,
              ts.SyntaxKind.QuestionQuestionEqualsToken,
            ].includes(node.operatorToken.kind)
          ) {
            recordConditionalAssignment(targetPath, node.operatorToken.kind, node.end, node.right);
          } else {
            recordAssignment(targetPath, node.end);
          }
        } else {
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
          const rootKind = commonJsRootKind(node.left);
          if (rootKind && assignmentLinksExports(rootKind, node.right)) {
            return;
          }
          propertyStates.clear();
          propertyStates.set(pathKey([]), rootState);
          const value = unwrapExpression(node.right);
          const method = ts.isCallExpression(value) && memberAccess(value.expression);
          const descriptorProperties =
            method &&
            ts.isIdentifier(method.receiver) &&
            method.receiver.text === 'Object' &&
            method.name === 'create' &&
            value.arguments[1]
              ? staticDescriptorMapProperties(value.arguments[1], bindingModel, position)
              : [];
          for (const property of descriptorProperties) {
            replacePropertyState(property.path, property);
          }
          const assignedProperties = [
            ...staticOverwrittenPaths([node.right], bindingModel, position).map((path) => ({
              configurable: true,
              path,
              valueState: 'unknown',
              writable: true,
            })),
            ...literalAssignedProperties(node.right),
          ];
          for (const property of new Map(
            assignedProperties.map((assignedProperty) => [
              pathKey(assignedProperty.path),
              assignedProperty,
            ])
          ).values()) {
            replacePropertyState(property.path, property);
          }
        }
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
    if (['freeze', 'seal'].includes(method.name) && node.arguments[0]) {
      for (const targetPath of resolveTargetPaths(node.arguments[0], position, targetPathsAt)) {
        for (const state of [...propertyStates.values()]) {
          if (
            state.path.length === targetPath.length + 1 &&
            targetPath.every((segment, index) => state.path[index] === segment)
          ) {
            propertyStates.set(pathKey(state.path), {
              ...state,
              configurable: false,
              writable: method.name === 'freeze' ? false : state.writable,
            });
          }
        }
      }
    } else if (method.name === 'assign') {
      addPaths(
        node.arguments[0],
        staticOverwrittenPaths([...node.arguments].slice(1), bindingModel, position),
        node.end
      );
    } else if (
      method.name === 'set' &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addPaths(node.arguments[0], [[unwrapExpression(node.arguments[1]).text]], node.end);
    } else if (
      method.name === 'defineProperty' &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addPaths(
        node.arguments[0],
        [
          {
            configurable: staticDescriptorIsConfigurable(node.arguments[2], bindingModel, position),
            path: [unwrapExpression(node.arguments[1]).text],
            writable: staticDescriptorIsWritable(node.arguments[2], bindingModel, position),
          },
        ],
        node.end,
        true
      );
    } else if (method.name === 'defineProperties' && node.arguments[1]) {
      addPaths(
        node.arguments[0],
        staticDescriptorMapProperties(node.arguments[1], bindingModel, position),
        node.end,
        true
      );
    }
  });
  return writes;
}

function objectAssignReferencePath(sources, reference, targetPaths, bindingModel, beforePosition) {
  const sourceIndex = sources.findIndex((source) => containsReference(source, reference));
  if (sourceIndex < 0) return null;
  const valuePath = literalPropertyPath(sources[sourceIndex], reference);
  if (
    valuePath === null ||
    pathIsOverwritten(
      valuePath,
      staticOverwrittenPaths(sources.slice(sourceIndex + 1), bindingModel, beforePosition)
    )
  ) {
    return valuePath === null ? null : false;
  }
  return targetPaths.map((targetPath) => [...targetPath, ...valuePath]);
}

function assignedReferencePath(expression, reference, bindingModel, targetPathAt) {
  const current = unwrapExpression(expression);
  if (ts.isBinaryExpression(current) && ts.isAssignmentOperator(current.operatorToken.kind)) {
    const targetPaths = resolveTargetPaths(current.left, current.getStart(), targetPathAt);
    if (targetPaths.length === 0) return null;
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
          targetPaths,
          bindingModel,
          current.getStart()
        );
      }
    }
    const valuePath = literalPropertyPath(current.right, reference);
    return valuePath === null
      ? null
      : targetPaths.map((targetPath) => [...targetPath, ...valuePath]);
  }
  if (!ts.isCallExpression(current) || !current.arguments[0]) return null;
  const method = memberAccess(current.expression);
  const targetPaths = resolveTargetPaths(current.arguments[0], current.getStart(), targetPathAt);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    targetPaths.length === 0
  ) {
    return null;
  }
  if (method.name === 'assign') {
    const sources = [...current.arguments].slice(1);
    return objectAssignReferencePath(
      sources,
      reference,
      targetPaths,
      bindingModel,
      current.getStart()
    );
  }
  if (
    ['defineProperty', 'set'].includes(method.name) &&
    current.arguments[1] &&
    ts.isStringLiteralLike(unwrapExpression(current.arguments[1]))
  ) {
    return targetPaths.map((targetPath) => [
      ...targetPath,
      unwrapExpression(current.arguments[1]).text,
    ]);
  }
  if (method.name === 'defineProperties' && current.arguments[1]) {
    const valuePath = literalPropertyPath(current.arguments[1], reference);
    return valuePath?.length
      ? targetPaths.map((targetPath) => [...targetPath, valuePath[0]])
      : null;
  }
  return null;
}

export function commonJsReferenceIsPublic(
  expression,
  reference,
  finalPropertyWrites,
  bindingModel,
  targetPathAt = (target) => commonJsExportPath(target)
) {
  const publicPaths = assignedReferencePath(expression, reference, bindingModel, targetPathAt);
  if (publicPaths === false) return false;
  return (
    publicPaths === null ||
    publicPaths.some(
      (publicPath) => !pathWasOverwrittenAfter(finalPropertyWrites, publicPath, expression.end)
    )
  );
}
