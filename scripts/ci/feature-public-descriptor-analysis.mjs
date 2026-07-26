import ts from 'typescript';

import {
  isCommonJsExportsObject,
  memberAccess,
  propertyNameText,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { resolveObjectLiterals } from './feature-object-resolution.mjs';
import { accessPath } from './feature-public-object-analysis.mjs';

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

function resolveDescriptorObjects(expression, assignments, beforePosition) {
  return resolveObjectLiterals(expression, beforePosition, (name, position) => {
    const candidates = (assignments.get(name) ?? [])
      .filter((assignment) => assignment.position < position)
      .sort((left, right) => right.position - left.position);
    const latest = candidates[0];
    return latest
      ? {
          beforePosition: latest.position,
          expression: latest.expression,
          key: `${name}:${latest.position}`,
        }
      : null;
  });
}

function resolveDescriptorMapEntries(expression, assignments, beforePosition, visited = new Set()) {
  const current = expression && unwrapExpression(expression);
  const entries = resolveDescriptorObjects(expression, assignments, beforePosition).flatMap(
    (descriptorMap) => {
      const mapKey = `${descriptorMap.pos}:${descriptorMap.end}`;
      if (visited.has(mapKey)) return [];
      const entries = new Map();
      const nextVisited = new Set(visited).add(mapKey);
      for (const property of descriptorMap.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const entry of resolveDescriptorMapEntries(
            property.expression,
            assignments,
            beforePosition,
            nextVisited
          )) {
            entries.set(entry.name, {
              ...entry,
              visibilityReferences: [
                property.expression,
                ...(entry.visibilityReferences ?? entry.references),
              ],
            });
          }
        } else if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          entries.set(propertyNameText(property.name), {
            expression: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            name: propertyNameText(property.name),
            references: [ts.isPropertyAssignment(property) ? property.initializer : property.name],
          });
        }
      }
      return [...entries.values()];
    }
  );
  return current
    ? entries.map((entry) => ({
        ...entry,
        visibilityReferences: [
          current,
          ...(entry.visibilityReferences ?? entry.references).filter(
            (reference) => reference !== current
          ),
        ],
      }))
    : entries;
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

function isPublicTarget(expression, publicTargets, position, memberPath = []) {
  const current = expression && unwrapExpression(expression);
  if (!current) return false;
  const root = rootBindingName(current);
  if (isCommonJsExportsObject(current)) {
    const targets = publicTargets.commonJsTargetsAt(position);
    return root === 'exports' ? targets.directExportsActive : targets.directModuleExportsActive;
  }
  const target = accessPath(current);
  return (
    target !== null &&
    (publicTargets
      .localOwnersAt(position, {
        name: target.root,
        path: [...target.path, ...memberPath],
      })
      .has(target.root) ||
      publicTargets.commonJsTargetsAt(position).has(root))
  );
}

export function collectConsumedDescriptorGetterProperties(sourceFile, publicTargets) {
  const assignments = collectTopLevelAssignments(sourceFile);
  const getterProperties = new Set();
  const referenceMembers = new Map();
  const addReferenceMember = (reference, member) => {
    if (!ts.isIdentifier(reference)) return;
    const members = referenceMembers.get(reference) ?? new Set();
    members.add(member);
    referenceMembers.set(reference, members);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const method = memberAccess(node.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'create'
      ) {
        for (const entry of resolveDescriptorMapEntries(
          node.arguments[1],
          assignments,
          node.getStart(sourceFile)
        )) {
          for (const descriptor of resolveDescriptorObjects(
            entry.expression,
            assignments,
            node.getStart(sourceFile)
          )) {
            collectDescriptorGetterProperties(descriptor, getterProperties);
          }
        }
      }
      const isDescriptorApi =
        method &&
        ts.isIdentifier(method.receiver) &&
        ['Object', 'Reflect'].includes(method.receiver.text);
      if (isDescriptorApi && method.name === 'defineProperty') {
        const descriptorExpression = node.arguments[2] && unwrapExpression(node.arguments[2]);
        for (const descriptor of resolveDescriptorObjects(
          node.arguments[2],
          assignments,
          node.getStart(sourceFile)
        )) {
          const references = [descriptorExpression, descriptor].filter(Boolean);
          if (
            !references.some((reference) =>
              isPublicTarget(
                node.arguments[0],
                publicTargets,
                reference.getStart(sourceFile),
                node.arguments[1] && ts.isStringLiteralLike(unwrapExpression(node.arguments[1]))
                  ? [unwrapExpression(node.arguments[1]).text]
                  : ['*']
              )
            )
          ) {
            continue;
          }
          const beforeCount = getterProperties.size;
          collectDescriptorGetterProperties(descriptor, getterProperties);
          if (descriptorExpression && getterProperties.size > beforeCount) {
            getterProperties.add(descriptorExpression);
          }
        }
      } else if (isDescriptorApi && method.name === 'defineProperties') {
        for (const entry of resolveDescriptorMapEntries(
          node.arguments[1],
          assignments,
          node.getStart(sourceFile)
        )) {
          for (const descriptor of resolveDescriptorObjects(
            entry.expression,
            assignments,
            node.getStart(sourceFile)
          )) {
            const visibilityReferences = [
              ...(entry.visibilityReferences ?? entry.references),
              descriptor,
            ];
            if (
              !visibilityReferences.some((reference) =>
                isPublicTarget(node.arguments[0], publicTargets, reference.getStart(sourceFile), [
                  entry.name,
                ])
              )
            ) {
              continue;
            }
            const beforeCount = getterProperties.size;
            collectDescriptorGetterProperties(descriptor, getterProperties);
            if (getterProperties.size > beforeCount) {
              for (const reference of [...entry.references, descriptor]) {
                getterProperties.add(reference);
              }
              for (const reference of entry.visibilityReferences ?? []) {
                if (!entry.references.includes(reference)) {
                  addReferenceMember(reference, entry.name);
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { getterProperties, referenceMembers };
}

export function consumedDescriptorGetterMembersForReference(
  node,
  sourceFile,
  consumedDescriptorGetters
) {
  const members = new Set();
  let current = node;
  while (current.parent && current.parent !== sourceFile) {
    for (const member of consumedDescriptorGetters.referenceMembers.get(current) ?? []) {
      members.add(member);
    }
    if (consumedDescriptorGetters.getterProperties.has(current)) members.add('*');
    const parent = current.parent;
    if (
      (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
      consumedDescriptorGetters.getterProperties.has(parent)
    ) {
      members.add('*');
    }
    current = parent;
  }
  return [...members];
}

export function isConsumedDescriptorGetterReference(node, sourceFile, consumedDescriptorGetters) {
  return (
    consumedDescriptorGetterMembersForReference(node, sourceFile, consumedDescriptorGetters)
      .length > 0
  );
}
