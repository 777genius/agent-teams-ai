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
  collectCommonJsRootAssignments,
  collectFinalCommonJsPropertyWrites,
  commonJsReferenceIsPublic,
  commonJsRootWrapperSources,
  createExportsState,
  lastCommonJsRootReplacement,
  memberRelationIsAttachedAt,
  pathWasOverwrittenAfter,
} from './feature-public-commonjs-analysis.mjs';
import {
  accessPath,
  collectCopyRelations,
  collectPrototypeRelations,
  collectTopLevelPropertyWrites,
  copiedPropertyPath,
  latestPropertyWriteBefore,
  materializeCopyRelationWrites,
  propertyPathWasOverwrittenAfter,
  propertyWriteWasOverwrittenBefore,
  staticOverwrittenPaths,
  staticOverwrittenPropertyPaths,
} from './feature-public-object-analysis.mjs';
import {
  IDENTITY_WRAPPERS,
  constructedClassReferences,
} from './feature-public-identity-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { attachPublicReferenceQueries } from './feature-public-reference-visibility.mjs';
function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  return bindingName.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function collectBindingModel(sourceFile) {
  const eventsByName = new Map();
  const versions = new Map();
  const topLevelNames = new Set();
  let sequence = 0;

  const addVersion = (name, initializer, position, forcedAlias) => {
    const key = `${name}:${position}:${sequence++}`;
    const version = { forcedAlias, initializer, key, name, position };
    versions.set(key, version);
    const events = eventsByName.get(name) ?? [];
    events.push(version);
    eventsByName.set(name, events);
  };
  const addBinding = (bindingName, initializer, position, forcedAlias) => {
    if (ts.isIdentifier(bindingName)) {
      addVersion(bindingName.text, initializer, position, forcedAlias);
      return;
    }
    for (const [index, element] of bindingName.elements.entries()) {
      if (!ts.isBindingElement(element)) continue;
      const selectedName = ts.isObjectBindingPattern(bindingName)
        ? propertyNameText(element.propertyName ?? element.name)
        : String(index);
      const skipIdentity = Boolean(element.dotDotDotToken || element.initializer);
      addBinding(
        element.name,
        initializer,
        position,
        skipIdentity
          ? { skipIdentity: true }
          : {
              expression: initializer,
              path: [...(forcedAlias?.path ?? []), selectedName],
              symmetric: false,
            }
      );
    }
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      for (const name of bindingNames(declaration.name)) topLevelNames.add(name);
      if (declaration.initializer) {
        addBinding(
          declaration.name,
          declaration.initializer,
          declaration.getStart(sourceFile),
          undefined
        );
      }
    }
  }

  const visitExpression = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target) && topLevelNames.has(target.text)) {
        addVersion(target.text, node.right, node.end, undefined);
      }
    }
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
  for (const statement of sourceFile.statements) {
    visitStatement(statement);
  }
  for (const events of eventsByName.values()) {
    events.sort((left, right) => left.position - right.position);
  }
  const bindingAt = (name, position) => {
    const events = eventsByName.get(name) ?? [];
    return [...events].reverse().find((event) => event.position <= position)?.key ?? null;
  };
  return { bindingAt, eventsByName, versions };
}

function collectContainedBindingEntries(expression, bindingModel) {
  const entries = [];
  const visit = (value, path = []) => {
    const current = unwrapExpression(value);
    if (ts.isIdentifier(current)) {
      const key = bindingModel.bindingAt(current.text, current.getStart());
      if (key) entries.push({ key, path });
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          visit(property.name, [...path, property.name.text]);
        } else if (ts.isPropertyAssignment(property)) {
          visit(property.initializer, [...path, propertyNameText(property.name)]);
        }
        // Object spread copies properties; it does not expose the source object identity.
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const [index, element] of current.elements.entries()) {
        if (!ts.isOmittedExpression(element)) visit(element, [...path, String(index)]);
      }
      return;
    }
    if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue, path);
      visit(current.whenFalse, path);
    }
  };
  visit(expression);
  return entries;
}

