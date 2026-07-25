import ts from 'typescript';

import {
  isCommonJsExportsObject,
  memberAccess,
  propertyNameText,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';

const IDENTITY_WRAPPERS = new Set(['freeze', 'preventExtensions', 'seal']);

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
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const key = bindingModel.bindingAt(current.text, current.getStart());
    return key ? { key, path: [], symmetric: true } : null;
  }
  const access = accessPath(current);
  if (access && access.path.length > 0) {
    const key = bindingModel.bindingAt(access.root, current.getStart());
    return key ? { key, path: access.path, symmetric: false } : null;
  }
  if (!ts.isCallExpression(current)) return null;
  const method = memberAccess(current.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    method.receiver.text !== 'Object' ||
    !IDENTITY_WRAPPERS.has(method.name)
  ) {
    return null;
  }
  const argument = current.arguments[0] && unwrapExpression(current.arguments[0]);
  if (!argument || !ts.isIdentifier(argument)) return null;
  const key = bindingModel.bindingAt(argument.text, argument.getStart());
  return key ? { key, path: [], symmetric: true } : null;
}

function accessPath(expression) {
  let current = unwrapExpression(expression);
  const path = [];
  while (true) {
    const access = memberAccess(current);
    if (!access) break;
    path.unshift(access.name);
    current = access.receiver;
  }
  return ts.isIdentifier(current) ? { path, root: current.text } : null;
}

function collectTopLevelPropertyWrites(sourceFile, bindingModel) {
  const writes = new Map();
  const addWrite = (targetExpression, node, enumerable = true) => {
    const target = accessPath(targetExpression);
    if (!target || target.path.length === 0) return;
    const sourceKey = bindingModel.bindingAt(target.root, node.getStart(sourceFile));
    if (!sourceKey) return;
    const rootWrites = writes.get(sourceKey) ?? [];
    rootWrites.push({
      end: node.end,
      enumerable,
      path: target.path,
      position: node.getStart(sourceFile),
    });
    writes.set(sourceKey, rootWrites);
  };
  const visitExpression = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      addWrite(node.left, node);
    } else if (ts.isCallExpression(node)) {
      const method = memberAccess(node.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'defineProperty' &&
        node.arguments[0] &&
        node.arguments[1] &&
        ts.isStringLiteralLike(node.arguments[1])
      ) {
        const target = accessPath(node.arguments[0]);
        if (target) {
          const descriptor = node.arguments[2] && unwrapExpression(node.arguments[2]);
          const enumerable =
            descriptor && ts.isObjectLiteralExpression(descriptor)
              ? descriptor.properties.some(
                  (property) =>
                    ts.isPropertyAssignment(property) &&
                    propertyNameText(property.name) === 'enumerable' &&
                    property.initializer.kind === ts.SyntaxKind.TrueKeyword
                )
              : false;
          const sourceKey = bindingModel.bindingAt(target.root, node.getStart(sourceFile));
          if (sourceKey) {
            const rootWrites = writes.get(sourceKey) ?? [];
            rootWrites.push({
              end: node.end,
              enumerable,
              path: [...target.path, node.arguments[1].text],
              position: node.getStart(sourceFile),
            });
            writes.set(sourceKey, rootWrites);
          }
        }
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
  return writes;
}

function pathWasOverwritten(writes, source, path, afterPosition) {
  return (writes.get(source) ?? []).some(
    (write) =>
      write.position > afterPosition &&
      write.path.length <= path.length &&
      write.path.every((segment, index) => segment === path[index])
  );
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
      if (!pathWasOverwritten(propertyWrites, alias.key, alias.path, binding.position)) {
        addIdentityEdge(edges, alias.key, key);
        if (alias.symmetric) addIdentityEdge(edges, key, alias.key);
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
      if (!pathWasOverwritten(propertyWrites, key, contained.path, binding.position)) {
        addIdentityEdge(edges, key, contained.key);
      }
    }
  }
  return { edges, memberRelations };
}

function commonJsRootKind(expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current) && current.text === 'exports') return 'exports';
  const access = memberAccess(current);
  return access?.name === 'exports' &&
    ts.isIdentifier(access.receiver) &&
    access.receiver.text === 'module'
    ? 'module'
    : null;
}

