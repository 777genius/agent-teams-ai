import ts from 'typescript';

import { memberAccess, propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';
import { resolveObjectLiterals as resolveObjectLiteralBindings } from './feature-object-resolution.mjs';
import { accessPath, bindingAliasTargets } from './feature-public-access-path.mjs';
import {
  descriptorBooleanSetting,
  descriptorDefinesValue,
  descriptorIsEnumerable,
  resolveDescriptorMapEntries,
  staticDescriptorIsConfigurable,
  staticDescriptorIsWritable,
  staticDescriptorMapProperties,
} from './feature-public-descriptor-state.mjs';
import {
  LOGICAL_ASSIGNMENT_KINDS,
  collectOrdinaryPropertyDefinitions,
  createPublicObjectState,
  staticPublicValueState,
} from './feature-public-object-state.mjs';

export { accessPath };
export {
  staticDescriptorIsConfigurable,
  staticDescriptorIsWritable,
  staticDescriptorMapProperties,
};

export function propertyWriteAvailableAt(write) {
  return write.availableAt ?? write.position;
}

export function comparePropertyWriteOrder(left, right) {
  const availabilityDelta = propertyWriteAvailableAt(left) - propertyWriteAvailableAt(right);
  if (availabilityDelta !== 0) return availabilityDelta;
  const leftOrder = left.availabilityOrder ?? [left.position];
  const rightOrder = right.availabilityOrder ?? [right.position];
  for (let index = 0; index < Math.max(leftOrder.length, rightOrder.length); index++) {
    const orderDelta = (leftOrder[index] ?? -1) - (rightOrder[index] ?? -1);
    if (orderDelta !== 0) return orderDelta;
  }
  return left.position - right.position;
}

export function latestPropertyWriteBefore(writes, beforePosition, predicate) {
  return writes
    .filter((write) => propertyWriteAvailableAt(write) < beforePosition && predicate(write))
    .sort((left, right) => comparePropertyWriteOrder(right, left))[0];
}

export function propertyWriteWasOverwrittenBefore(writes, sourceWrite, beforePosition) {
  return writes.some(
    (write) =>
      comparePropertyWriteOrder(write, sourceWrite) > 0 &&
      propertyWriteAvailableAt(write) < beforePosition &&
      write.path.length <= sourceWrite.path.length &&
      write.path.every((segment, index) => segment === sourceWrite.path[index])
  );
}

export function propertyPathWasOverwrittenAfter(writes, source, path, afterPosition) {
  return (writes.get(source) ?? []).some(
    (write) =>
      propertyWriteAvailableAt(write) > afterPosition &&
      write.path.length <= path.length &&
      write.path.every((segment, index) => segment === path[index])
  );
}

function resolveObjectLiterals(expression, bindingModel, beforePosition) {
  return resolveObjectLiteralBindings(expression, beforePosition, (name, position) => {
    const key = bindingModel.bindingAt(name, position);
    if (!key) return null;
    const binding = bindingModel.versions.get(key);
    return binding
      ? {
          beforePosition: binding.position,
          expression: binding.initializer,
          key,
        }
      : null;
  });
}

export function collectTopLevelPropertyWrites(sourceFile, bindingModel, identityAliases = []) {
  const writes = new Map();
  const objectState = createPublicObjectState();
  const lockedPrefixes = [];
  const frozenPrefixes = [];
  const aliasNeighbors = new Map();
  for (const [left, right] of identityAliases) {
    const leftNeighbors = aliasNeighbors.get(left) ?? new Set();
    const rightNeighbors = aliasNeighbors.get(right) ?? new Set();
    leftNeighbors.add(right);
    rightNeighbors.add(left);
    aliasNeighbors.set(left, leftNeighbors);
    aliasNeighbors.set(right, rightNeighbors);
  }
  const equivalentSourceKeys = (sourceKey) => {
    const keys = new Set([sourceKey]);
    const queue = [sourceKey];
    while (queue.length > 0) {
      for (const neighbor of aliasNeighbors.get(queue.shift()) ?? []) {
        if (!keys.has(neighbor)) {
          keys.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return keys;
  };
  const stateCopyRelations = collectCopyRelations(sourceFile, bindingModel)
    .map((relation, order) => ({ ...relation, order }))
    .sort((left, right) => left.copyPosition - right.copyPosition || left.order - right.order);
  let stateCopyIndex = 0;
  const applyCopiesBefore = (position) => {
    while (
      stateCopyIndex < stateCopyRelations.length &&
      stateCopyRelations[stateCopyIndex].copyPosition < position
    ) {
      objectState.applyCopyRelation(stateCopyRelations[stateCopyIndex++], equivalentSourceKeys);
    }
  };
  const addWrite = ({
    availabilityOrder,
    accessorKind,
    availableAt,
    configurable,
    definition = false,
    end,
    enumerable = true,
    logicalOperator,
    path,
    position,
    referenceNodes,
    referenceRanges,
    recordsValue = true,
    removed = false,
    sourceKey,
    valueState = 'unknown',
    writable,
  }) => {
    if (!sourceKey || path.length === 0) return;
    const locked = lockedPrefixes.some(
      ({ path: prefix, sourceKey: lockedSource }) =>
        lockedSource === sourceKey &&
        path.length === prefix.length + 1 &&
        prefix.every((segment, index) => path[index] === segment)
    );
    const frozen = frozenPrefixes.some(
      ({ path: prefix, sourceKey: frozenSource }) =>
        frozenSource === sourceKey &&
        path.length === prefix.length + 1 &&
        prefix.every((segment, index) => path[index] === segment)
    );
    const ranges = [
      ...(referenceRanges ?? []),
      ...(referenceNodes ?? []).map((node) => ({
        end: node.end,
        start: node.getStart(sourceFile),
      })),
    ];
    const stateResult = objectState.applyWrite({
      accessorKind,
      configurable,
      definition,
      enumerable,
      frozen,
      locked,
      logicalOperator,
      path,
      recordsValue,
      referenceRanges: ranges,
      removed,
      sourceKey,
      valueState,
      writable,
    });
    if (!stateResult.recordsWrite) return;
    const rootWrites = writes.get(sourceKey) ?? [];
    rootWrites.push({
      availabilityOrder,
      availableAt,
      end,
      enumerable: stateResult.enumerable,
      path,
      position,
      referenceRanges: stateResult.referenceRanges,
    });
    writes.set(sourceKey, rootWrites);
  };
  const addTargetWrite = (
    targetExpression,
    node,
    suffix = [],
    enumerable = true,
    referenceNodes = [node],
    options = {}
  ) => {
    for (const target of bindingAliasTargets(
      targetExpression,
      node.getStart(sourceFile),
      bindingModel
    )) {
      addWrite({
        ...options,
        end: node.end,
        enumerable,
        path: [...target.path, ...suffix],
        position: node.getStart(sourceFile),
        referenceNodes,
        sourceKey: target.sourceKey,
      });
    }
  };
  const addDescriptorMapWrites = (targetExpression, mapExpression, node) => {
    for (const entry of resolveDescriptorMapEntries(
      mapExpression,
      bindingModel,
      node.getStart(sourceFile)
    )) {
      for (const descriptor of resolveObjectLiterals(
        entry.expression,
        bindingModel,
        node.getStart(sourceFile)
      )) {
        addTargetWrite(
          targetExpression,
          node,
          [entry.name],
          descriptorIsEnumerable(descriptor, bindingModel, node.getStart(sourceFile)),
          [...entry.references, descriptor],
          {
            configurable: descriptorBooleanSetting(
              descriptor,
              'configurable',
              bindingModel,
              node.getStart(sourceFile)
            ),
            definition: true,
            recordsValue: descriptorDefinesValue(descriptor),
            writable: descriptorBooleanSetting(
              descriptor,
              'writable',
              bindingModel,
              node.getStart(sourceFile)
            ),
          }
        );
      }
    }
  };
  for (const [sourceKey, binding] of bindingModel.versions) {
    for (const definition of collectOrdinaryPropertyDefinitions(binding.initializer)) {
      addWrite({
        ...definition,
        availabilityOrder: [definition.position],
        availableAt: binding.position,
        definition: true,
        position: binding.position,
        sourceKey,
      });
    }
  }
  const visit = (node) => {
    applyCopiesBefore(node.getStart(sourceFile));
    if (ts.isDeleteExpression(node)) {
      addTargetWrite(node.expression, node, [], true, [node], { removed: true });
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        LOGICAL_ASSIGNMENT_KINDS.has(node.operatorToken.kind))
    ) {
      const target = accessPath(node.left);
      if (target?.path.length) {
        addTargetWrite(node.left, node, [], true, [node.right], {
          logicalOperator:
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? undefined
              : node.operatorToken.kind,
          valueState: staticPublicValueState(node.right),
        });
      }
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      !['Object', 'Reflect'].includes(method.receiver.text) ||
      !isUnshadowedGlobalValueReference(method.receiver)
    ) {
      return;
    }
    if (
      method.name === 'defineProperty' &&
      node.arguments[0] &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      const propertyName = unwrapExpression(node.arguments[1]).text;
      const descriptors = resolveObjectLiterals(
        node.arguments[2],
        bindingModel,
        node.getStart(sourceFile)
      );
      if (descriptors.length === 0) {
        addTargetWrite(node.arguments[0], node, [propertyName], false);
      }
      for (const descriptor of descriptors) {
        addTargetWrite(
          node.arguments[0],
          node,
          [propertyName],
          descriptorIsEnumerable(descriptor, bindingModel, node.getStart(sourceFile)),
          [node.arguments[2], descriptor].filter(Boolean),
          {
            configurable: descriptorBooleanSetting(
              descriptor,
              'configurable',
              bindingModel,
              node.getStart(sourceFile)
            ),
            definition: true,
            recordsValue: descriptorDefinesValue(descriptor),
            writable: descriptorBooleanSetting(
              descriptor,
              'writable',
              bindingModel,
              node.getStart(sourceFile)
            ),
          }
        );
      }
    } else if (method.name === 'defineProperties' && node.arguments[0] && node.arguments[1]) {
      addDescriptorMapWrites(node.arguments[0], node.arguments[1], node);
    } else if (['freeze', 'seal'].includes(method.name) && node.arguments[0]) {
      for (const target of bindingAliasTargets(
        node.arguments[0],
        node.getStart(sourceFile),
        bindingModel
      )) {
        for (const sourceKey of equivalentSourceKeys(target.sourceKey)) {
          const aliasedTarget = { ...target, sourceKey };
          lockedPrefixes.push(aliasedTarget);
          if (method.name === 'freeze') {
            frozenPrefixes.push(aliasedTarget);
          }
        }
      }
    } else if (
      method.name === 'deleteProperty' &&
      node.arguments[0] &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addTargetWrite(
        node.arguments[0],
        node,
        [unwrapExpression(node.arguments[1]).text],
        true,
        [node],
        { removed: true }
      );
    } else if (
      method.name === 'set' &&
      node.arguments[0] &&
      node.arguments[1] &&
      ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
    ) {
      addTargetWrite(node.arguments[0], node, [unwrapExpression(node.arguments[1]).text]);
    } else if (method.name === 'assign' && node.arguments[0]) {
      for (const path of staticOverwrittenPaths(
        [...node.arguments].slice(1),
        bindingModel,
        node.getStart(sourceFile)
      )) {
        addTargetWrite(node.arguments[0], node, path);
      }
    }
  };
  visitDefiniteTopLevelExpressions(sourceFile, visit);

  for (const [sourceKey, binding] of bindingModel.versions) {
    const initializer = unwrapExpression(binding.initializer);
    if (!ts.isCallExpression(initializer)) continue;
    const method = memberAccess(initializer.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      isUnshadowedGlobalValueReference(method.receiver) &&
      method.name === 'create' &&
      initializer.arguments[1]
    ) {
      for (const entry of resolveDescriptorMapEntries(
        initializer.arguments[1],
        bindingModel,
        initializer.getStart(sourceFile)
      )) {
        for (const descriptor of resolveObjectLiterals(
          entry.expression,
          bindingModel,
          initializer.getStart(sourceFile)
        )) {
          addWrite({
            configurable: descriptorBooleanSetting(
              descriptor,
              'configurable',
              bindingModel,
              initializer.getStart(sourceFile)
            ),
            definition: true,
            end: initializer.end,
            enumerable: descriptorIsEnumerable(
              descriptor,
              bindingModel,
              initializer.getStart(sourceFile)
            ),
            path: [entry.name],
            position: initializer.getStart(sourceFile),
            referenceNodes: [...entry.references, descriptor],
            sourceKey,
            writable: descriptorBooleanSetting(
              descriptor,
              'writable',
              bindingModel,
              initializer.getStart(sourceFile)
            ),
          });
        }
      }
    }
  }
  return writes;
}

export function staticOverwrittenPaths(
  expressions,
  bindingModel,
  beforePosition = Number.POSITIVE_INFINITY
) {
  const paths = [];
  const collectProperties = (object, visited) => {
    const objectKey = `${object.pos}:${object.end}`;
    if (visited.has(objectKey)) return [];
    const properties = new Map();
    const nextVisited = new Set(visited).add(objectKey);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadObjects = bindingModel
          ? resolveObjectLiterals(property.expression, bindingModel, beforePosition)
          : [];
        for (const spreadObject of spreadObjects) {
          for (const spreadProperty of collectProperties(spreadObject, nextVisited)) {
            properties.set(spreadProperty, spreadProperty);
          }
        }
      } else if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        const name = propertyNameText(property.name);
        properties.set(name, name);
      }
    }
    return [...properties.values()];
  };
  for (const expression of expressions) {
    const current = unwrapExpression(expression);
    const objects = bindingModel
      ? resolveObjectLiterals(current, bindingModel, beforePosition)
      : ts.isObjectLiteralExpression(current)
        ? [current]
        : [];
    for (const object of objects) {
      paths.push(...collectProperties(object, new Set()).map((name) => [name]));
    }
  }
  return paths;
}

