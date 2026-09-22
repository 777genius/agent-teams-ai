import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';

function fallbackBindings(bindings, expression) {
  return expression
    ? bindings.map((binding) => ({
        ...binding,
        fallback: { expression, selected: [] },
      }))
    : bindings;
}

function objectElements(current) {
  return ts.isObjectLiteralExpression(current) ? current.properties : current.elements;
}

function objectKey(element) {
  const name = element.propertyName ?? element.name;
  return name && ts.isComputedPropertyName(name)
    ? { expression: name.expression, kind: 'computed-key' }
    : propertyNameText(name);
}

export function selectedBindings(pattern, path = []) {
  const current = unwrapExpression(pattern);
  if (ts.isIdentifier(current)) return [{ identifier: current, path }];
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return fallbackBindings(selectedBindings(current.left, path), current.right);
  }
  if (ts.isObjectBindingPattern(current) || ts.isObjectLiteralExpression(current)) {
    const elements = objectElements(current);
    const excluded = elements
      .filter((element) => !(element.dotDotDotToken || ts.isSpreadAssignment(element)))
      .map(objectKey)
      .filter((name) => name !== null);
    return elements.flatMap((element) => {
      const rest = element.dotDotDotToken || ts.isSpreadAssignment(element);
      const target = ts.isPropertyAssignment(element)
        ? element.initializer
        : (element.name ?? element.expression);
      if (!target) return [];
      const segment = rest ? { excluded, kind: 'object-rest' } : objectKey(element);
      const bindings = selectedBindings(target, [...path, segment]);
      const initializer =
        (ts.isBindingElement(element) && element.initializer) ||
        (ts.isShorthandPropertyAssignment(element) && element.objectAssignmentInitializer);
      return fallbackBindings(bindings, initializer);
    });
  }
  if (ts.isArrayBindingPattern(current) || ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return [];
      const rest = element.dotDotDotToken || ts.isSpreadElement(element);
      const target = ts.isBindingElement(element)
        ? element.name
        : ts.isSpreadElement(element)
          ? element.expression
          : element;
      const segment = rest ? { from: index, kind: 'array-rest' } : String(index);
      const bindings = selectedBindings(target, [...path, segment]);
      return fallbackBindings(
        bindings,
        ts.isBindingElement(element) ? element.initializer : undefined
      );
    });
  }
  return [];
}

export function selectionKey(selected) {
  return JSON.stringify(selected, (_key, value) =>
    value?.kind === 'computed-key'
      ? { end: value.expression.end, kind: value.kind, pos: value.expression.pos }
      : value
  );
}

function emptyResolution() {
  return { missing: true, nodes: [], unknown: false };
}

function mergeResolutions(...resolutions) {
  return {
    missing: resolutions.some(({ missing }) => missing),
    nodes: resolutions.flatMap(({ nodes }) => nodes),
    unknown: resolutions.some(({ unknown }) => unknown),
  };
}

function overlayResolution(previous, incoming) {
  return {
    missing: previous.missing && incoming.missing,
    nodes: incoming.missing ? [...previous.nodes, ...incoming.nodes] : incoming.nodes,
    unknown: previous.unknown || incoming.unknown,
  };
}

function resolvedKeyNames(key, resolveKey) {
  if (typeof key === 'string') return [key];
  if (key?.kind === 'computed-key') return resolveKey(key.expression);
  return [];
}

function propertyKeyNames(property, resolveKey) {
  if (!property.name) return [];
  return ts.isComputedPropertyName(property.name)
    ? resolveKey(property.name.expression)
    : [propertyNameText(property.name)].filter((name) => name !== null);
}

function propertyValue(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return null;
}

function objectPropertySelection(current, segment, remaining, resolve, resolveKey) {
  const selectedNames = resolvedKeyNames(segment, resolveKey);
  if (selectedNames.length === 0) return { ...emptyResolution(), unknown: true };

  let resolution = emptyResolution();
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = mergeResolutions(
        ...selectedNames.map((name) => resolve(property.expression, [name, ...remaining]))
      );
      resolution = overlayResolution(resolution, spread);
      continue;
    }
    const value = propertyValue(property);
    if (!value) continue;
    const names = propertyKeyNames(property, resolveKey);
    if (names.some((name) => selectedNames.includes(name))) {
      const incoming = resolve(value, remaining);
      resolution = names.length === 1 ? incoming : mergeResolutions(resolution, incoming);
    } else if (names.length === 0 && property.name && ts.isComputedPropertyName(property.name)) {
      resolution = mergeResolutions(resolution, resolve(value, remaining), {
        missing: false,
        nodes: [],
        unknown: true,
      });
    }
  }
  return resolution;
}

