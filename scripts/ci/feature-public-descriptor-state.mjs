import ts from 'typescript';

import {
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { resolveObjectLiterals } from './feature-object-resolution.mjs';

function resolveDescriptorObjects(expression, bindingModel, beforePosition) {
  return resolveObjectLiterals(expression, beforePosition, (name, position) => {
    const key = bindingModel.bindingAt(name, position);
    const binding = key && bindingModel.versions.get(key);
    return binding
      ? {
          beforePosition: binding.position,
          expression: binding.initializer,
          key,
        }
      : null;
  });
}

export function descriptorBooleanSetting(descriptor, name) {
  const property = descriptor.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      propertyNameText(candidate.name) === name
  );
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  const value = unwrapExpression(property.initializer);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

export function descriptorIsEnumerable(descriptor) {
  return descriptorBooleanSetting(descriptor, 'enumerable') === true;
}

export function descriptorDefinesValue(descriptor) {
  return descriptor.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property)) &&
      ['get', 'set', 'value'].includes(propertyNameText(property.name))
  );
}

export function resolveDescriptorMapEntries(
  expression,
  bindingModel,
  beforePosition,
  visited = new Set()
) {
  const current = expression && unwrapExpression(expression);
  const entries = resolveDescriptorObjects(
    expression,
    bindingModel,
    beforePosition
  ).flatMap((descriptorMap) => {
    const mapKey = `${descriptorMap.pos}:${descriptorMap.end}`;
    if (visited.has(mapKey)) return [];
    const resolved = new Map();
    const nextVisited = new Set(visited).add(mapKey);
    for (const property of descriptorMap.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const entry of resolveDescriptorMapEntries(
          property.expression,
          bindingModel,
          beforePosition,
          nextVisited
        )) {
          resolved.set(entry.name, {
            ...entry,
            references: [property.expression, ...entry.references],
          });
        }
      } else if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)
      ) {
        resolved.set(propertyNameText(property.name), {
          expression: ts.isPropertyAssignment(property)
            ? property.initializer
            : property.name,
          name: propertyNameText(property.name),
          references: [
            ts.isPropertyAssignment(property) ? property.initializer : property.name,
          ],
        });
      }
    }
    return [...resolved.values()];
  });
  return current && ts.isIdentifier(current)
    ? entries.map((entry) => ({
        ...entry,
        references: [
          current,
          ...entry.references.filter((reference) => reference !== current),
        ],
      }))
    : entries;
}