export function staticDescriptorMapPaths(expression, bindingModel, beforePosition) {
  return resolveDescriptorMapEntries(expression, bindingModel, beforePosition).map(({ name }) => [
    name,
  ]);
}

export function staticOverwrittenPropertyPaths(
  properties,
  bindingModel,
  beforePosition = Number.POSITIVE_INFINITY
) {
  return properties.flatMap((property) =>
    ts.isSpreadAssignment(property)
      ? staticOverwrittenPaths([property.expression], bindingModel, beforePosition)
      : ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        ? [[propertyNameText(property.name)]]
        : []
  );
}

export function copiedPropertyPath(relation, sourcePath) {
  return [...(relation.targetPath ?? []), ...sourcePath.slice(relation.path.length)];
}

function addCopySources(relations, ownerKey, targetPath, callOrLiteral, sources, bindingModel) {
  for (const [index, sourceExpression] of sources.entries()) {
    const source = accessPath(sourceExpression);
    const sourceKey = source && bindingModel.bindingAt(source.root, sourceExpression.getStart());
    if (!sourceKey) continue;
    relations.push({
      copyKind: 'assign',
      copyPosition: callOrLiteral.end,
      overwrittenPaths: staticOverwrittenPaths(
        sources.slice(index + 1),
        bindingModel,
        callOrLiteral.getStart()
      ),
      ownerKey,
      path: source.path,
      sourceKey,
      targetPath,
    });
  }
}

