import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-ast.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { executedIifeForCall } from './feature-executed-iife-analysis.mjs';

function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  return bindingName.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

export function collectBindingModel(sourceFile) {
  const eventsByName = new Map();
  const versions = new Map();
  const topLevelNames = new Set();
  let sequence = 0;

  const addVersion = (name, initializer, position, forcedAlias, scope) => {
    const key = `${name}:${position}:${sequence++}`;
    const version = { forcedAlias, initializer, key, name, position, ...scope };
    versions.set(key, version);
    const events = eventsByName.get(name) ?? [];
    events.push(version);
    eventsByName.set(name, events);
  };
  const addBinding = (bindingName, initializer, position, forcedAlias, scope) => {
    if (ts.isIdentifier(bindingName)) {
      addVersion(bindingName.text, initializer, position, forcedAlias, scope);
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
            },
        scope
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
  for (const statement of sourceFile.statements) visitStatement(statement);

  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    const invocation = executedIifeForCall(node);
    if (!invocation || !invocation.callable.body) return;
    for (const [index, parameter] of invocation.callable.parameters.entries()) {
      if (parameter.dotDotDotToken) continue;
      const argument = invocation.arguments[index] ?? parameter.initializer;
      if (!argument) continue;
      addBinding(
        parameter.name,
        argument,
        parameter.getStart(sourceFile),
        undefined,
        {
          scopeEnd: invocation.callable.body.end,
          scopeStart: invocation.callable.body.pos,
        }
      );
    }
  });

  for (const events of eventsByName.values()) {
    events.sort((left, right) => left.position - right.position);
  }
  const bindingAt = (name, position) => {
    const events = eventsByName.get(name) ?? [];
    return [...events].reverse().find(
      (event) =>
        event.position <= position &&
        (event.scopeStart === undefined ||
          (event.scopeStart <= position && position <= event.scopeEnd))
    )?.key ?? null;
  };
  return { bindingAt, eventsByName, versions };
}

export function collectContainedBindingEntries(expression, bindingModel) {
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
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const [index, element] of current.elements.entries()) {
        if (!ts.isOmittedExpression(element)) {
          visit(element, [...path, String(index)]);
        }
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