function visitDefiniteTopLevelExpressions(sourceFile, visitor) {
  const visitStatement = (statement) => {
    if (ts.isExpressionStatement(statement)) {
      visitor(statement.expression);
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

function collectCommonJsRootAssignments(sourceFile) {
  const assignments = [];
  let order = 0;
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, visit);
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      return;
    }
    const kind = commonJsRootKind(node.left);
    if (kind) {
      assignments.push({
        expression: node.right,
        kind,
        order: order++,
        position: node.getStart(sourceFile),
      });
    }
  };
  visitDefiniteTopLevelExpressions(sourceFile, visit);
  return assignments;
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

function createExportsState(rootAssignments) {
  return (position) => {
    let active = true;
    for (const assignment of rootAssignments) {
      if (assignment.position >= position) break;
      active = assignmentLinksExports(assignment.kind, assignment.expression);
    }
    return active;
  };
}

function lastCommonJsRootReplacement(rootAssignments, exportsActiveAt) {
  return (
    [...rootAssignments].reverse().find((assignment) => {
      if (assignment.kind !== 'module') return false;
      const value = unwrapExpression(assignment.expression);
      if (commonJsRootKind(value) === 'module') return false;
      return !(commonJsRootKind(value) === 'exports' && exportsActiveAt(assignment.position));
    }) ?? null
  );
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

function collectCommonJsSpreadRelations(
  sourceFile,
  bindingModel,
  finalRootPosition,
  exportsActiveAt
) {
  const relations = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.getStart(sourceFile) >= finalRootPosition &&
      isCommonJsExportsObject(node.left) &&
      (rootBindingName(node.left) !== 'exports' || exportsActiveAt(node.getStart(sourceFile)))
    ) {
      const value = unwrapExpression(node.right);
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (!ts.isSpreadAssignment(property)) continue;
          const source = accessPath(property.expression);
          const sourceKey = source && bindingModel.bindingAt(source.root, property.getStart());
          if (sourceKey) {
            relations.push({
              copyPosition: property.getStart(),
              path: source.path,
              sourceKey,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visitDefiniteTopLevelExpressions(sourceFile, visit);
  return relations;
}

function collectSpreadRelations(bindingModel) {
  const relations = [];
  for (const [ownerKey, binding] of bindingModel.versions) {
    const visit = (expression) => {
      const current = unwrapExpression(expression);
      if (!ts.isObjectLiteralExpression(current)) return;
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          const source = accessPath(property.expression);
          const sourceKey = source && bindingModel.bindingAt(source.root, property.getStart());
          if (sourceKey) {
            relations.push({
              copyPosition: property.getStart(),
              ownerKey,
              path: source.path,
              sourceKey,
            });
          }
        } else if (ts.isPropertyAssignment(property)) {
          visit(property.initializer);
        }
      }
    };
    visit(binding.initializer);
  }
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

function constructedClassNames(expression) {
  const current = unwrapExpression(expression);
  if (ts.isNewExpression(current)) {
    const className = rootBindingName(current.expression);
    return className ? [className] : [];
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) ? constructedClassNames(property.initializer) : []
    );
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : constructedClassNames(element)
    );
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...constructedClassNames(current.whenTrue),
      ...constructedClassNames(current.whenFalse),
    ];
  }
  if (ts.isCallExpression(current)) {
    const method = memberAccess(current.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      IDENTITY_WRAPPERS.has(method.name) &&
      current.arguments[0]
    ) {
      return constructedClassNames(current.arguments[0]);
    }
  }
  return [];
}