export function collectCopyRelations(sourceFile, bindingModel) {
  const relations = [];
  const collectFromInitializer = (expression, ownerKey, targetPath = []) => {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current)) {
      const properties = [...current.properties];
      for (const [index, property] of properties.entries()) {
        if (ts.isSpreadAssignment(property)) {
          const source = accessPath(property.expression);
          const sourceKey =
            source && bindingModel.bindingAt(source.root, property.getStart(sourceFile));
          if (sourceKey) {
            relations.push({
              copyKind: 'spread',
              copyPosition: current.end,
              overwrittenPaths: staticOverwrittenPropertyPaths(
                properties.slice(index + 1),
                bindingModel,
                current.getStart(sourceFile)
              ),
              ownerKey,
              path: source.path,
              sourceKey,
              targetPath,
            });
          }
        } else if (ts.isPropertyAssignment(property)) {
          collectFromInitializer(property.initializer, ownerKey, [
            ...targetPath,
            propertyNameText(property.name),
          ]);
        }
      }
      return;
    }
    if (!ts.isCallExpression(current)) return;
    const method = memberAccess(current.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      isUnshadowedGlobalValueReference(method.receiver) &&
      method.name === 'assign'
    ) {
      addCopySources(
        relations,
        ownerKey,
        targetPath,
        current,
        [...current.arguments].slice(1),
        bindingModel
      );
    }
  };
  for (const [ownerKey, binding] of bindingModel.versions) {
    collectFromInitializer(binding.initializer, ownerKey);
  }
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      method.receiver.text !== 'Object' ||
      !isUnshadowedGlobalValueReference(method.receiver) ||
      method.name !== 'assign' ||
      !node.arguments[0]
    ) {
      return;
    }
    const target = accessPath(node.arguments[0]);
    const ownerKey = target && bindingModel.bindingAt(target.root, node.getStart(sourceFile));
    if (ownerKey) {
      addCopySources(
        relations,
        ownerKey,
        target.path,
        node,
        [...node.arguments].slice(1),
        bindingModel
      );
    }
  });
  return relations;
}

