import ts from 'typescript';

import {
  isCommonJsExportsObject,
  memberAccess,
  propertyNameText,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';

function collectTopLevelAssignments(sourceFile) {
  const assignments = new Map();
  const addAssignment = (name, expression, position) => {
    const values = assignments.get(name) ?? [];
    values.push({ expression, position });
    assignments.set(name, values);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          addAssignment(declaration.name.text, declaration.initializer, declaration.pos);
        }
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = unwrapExpression(statement.expression);
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(expression.left))
    ) {
      addAssignment(
        unwrapExpression(expression.left).text,
        expression.right,
        expression.getStart(sourceFile)
      );
    }
  }
  return assignments;
}

function resolveDescriptorObjects(expression, assignments, beforePosition, visited = new Set()) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  if (ts.isObjectLiteralExpression(current)) return [current];
  if (ts.isIdentifier(current)) {
    if (visited.has(current.text)) return [];
    const candidates = (assignments.get(current.text) ?? [])
      .filter(({ position }) => position < beforePosition)
      .sort((left, right) => right.position - left.position);
    const latest = candidates[0];
    return latest
      ? resolveDescriptorObjects(
          latest.expression,
          assignments,
          beforePosition,
          new Set(visited).add(current.text)
        )
      : [];
  }
  const access = memberAccess(current);
  if (!access) return [];
  return resolveDescriptorObjects(access.receiver, assignments, beforePosition, visited).flatMap(
    (object) => {
      const property = object.properties.find(
        (candidate) =>
          (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
          propertyNameText(candidate.name) === access.name
      );
      if (property && ts.isPropertyAssignment(property)) {
        return resolveDescriptorObjects(property.initializer, assignments, beforePosition, visited);
      }
      return property && ts.isShorthandPropertyAssignment(property)
        ? resolveDescriptorObjects(property.name, assignments, beforePosition, visited)
        : [];
    }
  );
}

function collectDescriptorGetterProperties(descriptor, getterProperties) {
  for (const property of descriptor.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === 'get'
    ) {
      getterProperties.add(property);
    }
  }
}

function isPublicTarget(expression, publicTargets, position) {
  const current = expression && unwrapExpression(expression);
  if (!current) return false;
  const root = rootBindingName(current);
  if (isCommonJsExportsObject(current)) {
    const targets = publicTargets.commonJsTargetsAt(position);
    return root === 'exports' ? targets.directExportsActive : targets.directModuleExportsActive;
  }
  return (
    root !== null &&
    (publicTargets.localOwnersAt(position).has(root) ||
      publicTargets.commonJsTargetsAt(position).has(root))
  );
}

export function collectConsumedDescriptorGetterProperties(sourceFile, publicTargets) {
  const assignments = collectTopLevelAssignments(sourceFile);
  const getterProperties = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const method = memberAccess(node.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'create'
      ) {
        for (const descriptorMap of resolveDescriptorObjects(
          node.arguments[1],
          assignments,
          node.getStart(sourceFile)
        )) {
          for (const property of descriptorMap.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            for (const descriptor of resolveDescriptorObjects(
              property.initializer,
              assignments,
              node.getStart(sourceFile)
            )) {
              collectDescriptorGetterProperties(descriptor, getterProperties);
            }
          }
        }
      }
      const isDescriptorApi =
        method &&
        ts.isIdentifier(method.receiver) &&
        ['Object', 'Reflect'].includes(method.receiver.text);
      if (
        isDescriptorApi &&
        isPublicTarget(node.arguments[0], publicTargets, node.getStart(sourceFile))
      ) {
        if (method.name === 'defineProperty') {
          for (const descriptor of resolveDescriptorObjects(
            node.arguments[2],
            assignments,
            node.getStart(sourceFile)
          )) {
            collectDescriptorGetterProperties(descriptor, getterProperties);
          }
        } else if (method.name === 'defineProperties') {
          for (const descriptorMap of resolveDescriptorObjects(
            node.arguments[1],
            assignments,
            node.getStart(sourceFile)
          )) {
            for (const property of descriptorMap.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              for (const descriptor of resolveDescriptorObjects(
                property.initializer,
                assignments,
                node.getStart(sourceFile)
              )) {
                collectDescriptorGetterProperties(descriptor, getterProperties);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return getterProperties;
}

export function isConsumedDescriptorGetterReference(
  node,
  sourceFile,
  consumedDescriptorGetterProperties
) {
  let current = node;
  while (current.parent && current.parent !== sourceFile) {
    const parent = current.parent;
    if (
      (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
      consumedDescriptorGetterProperties.has(parent)
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}
