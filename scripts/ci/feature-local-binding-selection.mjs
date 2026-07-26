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
  return propertyNameText(element.propertyName ?? element.name);
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
  return JSON.stringify(selected);
}

function objectProperty(current, name, excluded = []) {
  if (excluded.includes(name)) return null;
  return current.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      propertyNameText(candidate.name) === name
  );
}

function propertyValue(property) {
  return property && (ts.isPropertyAssignment(property) ? property.initializer : property.name);
}

function objectRest(current, excluded) {
  return {
    end: current.end,
    kind: ts.SyntaxKind.ObjectLiteralExpression,
    pos: current.pos,
    properties: current.properties.filter((property) => {
      const name =
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        propertyNameText(property.name);
      return name === false || name === null || !excluded.includes(name);
    }),
  };
}

function arrayRest(current, from) {
  return {
    end: current.end,
    kind: ts.SyntaxKind.ObjectLiteralExpression,
    pos: current.pos,
    properties: current.elements
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

export function resolveLiteralSelection(current, selected, resolve) {
  if (selected.length === 0) return null;
  const [segment, ...remaining] = selected;
  if (ts.isObjectLiteralExpression(current)) {
    if (typeof segment === 'object' && segment.kind === 'object-rest') {
      const rest = objectRest(current, segment.excluded);
      if (remaining.length === 0) return [rest];
      const value = propertyValue(objectProperty(rest, remaining[0]));
      return value ? resolve(value, remaining.slice(1)) : [];
    }
    const value = propertyValue(objectProperty(current, segment));
    return value ? resolve(value, remaining) : [];
  }
  if (ts.isArrayLiteralExpression(current)) {
    if (typeof segment === 'object' && segment.kind === 'array-rest') {
      if (remaining.length === 0) return [arrayRest(current, segment.from)];
      const index = segment.from + Number(remaining[0]);
      const value = current.elements[index];
      return value && !ts.isOmittedExpression(value)
        ? resolve(ts.isSpreadElement(value) ? value.expression : value, remaining.slice(1))
        : [];
    }
    const value = current.elements[Number(segment)];
    return value && !ts.isOmittedExpression(value)
      ? resolve(ts.isSpreadElement(value) ? value.expression : value, remaining)
      : [];
  }
  return null;
}