function collectContainedStableBindings(expression, stableBindings) {
  return new Set(collectContainedBindingEntries(expression, stableBindings).map(({ key }) => key));
}

function directAliasSource(expression, bindingModel) {
  let current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) {
    const method = memberAccess(current.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      IDENTITY_WRAPPERS.has(method.name) &&
      current.arguments[0]
    ) {
      current = unwrapExpression(current.arguments[0]);
    }
  }
  if (ts.isIdentifier(current)) {
    const key = bindingModel.bindingAt(current.text, current.getStart());
    return key ? { key, path: [], symmetric: true } : null;
  }
  const access = accessPath(current);
  if (access && access.path.length > 0) {
    const key = bindingModel.bindingAt(access.root, current.getStart());
    return key ? { key, path: access.path, symmetric: false } : null;
  }
  return null;
}

function addIdentityEdge(edges, source, target) {
  const targets = edges.get(source) ?? new Set();
  targets.add(target);
  edges.set(source, targets);
}

function objectCreatePrototype(initializer, bindingModel) {
  const current = unwrapExpression(initializer);
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
  const prototype = current.arguments[0] && accessPath(current.arguments[0]);
  if (!prototype) return null;
  const sourceKey = bindingModel.bindingAt(prototype.root, current.getStart());
  return sourceKey ? { path: prototype.path, sourceKey } : null;
}

function buildIdentityEdges(bindingModel, propertyWrites) {
  const edges = new Map();
  const memberRelations = [];
  const pathWasOverwritten = (source, path, position) =>
    propertyPathWasOverwrittenAfter(propertyWrites, source, path, position);
  for (const [key, binding] of bindingModel.versions) {
    if (binding.forcedAlias?.skipIdentity) continue;
    const directAlias = directAliasSource(binding.initializer, bindingModel);
    const alias = binding.forcedAlias
      ? {
          ...directAliasSource(binding.forcedAlias.expression, bindingModel),
          path: binding.forcedAlias.path,
          symmetric: binding.forcedAlias.symmetric,
        }
      : directAlias;
    if (alias) {
      if (!pathWasOverwritten(alias.key, alias.path, binding.position)) {
        if (alias.path.length > 0) {
          addIdentityEdge(edges, alias.key, key);
          memberRelations.push({
            ownerKey: key,
            path: alias.path,
            sourceKey: alias.key,
          });
        } else {
          addIdentityEdge(edges, alias.key, key);
          if (alias.symmetric) addIdentityEdge(edges, key, alias.key);
        }
      }
      continue;
    }
    const prototype = objectCreatePrototype(binding.initializer, bindingModel);
    if (prototype?.path.length === 0) {
      addIdentityEdge(edges, key, prototype.sourceKey);
    } else if (prototype) {
      memberRelations.push({
        ownerKey: key,
        path: prototype.path,
        sourceKey: prototype.sourceKey,
      });
    }
    for (const contained of collectContainedBindingEntries(binding.initializer, bindingModel)) {
      if (!pathWasOverwritten(key, contained.path, binding.position)) {
        addIdentityEdge(edges, key, contained.key);
      }
    }
  }
  return { edges, memberRelations };
}

