import ts from 'typescript';

import { propertyNameText, unwrapExpression } from './feature-export-ast.mjs';
import {
  visitDefiniteBlockExpressions,
  visitDefiniteTopLevelExpressions,
} from './feature-definite-execution.mjs';
import {
  executedInvocationForCall,
  executedInvocationParameterInitializer,
  staticTruthiness,
} from './feature-executed-iife-analysis.mjs';

const originalParameterValue = Symbol('original-parameter-value');

function parameterValuesAfterStatement(statement, incoming, parameterName, callable) {
  if (incoming.size === 0) return incoming;
  if (ts.isBlock(statement)) {
    return statement.statements.reduce(
      (values, child) => parameterValuesAfterStatement(child, values, parameterName, callable),
      incoming
    );
  }
  if (ts.isExpressionStatement(statement)) {
    const expression = unwrapExpression(statement.expression);
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrapExpression(expression.left);
      if (
        ts.isIdentifier(target) &&
        target.text === parameterName &&
        assignmentTargetsParameter(target, callable)
      ) {
        const initializer = unwrapExpression(expression.right);
        return ts.isIdentifier(initializer) && initializer.text === parameterName
          ? incoming
          : new Set([expression.right]);
      }
    }
    return incoming;
  }
  if (ts.isIfStatement(statement)) {
    const truthiness = staticTruthiness(statement.expression);
    if (truthiness === true) {
      return parameterValuesAfterStatement(
        statement.thenStatement,
        incoming,
        parameterName,
        callable
      );
    }
    if (truthiness === false) {
      return statement.elseStatement
        ? parameterValuesAfterStatement(statement.elseStatement, incoming, parameterName, callable)
        : incoming;
    }
    const thenValues = parameterValuesAfterStatement(
      statement.thenStatement,
      incoming,
      parameterName,
      callable
    );
    const elseValues = statement.elseStatement
      ? parameterValuesAfterStatement(statement.elseStatement, incoming, parameterName, callable)
      : incoming;
    return new Set([...thenValues, ...elseValues]);
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return new Set();
  }
  return incoming;
}

function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  return bindingName.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function directScopeBindsName(scope, name) {
  const statements =
    ts.isBlock(scope) || ts.isSourceFile(scope)
      ? scope.statements
      : ts.isCaseBlock(scope)
        ? scope.clauses.flatMap((clause) => clause.statements)
        : [];
  return statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return (
        (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0 &&
        statement.declarationList.declarations.some((declaration) =>
          bindingNames(declaration.name).includes(name)
        )
      );
    }
    return (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    );
  });
}

function callableBindsName(callable, name) {
  if (
    callable.parameters.some((parameter) => bindingNames(parameter.name).includes(name)) ||
    callable.name?.text === name
  ) {
    return true;
  }
  let found = false;
  const visit = (node) => {
    if (found || (node !== callable && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (callable.body) visit(callable.body);
  return found;
}

function assignmentTargetsParameter(target, callable) {
  let current = target.parent;
  while (current && current !== callable) {
    if (
      ((ts.isBlock(current) || ts.isCaseBlock(current)) &&
        current !== callable.body &&
        directScopeBindsName(current, target.text)) ||
      (ts.isFunctionLike(current) && callableBindsName(current, target.text)) ||
      (ts.isCatchClause(current) &&
        current.variableDeclaration &&
        bindingNames(current.variableDeclaration.name).includes(target.text))
    ) {
      return false;
    }
    current = current.parent;
  }
  return current === callable;
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
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      topLevelNames.add(statement.name.text);
      addVersion(
        statement.name.text,
        statement,
        ts.isFunctionDeclaration(statement) ? sourceFile.pos : statement.getStart(sourceFile),
        undefined
      );
      continue;
    }
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
    const invocation = executedInvocationForCall(node);
    if (!invocation || !invocation.callable.body) return;
    for (const [index, parameter] of invocation.callable.parameters.entries()) {
      if (parameter.dotDotDotToken) continue;
      const candidateInitializers = [
        ...new Set(
          (invocation.invocations ?? [invocation]).flatMap((candidate) => {
            const argumentsForParameter = candidate.argumentCandidates?.[index] ?? [
              candidate.arguments[index],
            ];
            return argumentsForParameter.flatMap((argument) => {
              const initializer = executedInvocationParameterInitializer(parameter, argument);
              return initializer ? [initializer] : [];
            });
          })
        ),
      ];
      const [initializer] = candidateInitializers;
      if (!initializer) continue;
      const scope = {
        scopeEnd: invocation.callable.body.end,
        scopeStart: invocation.callable.body.pos,
      };
      addBinding(parameter.name, initializer, parameter.getStart(sourceFile), undefined, {
        ...scope,
        candidateInitializers,
      });
      if (!ts.isBlock(invocation.callable.body)) continue;
      const parameterNames = new Set(bindingNames(parameter.name));
      visitDefiniteBlockExpressions(invocation.callable.body, (expression) => {
        if (
          !ts.isBinaryExpression(expression) ||
          expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        ) {
          return;
        }
        const target = unwrapExpression(expression.left);
        if (
          ts.isIdentifier(target) &&
          parameterNames.has(target.text) &&
          assignmentTargetsParameter(target, invocation.callable)
        ) {
          addVersion(target.text, expression.right, expression.end, undefined, scope);
        }
      });
      for (const parameterName of parameterNames) {
        let values = new Set([originalParameterValue]);
        for (const statement of invocation.callable.body.statements) {
          const nextValues = parameterValuesAfterStatement(
            statement,
            values,
            parameterName,
            invocation.callable
          );
          if (
            !ts.isExpressionStatement(statement) &&
            nextValues.size > 0 &&
            [...values].every((value) => !nextValues.has(value))
          ) {
            const candidateInitializers = [...nextValues];
            addVersion(parameterName, candidateInitializers[0], statement.end, undefined, {
              ...scope,
              candidateInitializers,
            });
          }
          values = nextValues;
        }
      }
    }
  });

  for (const events of eventsByName.values()) {
    events.sort((left, right) => left.position - right.position);
  }
  const bindingAt = (name, position) => {
    const events = eventsByName.get(name) ?? [];
    return (
      [...events]
        .reverse()
        .find(
          (event) =>
            event.position <= position &&
            (event.scopeStart === undefined ||
              (event.scopeStart <= position && position <= event.scopeEnd))
        )?.key ?? null
    );
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
