import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';
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

function literalBoolean(expression) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function descriptorBooleanStates(
  descriptor,
  name,
  bindingModel,
  beforePosition,
  initialStates = new Set([undefined]),
  visited = new Set()
) {
  const key = `${descriptor.pos}:${descriptor.end}`;
  if (visited.has(key)) return initialStates;
  const nextVisited = new Set(visited).add(key);
  let states = initialStates;
  for (const property of descriptor.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!bindingModel) {
        states = new Set([undefined]);
        continue;
      }
      const spreadObjects = resolveDescriptorObjects(
        property.expression,
        bindingModel,
        beforePosition
      );
      if (spreadObjects.length === 0) {
        states = new Set([undefined]);
        continue;
      }
      states = new Set(
        spreadObjects.flatMap((spreadObject) => [
          ...descriptorBooleanStates(
            spreadObject,
            name,
            bindingModel,
            beforePosition,
            states,
            nextVisited
          ),
        ])
      );
    } else if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) {
      states = new Set([literalBoolean(property.initializer)]);
    }
  }
  return states;
}

export function descriptorBooleanSetting(descriptor, name, bindingModel, beforePosition) {
  const states = descriptorBooleanStates(descriptor, name, bindingModel, beforePosition);
  return states.size === 1 ? [...states][0] : undefined;
}

export function descriptorIsEnumerable(descriptor, bindingModel, beforePosition) {
  return descriptorBooleanSetting(descriptor, 'enumerable', bindingModel, beforePosition) === true;
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
  const entries = resolveDescriptorObjects(expression, bindingModel, beforePosition).flatMap(
    (descriptorMap) => {
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
            expression: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            name: propertyNameText(property.name),
            references: [ts.isPropertyAssignment(property) ? property.initializer : property.name],
          });
        }
      }
      return [...resolved.values()];
    }
  );
  return current && ts.isIdentifier(current)
    ? entries.map((entry) => ({
        ...entry,
        references: [current, ...entry.references.filter((reference) => reference !== current)],
      }))
    : entries;
}

function staticDescriptorSetting(expression, name, bindingModel, beforePosition) {
  const settings = resolveDescriptorObjects(expression, bindingModel, beforePosition).map(
    (descriptor) => descriptorBooleanSetting(descriptor, name, bindingModel, beforePosition)
  );
  return settings.length > 0 && settings.every((setting) => setting === settings[0])
    ? settings[0]
    : undefined;
}

export function staticDescriptorIsConfigurable(expression, bindingModel, beforePosition) {
  return staticDescriptorSetting(expression, 'configurable', bindingModel, beforePosition);
}

export function staticDescriptorIsWritable(expression, bindingModel, beforePosition) {
  return staticDescriptorSetting(expression, 'writable', bindingModel, beforePosition);
}

export function staticDescriptorMapProperties(expression, bindingModel, beforePosition) {
  const properties = new Map();
  for (const entry of resolveDescriptorMapEntries(expression, bindingModel, beforePosition)) {
    const configurable = staticDescriptorIsConfigurable(
      entry.expression,
      bindingModel,
      beforePosition
    );
    const writable = staticDescriptorIsWritable(entry.expression, bindingModel, beforePosition);
    const previous = properties.get(entry.name);
    const mergeSetting = (left, right) => (left === right ? left : undefined);
    properties.set(
      entry.name,
      previous === undefined
        ? { configurable, writable }
        : {
            configurable: mergeSetting(previous.configurable, configurable),
            writable: mergeSetting(previous.writable, writable),
          }
    );
  }
  return [...properties].map(([name, descriptor]) => ({
    ...descriptor,
    path: [name],
  }));
}