function collectCommonJsSeeds(sourceFile, bindingModel, rootAssignments, exportsActiveAt) {
  const seeds = new Set();
  const lastModuleReset = lastCommonJsRootReplacement(rootAssignments, exportsActiveAt);
  const finalRootPosition = lastModuleReset?.position ?? -1;

  for (const [key, binding] of bindingModel.versions) {
    const root = rootBindingName(binding.initializer);
    const isCommonJsAlias = isCommonJsExportsObject(unwrapExpression(binding.initializer));
    if (
      isCommonJsAlias &&
      binding.position > finalRootPosition &&
      (root !== 'exports' || exportsActiveAt(binding.position))
    ) {
      seeds.add(key);
    }
  }
  if (lastModuleReset) {
    const value = unwrapExpression(lastModuleReset.expression);
    if (ts.isIdentifier(value)) {
      const key = bindingModel.bindingAt(value.text, lastModuleReset.position);
      if (key) seeds.add(key);
    }
    for (const key of collectContainedStableBindings(value, bindingModel)) seeds.add(key);
    for (const source of commonJsRootWrapperSources(
      value,
      bindingModel,
      lastModuleReset.position
    )) {
      if (source.path.length === 0) seeds.add(source.sourceKey);
    }
  }

  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.getStart(sourceFile) >= finalRootPosition &&
      isCommonJsExportsObject(unwrapExpression(node.left))
    ) {
      const targetRoot = rootBindingName(node.left);
      if (targetRoot !== 'exports' || exportsActiveAt(node.getStart(sourceFile))) {
        const value = unwrapExpression(node.right);
        if (ts.isIdentifier(value)) {
          const key = bindingModel.bindingAt(value.text, node.getStart(sourceFile));
          if (key) seeds.add(key);
        }
        for (const key of collectContainedStableBindings(value, bindingModel)) {
          seeds.add(key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visitDefiniteTopLevelExpressions(sourceFile, visit);
  return seeds;
}

function collectCommonJsCopyRelations(
  sourceFile,
  bindingModel,
  finalRootPosition,
  exportsActiveAt
) {
  const relations = [];
  const targetIsActive = (target, position) =>
    position >= finalRootPosition &&
    isCommonJsExportsObject(target) &&
    (rootBindingName(target) !== 'exports' || exportsActiveAt(position));
  const addSources = (target, sources, copyPosition) => {
    const targetPath = commonJsExportPath(target);
    if (targetPath === null) return;
    for (const [index, expression] of sources.entries()) {
      const source = accessPath(expression);
      const sourceKey =
        source && bindingModel.bindingAt(source.root, expression.getStart(sourceFile));
      if (sourceKey) {
        relations.push({
          copyPosition,
          overwrittenPaths: staticOverwrittenPaths(
            sources.slice(index + 1),
            bindingModel,
            copyPosition
          ),
          path: source.path,
          sourceKey,
          targetPath,
        });
      }
    }
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    const position = node.getStart(sourceFile);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      targetIsActive(node.left, position)
    ) {
      const value = unwrapExpression(node.right);
      if (ts.isObjectLiteralExpression(value)) {
        const properties = [...value.properties];
        for (const [index, property] of properties.entries()) {
          if (!ts.isSpreadAssignment(property)) continue;
          const source = accessPath(property.expression);
          const sourceKey = source && bindingModel.bindingAt(source.root, property.getStart());
          if (sourceKey) {
            relations.push({
              copyPosition: value.end,
              overwrittenPaths: staticOverwrittenPropertyPaths(
                properties.slice(index + 1),
                bindingModel,
                value.getStart(sourceFile)
              ),
              path: source.path,
              sourceKey,
              targetPath: commonJsExportPath(node.left) ?? [],
            });
          }
        }
      } else if (ts.isCallExpression(value)) {
        const method = memberAccess(value.expression);
        if (
          method &&
          ts.isIdentifier(method.receiver) &&
          method.receiver.text === 'Object' &&
          method.name === 'assign'
        ) {
          addSources(node.left, [...value.arguments], value.end);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const method = memberAccess(node.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'assign' &&
        node.arguments[0] &&
        targetIsActive(node.arguments[0], position)
      ) {
        addSources(
          node.arguments[0],
          [...node.arguments].slice(1),
          node.end
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visitDefiniteTopLevelExpressions(sourceFile, visit);
  return relations;
}

function propagateIdentityOwners(initialOwners, edges) {
  const owners = new Map(initialOwners);
  const queue = [...owners.keys()];
  while (queue.length > 0) {
    const source = queue.shift();
    const owner = owners.get(source);
    if (!owner) continue;
    for (const target of edges.get(source) ?? []) {
      if (owners.has(target)) continue;
      owners.set(target, owner);
      queue.push(target);
    }
  }
  return owners;
}

function propagateIdentitySet(initialValues, edges) {
  const values = new Set(initialValues);
  const queue = [...values];
  while (queue.length > 0) {
    const source = queue.shift();
    for (const target of edges.get(source) ?? []) {
      if (values.has(target)) continue;
      values.add(target);
      queue.push(target);
    }
  }
  return values;
}

export function analyzePublicTargets(
  sourceFile,
  exportedLocalNames,
  snapshotLocalExports = []
) {
  const bindingModel = collectBindingModel(sourceFile);
  const propertyWrites = collectTopLevelPropertyWrites(sourceFile, bindingModel);
  const allCopyRelations = collectCopyRelations(sourceFile, bindingModel);
  materializeCopyRelationWrites(propertyWrites, allCopyRelations);
  const { edges: identityEdges, memberRelations } = buildIdentityEdges(
    bindingModel,
    propertyWrites
  );
  memberRelations.push(...collectPrototypeRelations(sourceFile, bindingModel));
  const stableExportOwners = [...exportedLocalNames]
    .map((name) => [bindingModel.bindingAt(name, Number.POSITIVE_INFINITY), name])
    .filter(([key]) => key !== null);
  const snapshotExportOwners = snapshotLocalExports
    .map(({ name, position }) => [bindingModel.bindingAt(name, position), name])
    .filter(([key]) => key !== null);
  const identityOwners = propagateIdentityOwners(
    [...stableExportOwners, ...snapshotExportOwners],
    identityEdges
  );
  const publicBindingNames = new Set([
    ...exportedLocalNames,
    ...snapshotLocalExports.map(({ name }) => name),
  ]);
  const rootAssignments = collectCommonJsRootAssignments(sourceFile);
  const exportsActiveAt = createExportsState(rootAssignments);
  const finalRootReplacement = lastCommonJsRootReplacement(
    rootAssignments,
    exportsActiveAt
  );
  const finalRootPosition = finalRootReplacement?.position ?? -1;
  const commonJsRootWrapperRelations = finalRootReplacement
    ? commonJsRootWrapperSources(
        finalRootReplacement.expression,
        bindingModel,
        finalRootReplacement.position
      ).filter(({ path }) => path.length > 0)
    : [];
  const commonJsTargetAliases = propagateIdentitySet(
    collectCommonJsSeeds(sourceFile, bindingModel, rootAssignments, exportsActiveAt),
    identityEdges
  );
  const publicMemberRelations = memberRelations.flatMap((relation) => {
    const owner = identityOwners.get(relation.ownerKey);
    return owner ? [{ ...relation, owner }] : [];
  });
  const copyRelations = allCopyRelations.flatMap((relation) => {
    const owner = identityOwners.get(relation.ownerKey);
    return owner ? [{ ...relation, owner }] : [];
  });
  const commonJsCopyRelations = collectCommonJsCopyRelations(
    sourceFile,
    bindingModel,
    finalRootPosition,
    exportsActiveAt
  );
  const commonJsFinalTargetPath = (target, position) => {
    if (position < finalRootPosition) return null;
    const directPath = commonJsExportPath(target);
    if (
      directPath !== null &&
      (rootBindingName(target) !== 'exports' || exportsActiveAt(position))
    ) {
      return directPath;
    }
    const alias = accessPath(target);
    const aliasKey =
      alias && bindingModel.bindingAt(alias.root, position);
    return aliasKey && commonJsTargetAliases.has(aliasKey) ? alias.path : null;
  };
  const finalCommonJsPropertyWrites = collectFinalCommonJsPropertyWrites(
    sourceFile,
    commonJsFinalTargetPath,
    bindingModel
  );
  const writeContainsPosition = (write, position) =>
    write.referenceRanges?.length
      ? write.referenceRanges.some(
          (range) => range.start <= position && position <= range.end
        )
      : write.position <= position && position <= write.end;
  const relationMatchesAt = (relation, position, queriedSourceKey = relation.sourceKey) => {
    const source = bindingModel.versions.get(relation.sourceKey);
    if (
      !source ||
      bindingModel.bindingAt(source.name, relation.copyPosition) !==
        relation.sourceKey
    ) {
      return false;
    }
    const sourceWrites = propertyWrites.get(relation.sourceKey) ?? [];
    const currentWrite = latestPropertyWriteBefore(
      sourceWrites,
      relation.copyPosition,
      (write) =>
        writeContainsPosition(write, position) &&
        (queriedSourceKey === relation.sourceKey ||
          write.originSourceKeys?.includes(queriedSourceKey))
    );
    if (
      !currentWrite ||
      !relation.path.every((segment, index) => currentWrite.path[index] === segment)
    ) {
      return false;
    }
    const wasOverwrittenBeforeCopy = propertyWriteWasOverwrittenBefore(
      sourceWrites,
      currentWrite,
      relation.copyPosition
    );
    const overwrittenByTarget = relation.overwrittenPaths?.some((overwrittenPath) =>
      overwrittenPath.every(
        (segment, index) => currentWrite.path[relation.path.length + index] === segment
      )
    );
    const copiedPath = copiedPropertyPath(relation, currentWrite.path);
    return (
      position < relation.copyPosition &&
      currentWrite.enumerable &&
      !wasOverwrittenBeforeCopy &&
      !overwrittenByTarget &&
      !pathWasOverwrittenAfter(
        finalCommonJsPropertyWrites,
        copiedPath,
        relation.copyPosition
      )
    );
  };
  const localOwnersAt = (position, selectedSourcePath = null) => {
    const owners = new Map();
    let referenceOwner = null;
    for (const [key, binding] of bindingModel.versions) {
      const owner = identityOwners.get(key);
      if (
        owner &&
        binding.initializer.pos <= position &&
        position <= binding.initializer.end
      ) {
        owners.set(binding.name, owner);
      }
    }
    for (const name of bindingModel.eventsByName.keys()) {
      const key = bindingModel.bindingAt(name, position);
      const owner = key && identityOwners.get(key);
      if (owner) owners.set(name, owner);
    }
    for (const name of exportedLocalNames) {
      if (!bindingModel.eventsByName.has(name) && !owners.has(name)) {
        owners.set(name, name);
      }
    }
    for (const relation of [...publicMemberRelations, ...copyRelations]) {
      const source = bindingModel.versions.get(relation.sourceKey);
      if (
        !source ||
        bindingModel.bindingAt(
          source.name,
          relation.copyPosition ?? position
        ) !== relation.sourceKey
      ) {
        continue;
      }
      const sourceWrites = propertyWrites.get(relation.sourceKey) ?? [];
      const currentWrite = latestPropertyWriteBefore(
        sourceWrites,
        relation.copyPosition ?? Number.POSITIVE_INFINITY,
        (write) =>
          writeContainsPosition(write, position) &&
          (!selectedSourcePath ||
            source.name !== selectedSourcePath.name ||
            (write.path.length === selectedSourcePath.path.length &&
              write.path.every(
                (segment, index) => segment === selectedSourcePath.path[index]
              )))
      );
      const insideSourceInitializer =
        source.initializer.getStart(sourceFile) <= position && position <= source.initializer.end;
      const pathMatches =
        (currentWrite &&
          relation.path.every((segment, index) => currentWrite.path[index] === segment)) ||
        (relation.path.length === 0 && insideSourceInitializer);
      if (relation.copyPosition === undefined) {
        if (pathMatches && !owners.has(source.name)) {
          owners.set(source.name, relation.owner);
        }
        continue;
      }
      const wasOverwrittenBeforeCopy =
        currentWrite &&
        propertyWriteWasOverwrittenBefore(
          sourceWrites,
          currentWrite,
          relation.copyPosition
        );
      const overwrittenByTarget =
        currentWrite &&
        relation.overwrittenPaths?.some((overwrittenPath) =>
          overwrittenPath.every(
            (segment, index) =>
              currentWrite.path[relation.path.length + index] === segment
          )
        );
      const overwrittenAfterCopy =
        currentWrite &&
        propertyPathWasOverwrittenAfter(
          propertyWrites, relation.ownerKey,
          copiedPropertyPath(relation, currentWrite.path), relation.copyPosition
        );
      if (
        position < relation.copyPosition &&
        pathMatches &&
        (insideSourceInitializer || currentWrite?.enumerable) &&
        !wasOverwrittenBeforeCopy &&
        !overwrittenByTarget &&
        !overwrittenAfterCopy
      ) {
        if (currentWrite && writeContainsPosition(currentWrite, position)) {
          referenceOwner ??= relation.owner;
        }
        const visibleSources = [
          relation.sourceKey,
          ...(currentWrite?.originSourceKeys ?? []),
        ];
        for (const sourceKey of visibleSources) {
          const visibleSource = bindingModel.versions.get(sourceKey);
          if (
            visibleSource &&
            bindingModel.bindingAt(visibleSource.name, position) === sourceKey &&
            !owners.has(visibleSource.name)
          ) {
            owners.set(visibleSource.name, relation.owner);
          }
        }
      }
    }
    attachPublicReferenceQueries(owners, {
      bindingModel,
      publicBindingNames,
      propertyWrites,
      referenceOwner,
      referenceOwnerForSelection: (reference, { localMember, localNames }) => {
        if (localMember === null || localMember === undefined) return null;
        for (const localName of localNames) {
          const selectedOwners = localOwnersAt(reference.getStart(sourceFile), {
            name: localName,
            path: [localMember],
          });
          const owner = selectedOwners.get(localName);
          if (owner) return owner;
        }
        return null;
      },
      sourceFile,
    });
    return owners;
  };
  const commonJsTargetsAt = (position) => ({
    directExportsActive: position >= finalRootPosition && exportsActiveAt(position),
    directModuleExportsActive: position >= finalRootPosition,
    isReferencePublic: (expression, reference) =>
      commonJsReferenceIsPublic(
        expression,
        reference,
        finalCommonJsPropertyWrites,
        bindingModel,
        commonJsFinalTargetPath
      ),
    has: (name) => {
      const key = bindingModel.bindingAt(name, position);
      return key
        ? commonJsTargetAliases.has(key) ||
            commonJsCopyRelations.some(
              (relation) => relationMatchesAt(relation, position, key)
            )
        : false;
    },
    hasPath: (name, path) => {
      const key = bindingModel.bindingAt(name, position);
      if (!key) return false;
      if (commonJsTargetAliases.has(key)) return true;
      return commonJsRootWrapperRelations.some(
        (relation) =>
          relation.sourceKey === key &&
          relation.path.every((segment, index) => segment === path[index]) &&
          memberRelationIsAttachedAt(
            propertyWrites,
            relation,
            finalRootPosition,
            position
          )
      );
    },
  });
  const constructorExports = [];
  const copyConstructorOwners = new Map(
    copyRelations.map(({ owner, sourceKey }) => [sourceKey, owner])
  );
  for (const [key, binding] of bindingModel.versions) {
    const owner = identityOwners.get(key) ?? copyConstructorOwners.get(key);
    if (!owner) continue;
    for (const classReference of constructedClassReferences(binding.initializer)) {
      constructorExports.push({ exportedName: owner, ...classReference });
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    for (const classReference of constructedClassReferences(statement.expression)) {
      constructorExports.push({ exportedName: 'default', ...classReference });
    }
  }
  return {
    commonJsTargetAliases,
    commonJsTargetsAt,
    constructorExports,
    localOwners: localOwnersAt(Number.POSITIVE_INFINITY),
    localOwnersAt,
  };
}
