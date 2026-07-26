import ts from 'typescript';

import { memberAccess, propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';

function uniqueNodes(nodes) {
  return [...new Map(nodes.map((node) => [`${node.pos}:${node.end}`, node])).values()];
}

export function resolveObjectLiterals(
  expression,
  beforePosition,
  resolveBinding,
  visited = new Set(),
  memo = new Map()
) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  const memoKey = `${current.pos}:${current.end}:${beforePosition}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, []);

  let resolved = [];
  if (ts.isObjectLiteralExpression(current)) {
    resolved = [current];
  } else if (ts.isConditionalExpression(current)) {
    resolved = [
      ...resolveObjectLiterals(
        current.whenTrue,
        beforePosition,
        resolveBinding,
        new Set(visited),
        memo
      ),
      ...resolveObjectLiterals(
        current.whenFalse,
        beforePosition,
        resolveBinding,
        new Set(visited),
        memo
      ),
    ];
  } else if (ts.isIdentifier(current)) {
    const binding = resolveBinding(current.text, beforePosition);
    if (binding && !visited.has(binding.key)) {
      resolved = resolveObjectLiterals(
        binding.expression,
        binding.beforePosition,
        resolveBinding,
        new Set(visited).add(binding.key),
        memo
      );
    }
  } else {
    const access = memberAccess(current);
    if (access) {
      resolved = resolveObjectLiterals(
        access.receiver,
        beforePosition,
        resolveBinding,
        visited,
        memo
      ).flatMap((object) => {
        const property = object.properties.find(
          (candidate) =>
            (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
            propertyNameText(candidate.name) === access.name
        );
        if (property && ts.isPropertyAssignment(property)) {
          return resolveObjectLiterals(
            property.initializer,
            beforePosition,
            resolveBinding,
            visited,
            memo
          );
        }
        return property && ts.isShorthandPropertyAssignment(property)
          ? resolveObjectLiterals(property.name, beforePosition, resolveBinding, visited, memo)
          : [];
      });
    }
  }
  const unique = uniqueNodes(resolved);
  memo.set(memoKey, unique);
  return unique;
}