export function materializeCopyRelationWrites(propertyWrites, relations) {
  const writeKey = (sourceKey, write) =>
    JSON.stringify([
      sourceKey,
      write.availableAt,
      write.availabilityOrder,
      write.position,
      write.path,
      write.originSourceKeys ?? [],
      write.referenceRanges ?? [],
    ]);
  const known = new Set(
    [...propertyWrites].flatMap(([sourceKey, writes]) =>
      writes.map((write) => writeKey(sourceKey, write))
    )
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [relationOrder, relation] of relations.entries()) {
      const ownerWrites = propertyWrites.get(relation.ownerKey) ?? [];
      const sourceWrites = propertyWrites.get(relation.sourceKey) ?? [];
      for (const sourceWrite of sourceWrites) {
        const overwrittenBeforeCopy = propertyWriteWasOverwrittenBefore(
          sourceWrites,
          sourceWrite,
          relation.copyPosition
        );
        if (
          propertyWriteAvailableAt(sourceWrite) >= relation.copyPosition ||
          !sourceWrite.enumerable ||
          overwrittenBeforeCopy ||
          !relation.path.every((segment, index) => sourceWrite.path[index] === segment)
        ) {
          continue;
        }
        const sourceRelativePath = sourceWrite.path.slice(relation.path.length);
        if (
          relation.overwrittenPaths.some((overwrittenPath) =>
            overwrittenPath.every((segment, index) => sourceRelativePath[index] === segment)
          )
        ) {
          continue;
        }
        const copiedWrite = {
          ...sourceWrite,
          // References keep their original AST positions; visibility starts at the copy.
          availableAt: relation.copyPosition,
          availabilityOrder: [
            relationOrder,
            ...(sourceWrite.availabilityOrder ?? [sourceWrite.position]),
          ],
          originSourceKeys: [
            ...new Set([...(sourceWrite.originSourceKeys ?? []), relation.sourceKey]),
          ],
          path: copiedPropertyPath(relation, sourceWrite.path),
        };
        const key = writeKey(relation.ownerKey, copiedWrite);
        if (known.has(key)) continue;
        known.add(key);
        ownerWrites.push(copiedWrite);
        changed = true;
      }
      if (ownerWrites.length > 0) {
        ownerWrites.sort(comparePropertyWriteOrder);
        propertyWrites.set(relation.ownerKey, ownerWrites);
      }
    }
  }
  return propertyWrites;
}

export function collectPrototypeRelations(sourceFile, bindingModel) {
  const relations = [];
  const addRelation = (node, ownerKey) => {
    if (!ts.isCallExpression(node) || !ownerKey) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      method.receiver.text !== 'Object' ||
      !isUnshadowedGlobalValueReference(method.receiver) ||
      method.name !== 'setPrototypeOf'
    ) {
      return;
    }
    const prototype = node.arguments[1] && accessPath(node.arguments[1]);
    const sourceKey =
      prototype && bindingModel.bindingAt(prototype.root, node.getStart(sourceFile));
    if (sourceKey) {
      relations.push({ ownerKey, path: prototype.path, sourceKey });
    }
  };
  for (const [ownerKey, binding] of bindingModel.versions) {
    addRelation(unwrapExpression(binding.initializer), ownerKey);
  }
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !node.arguments[0]) return;
    const target = accessPath(node.arguments[0]);
    addRelation(node, target && bindingModel.bindingAt(target.root, node.getStart(sourceFile)));
  });
  return relations;
}