export function analyzePublicTargets(sourceFile, exportedLocalNames) {
  const bindingModel = collectBindingModel(sourceFile);
  const propertyWrites = collectTopLevelPropertyWrites(sourceFile, bindingModel);
  const { edges: identityEdges, memberRelations } = buildIdentityEdges(
    bindingModel,
    propertyWrites
  );
  const stableExportOwners = [...exportedLocalNames]
    .map((name) => [bindingModel.bindingAt(name, Number.POSITIVE_INFINITY), name])
    .filter(([key]) => key !== null);
  const identityOwners = propagateIdentityOwners(stableExportOwners, identityEdges);
  const rootAssignments = collectCommonJsRootAssignments(sourceFile);
  const exportsActiveAt = createExportsState(rootAssignments);
  const finalRootPosition =
    lastCommonJsRootReplacement(rootAssignments, exportsActiveAt)?.position ?? -1;
  const commonJsTargetAliases = propagateIdentitySet(
    collectCommonJsSeeds(sourceFile, bindingModel, rootAssignments, exportsActiveAt),
    identityEdges
  );
  const publicMemberRelations = memberRelations.flatMap((relation) => {
    const owner = identityOwners.get(relation.ownerKey);
    return owner ? [{ ...relation, owner }] : [];
  });
  const spreadRelations = collectSpreadRelations(bindingModel).flatMap((relation) => {
    const owner = identityOwners.get(relation.ownerKey);
    return owner ? [{ ...relation, owner }] : [];
  });
  const commonJsSpreadRelations = collectCommonJsSpreadRelations(
    sourceFile,
    bindingModel,
    finalRootPosition,
    exportsActiveAt
  );
  const relationMatchesAt = (relation, position) => {
    const source = bindingModel.versions.get(relation.sourceKey);
    if (!source || bindingModel.bindingAt(source.name, position) !== relation.sourceKey) {
      return false;
    }
    const sourceWrites = propertyWrites.get(relation.sourceKey) ?? [];
    const currentWrite = sourceWrites.find(
      (write) => write.position <= position && position <= write.end
    );
    if (
      !currentWrite ||
      !relation.path.every((segment, index) => currentWrite.path[index] === segment)
    ) {
      return false;
    }
    const wasOverwrittenBeforeCopy = sourceWrites.some(
      (write) =>
        write.position > currentWrite.position &&
        write.position < relation.copyPosition &&
        write.path.length === currentWrite.path.length &&
        write.path.every((segment, index) => segment === currentWrite.path[index])
    );
    return position < relation.copyPosition && currentWrite.enumerable && !wasOverwrittenBeforeCopy;
  };
  const localOwnersAt = (position) => {
    const owners = new Map();
    for (const name of bindingModel.eventsByName.keys()) {
      const key = bindingModel.bindingAt(name, position);
      const owner = key && identityOwners.get(key);
      if (owner) owners.set(name, owner);
    }
    for (const name of exportedLocalNames) {
      if (!owners.has(name)) owners.set(name, name);
    }
    for (const relation of [...publicMemberRelations, ...spreadRelations]) {
      const source = bindingModel.versions.get(relation.sourceKey);
      if (!source || bindingModel.bindingAt(source.name, position) !== relation.sourceKey) {
        continue;
      }
      const sourceWrites = propertyWrites.get(relation.sourceKey) ?? [];
      const currentWrite = sourceWrites.find(
        (write) => write.position <= position && position <= write.end
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
        sourceWrites.some(
          (write) =>
            write.position > currentWrite.position &&
            write.position < relation.copyPosition &&
            write.path.length === currentWrite.path.length &&
            write.path.every((segment, index) => segment === currentWrite.path[index])
        );
      if (
        position < relation.copyPosition &&
        pathMatches &&
        (insideSourceInitializer || currentWrite?.enumerable) &&
        !wasOverwrittenBeforeCopy &&
        !owners.has(source.name)
      ) {
        owners.set(source.name, relation.owner);
      }
    }
    return owners;
  };
  const commonJsTargetsAt = (position) => ({
    directExportsActive: position >= finalRootPosition && exportsActiveAt(position),
    directModuleExportsActive: position >= finalRootPosition,
    has: (name) => {
      const key = bindingModel.bindingAt(name, position);
      return key
        ? commonJsTargetAliases.has(key) ||
            commonJsSpreadRelations.some(
              (relation) => relation.sourceKey === key && relationMatchesAt(relation, position)
            )
        : false;
    },
  });
  const constructorExports = [];
  const spreadConstructorOwners = new Map(
    spreadRelations.map(({ owner, sourceKey }) => [sourceKey, owner])
  );
  for (const [key, binding] of bindingModel.versions) {
    const owner = identityOwners.get(key) ?? spreadConstructorOwners.get(key);
    if (!owner) continue;
    for (const className of constructedClassNames(binding.initializer)) {
      constructorExports.push({ exportedName: owner, localName: className });
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    for (const className of constructedClassNames(statement.expression)) {
      constructorExports.push({ exportedName: 'default', localName: className });
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