function objectRest(current, excluded, resolveKey) {
  return {
    end: current.end,
    kind: ts.SyntaxKind.ObjectLiteralExpression,
    pos: current.pos,
    properties: current.properties,
    restExclusions: excluded.flatMap((key) => resolvedKeyNames(key, resolveKey)),
  };
}

function arrayElementVariants(current, resolve, visited = new Set()) {
  const key = `${current.pos}:${current.end}`;
  if (visited.has(key)) return [[...current.elements]];
  const nextVisited = new Set(visited).add(key);
  let variants = [[]];
  for (const element of current.elements) {
    if (!ts.isSpreadElement(element)) {
      variants = variants.map((items) => [...items, element]);
      continue;
    }
    const spread = unwrapExpression(element.expression);
    const arrays = ts.isArrayLiteralExpression(spread)
      ? [spread]
      : resolve(spread, []).nodes.filter((node) => ts.isArrayLiteralExpression(node));
    const spreadVariants = arrays.flatMap((array) =>
      arrayElementVariants(array, resolve, nextVisited)
    );
    const expansions = spreadVariants.length > 0 ? spreadVariants : [[element]];
    variants = variants.flatMap((items) => expansions.map((expanded) => [...items, ...expanded]));
  }
  return variants;
}

function arrayRest(elements, current, from) {
  return {
    end: current.end,
    kind: ts.SyntaxKind.ObjectLiteralExpression,
    pos: current.pos,
    properties: elements
      .slice(from)
      .flatMap((element, index) =>
        ts.isOmittedExpression(element)
          ? []
          : [
              ts.factory.createPropertyAssignment(
                ts.factory.createStringLiteral(String(index)),
                ts.isSpreadElement(element) ? element.expression : element
              ),
            ]
      ),
  };
}

function arrayVariantSelection(elements, index, remaining, resolve) {
  const value = elements[index];
  if (value && !ts.isOmittedExpression(value) && !ts.isSpreadElement(value)) {
    return resolve(value, remaining);
  }
  let offset = 0;
  const candidates = [];
  for (const element of elements) {
    if (ts.isSpreadElement(element)) {
      if (index >= offset) {
        candidates.push(resolve(element.expression, [String(index - offset), ...remaining]));
      }
      continue;
    }
    if (offset === index && !ts.isOmittedExpression(element)) {
      candidates.push(resolve(element, remaining));
    }
    offset += 1;
  }
  return candidates.length > 0
    ? mergeResolutions(...candidates, { missing: true, nodes: [], unknown: true })
    : emptyResolution();
}

function arrayElementSelection(current, index, remaining, resolve) {
  return mergeResolutions(
    ...arrayElementVariants(current, resolve).map((elements) =>
      arrayVariantSelection(elements, index, remaining, resolve)
    )
  );
}

export function resolveLiteralSelection(current, selected, resolve, resolveKey = () => []) {
  if (selected.length === 0) return null;
  const [segment, ...remaining] = selected;
  if (ts.isObjectLiteralExpression(current)) {
    if (typeof segment === 'object' && segment.kind === 'object-rest') {
      const rest = objectRest(current, segment.excluded, resolveKey);
      return remaining.length === 0
        ? { missing: false, nodes: [rest], unknown: false }
        : resolve(rest, remaining);
    }
    if (current.restExclusions?.includes(segment)) return emptyResolution();
    return objectPropertySelection(current, segment, remaining, resolve, resolveKey);
  }
  if (ts.isArrayLiteralExpression(current)) {
    if (typeof segment === 'object' && segment.kind === 'array-rest') {
      const rests = arrayElementVariants(current, resolve).map((elements) =>
        arrayRest(elements, current, segment.from)
      );
      return remaining.length === 0
        ? { missing: false, nodes: rests, unknown: false }
        : mergeResolutions(...rests.map((rest) => resolve(rest, remaining)));
    }
    return arrayElementSelection(current, Number(segment), remaining, resolve);
  }
  return null;
}
