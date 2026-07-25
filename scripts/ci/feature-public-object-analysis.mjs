import ts from 'typescript';

import {
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';

export function accessPath(expression) {
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

function resolveObjectLiterals(
  expression,
  bindingModel,
  beforePosition,
  visited = new Set()
) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  if (ts.isObjectLiteralExpression(current)) return [current];
  if (ts.isConditionalExpression(current)) {
    return [
      ...resolveObjectLiterals(
        current.whenTrue,
        bindingModel,
        beforePosition,
        new Set(visited)
      ),
      ...resolveObjectLiterals(
        current.whenFalse,
        bindingModel,
        beforePosition,
        new Set(visited)
      ),
    ];
  }
  if (ts.isIdentifier(current)) {
    const key = bindingModel.bindingAt(current.text, beforePosition);
    if (!key || visited.has(key)) return [];
    const binding = bindingModel.versions.get(key);
    return binding
      ? resolveObjectLiterals(
          binding.initializer,
          bindingModel,
          binding.position,
          new Set(visited).add(key)
        )
      : [];
  }
  const access = memberAccess(current);
  if (!access) return [];
  return resolveObjectLiterals(
    access.receiver,
    bindingModel,
    beforePosition,
    visited
  ).flatMap((object) => {
    const property = object.properties.find(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) ||
          ts.isShorthandPropertyAssignment(candidate)) &&
        propertyNameText(candidate.name) === access.name
    );
    if (property && ts.isPropertyAssignment(property)) {
      return resolveObjectLiterals(
        property.initializer,
        bindingModel,
        beforePosition,
        visited
      );
    }
    return property && ts.isShorthandPropertyAssignment(property)
      ? resolveObjectLiterals(property.name, bindingModel, beforePosition, visited)
      : [];
  });
}

function descriptorIsEnumerable(descriptor) {
  return descriptor.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === 'enumerable' &&
      unwrapExpression(property.initializer).kind === ts.SyntaxKind.TrueKeyword
  );
}

export function collectTopLevelPropertyWrites(sourceFile, bindingModel) {
  const writes = new Map();
  const addWrite = ({
    end,
    enumerable = true,
    path,
    position,
    referenceEnd = end,
    referenceStart = position,
    sourceKey,
  }) => {
    if (!sourceKey || path.length === 0) return;
    const rootWrites = writes.get(sourceKey) ?? [];
    rootWrites.push({
      end,
      enumerable,
      path,
      position,
      referenceEnd,
      referenceStart,
    });
    writes.set(sourceKey, rootWrites);
  };
  const addTargetWrite = (
    targetExpression,
    node,
    suffix = [],
    enumerable = true,
    referenceNode = node
  ) => {
    const target = accessPath(targetExpression);
    if (!target) return;
    addWrite({
      end: node.end,
      enumerable,
      path: [...target.path, ...suffix],
      position: node.getStart(sourceFile),
      referenceEnd: referenceNode.end,
      referenceStart: referenceNode.getStart(sourceFile),
      sourceKey: bindingModel.bindingAt(target.root, node.getStart(sourceFile)),
    });
  };
  const addDescriptorMapWrites = (targetExpression, mapExpression, node) => {
    for (const descriptorMap of resolveObjectLiterals(
      mapExpression,
      bindingModel,
      node.getStart(sourceFile)
    )) {
      for (const property of descriptorMap.properties) {
        if (
          !ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property)
        ) {
          continue;
        }
        const descriptorExpression = ts.isPropertyAssignment(property)
          ? property.initializer
          : property.name;
        for (const descriptor of resolveObjectLiterals(
          descriptorExpression,
          bindingModel,
          node.getStart(sourceFile)
        )) {
          addTargetWrite(
            targetExpression,
            node,
            [propertyNameText(property.name)],
            descriptorIsEnumerable(descriptor),
            descriptor
          );
        }
      }
    }
  };
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = accessPath(node.left);
      if (target?.path.length) {
        addWrite({
          end: node.end,
          path: target.path,
          position: node.getStart(sourceFile),
          sourceKey: bindingModel.bindingAt(target.root, node.getStart(sourceFile)),
        });
      }
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      !['Object', 'Reflect'].includes(method.receiver.text)
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
          descriptorIsEnumerable(descriptor),
          descriptor
        );
      }
    } else if (
      method.name === 'defineProperties' &&
      node.arguments[0] &&
      node.arguments[1]
    ) {
      addDescriptorMapWrites(node.arguments[0], node.arguments[1], node);
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
      method.name === 'create' &&
      initializer.arguments[1]
    ) {
      for (const descriptorMap of resolveObjectLiterals(
        initializer.arguments[1],
        bindingModel,
        initializer.getStart(sourceFile)
      )) {
        for (const property of descriptorMap.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          for (const descriptor of resolveObjectLiterals(
            property.initializer,
            bindingModel,
            initializer.getStart(sourceFile)
          )) {
            addWrite({
              end: initializer.end,
              enumerable: descriptorIsEnumerable(descriptor),
              path: [propertyNameText(property.name)],
              position: initializer.getStart(sourceFile),
              referenceEnd: descriptor.end,
              referenceStart: descriptor.getStart(sourceFile),
              sourceKey,
            });
          }
        }
      }
    }
  }
  return writes;
}

function staticOverwrittenPaths(expressions) {
  const paths = [];
  for (const expression of expressions) {
    const current = unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(current)) continue;
    for (const property of current.properties) {
      if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        paths.push([propertyNameText(property.name)]);
      }
    }
  }
  return paths;
}

function staticOverwrittenPropertyPaths(properties) {
  return properties.flatMap((property) =>
    ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property) ||
    ts.isMethodDeclaration(property) ||
    ts.isGetAccessorDeclaration(property) ||
    ts.isSetAccessorDeclaration(property)
      ? [[propertyNameText(property.name)]]
      : []
  );
}

function addCopySources(relations, ownerKey, callOrLiteral, sources, bindingModel) {
  for (const [index, sourceExpression] of sources.entries()) {
    const source = accessPath(sourceExpression);
    const sourceKey =
      source && bindingModel.bindingAt(source.root, sourceExpression.getStart());
    if (!sourceKey) continue;
    relations.push({
      copyPosition: callOrLiteral.end,
      overwrittenPaths: staticOverwrittenPaths(sources.slice(index + 1)),
      ownerKey,
      path: source.path,
      sourceKey,
    });
  }
}

export function collectCopyRelations(sourceFile, bindingModel) {
  const relations = [];
  const collectFromInitializer = (expression, ownerKey) => {
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
              copyPosition: current.end,
              overwrittenPaths: staticOverwrittenPropertyPaths(
                properties.slice(index + 1)
              ),
              ownerKey,
              path: source.path,
              sourceKey,
            });
          }
        } else if (ts.isPropertyAssignment(property)) {
          collectFromInitializer(property.initializer, ownerKey);
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
      method.name === 'assign'
    ) {
      addCopySources(
        relations,
        ownerKey,
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
        node,
        [...node.arguments].slice(1),
        bindingModel
      );
    }
  });
  return relations;
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
    addRelation(
      node,
      target && bindingModel.bindingAt(target.root, node.getStart(sourceFile))
    );
  });
  return relations;
}
