import ts from 'typescript';

import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import { IDENTITY_WRAPPERS } from './feature-identity-wrappers.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';
import { resolvedLocalValueNodes } from './feature-constructor-local-value-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { pathWasOverwrittenAfter } from './feature-public-commonjs-analysis.mjs';

const PUBLIC_VALUE_TRAPS = new Set(['apply', 'construct', 'get', 'getPrototypeOf']);
const DESCRIPTOR_TRAP = 'getOwnPropertyDescriptor';

function valueAlternatives(expression, sourceFile, visited = new Set()) {
  const current = expression && unwrapExpression(expression);
  if (!current || visited.has(current)) return [];
  const nextVisited = new Set(visited).add(current);

  if (ts.isIdentifier(current)) {
    const resolved = resolvedLocalValueNodes(current, sourceFile, { captureOuter: true });
    const alternatives = resolved.filter((candidate) => unwrapExpression(candidate) !== current);
    return alternatives.length > 0
      ? alternatives.flatMap((candidate) =>
          valueAlternatives(candidate, sourceFile, nextVisited)
        )
      : [current];
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...valueAlternatives(current.whenTrue, sourceFile, nextVisited),
      ...valueAlternatives(current.whenFalse, sourceFile, nextVisited),
    ];
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return valueAlternatives(current.right, sourceFile, nextVisited);
  }
  if (ts.isCallExpression(current)) {
    const method = memberAccess(current.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      isUnshadowedGlobalValueReference(method.receiver) &&
      IDENTITY_WRAPPERS.has(method.name) &&
      current.arguments[0]
    ) {
      return valueAlternatives(current.arguments[0], sourceFile, nextVisited);
    }
  }
  return [current];
}

function callableAlternatives(expression, sourceFile) {
  return valueAlternatives(expression, sourceFile).filter(
    (candidate) => ts.isFunctionLike(candidate) && candidate.body
  );
}

function returnedExpressions(callable) {
  if (!callable.body) return [];
  if (!ts.isBlock(callable.body)) return [callable.body];

  const returned = [];
  const visit = (node) => {
    if (node !== callable && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returned.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  return returned;
}

function propertyCallable(property, sourceFile) {
  if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
    return property.body ? [property] : [];
  }
  if (ts.isPropertyAssignment(property)) {
    return callableAlternatives(property.initializer, sourceFile);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return callableAlternatives(property.name, sourceFile);
  }
  return [];
}

function selectedTrapCallables(handler, trapName, sourceFile) {
  for (const property of [...handler.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return [];
    if (!('name' in property) || !property.name) continue;
    const name = propertyNameText(property.name);
    if (name === '*') return [];
    if (name === trapName) return propertyCallable(property, sourceFile);
  }
  return [];
}

function effectiveDescriptorProperty(descriptor, propertyName) {
  for (const property of [...descriptor.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return null;
    if (!('name' in property) || !property.name) continue;
    const name = propertyNameText(property.name);
    if (name === '*') return null;
    if (name === propertyName) return property;
  }
  return null;
}

function descriptorExposesReference(expression, reference, sourceFile) {
  return valueAlternatives(expression, sourceFile).some((candidate) => {
    const descriptor = unwrapExpression(candidate);
    if (!ts.isObjectLiteralExpression(descriptor)) return false;

    const valueProperty = effectiveDescriptorProperty(descriptor, 'value');
    if (
      valueProperty &&
      ((ts.isPropertyAssignment(valueProperty) &&
        containsReference(valueProperty.initializer, reference)) ||
        (ts.isShorthandPropertyAssignment(valueProperty) &&
          containsReference(valueProperty.name, reference)))
    ) {
      return true;
    }

    const getterProperty = effectiveDescriptorProperty(descriptor, 'get');
    if (!getterProperty) return false;
    if (
      ts.isPropertyAssignment(getterProperty) &&
      ts.isIdentifier(unwrapExpression(getterProperty.initializer)) &&
      containsReference(getterProperty.initializer, reference)
    ) {
      return true;
    }
    return propertyCallable(getterProperty, sourceFile).some((getter) =>
      returnedExpressions(getter).some((returned) => containsReference(returned, reference))
    );
  });
}

function trapExposesReference(surface, reference, sourceFile) {
  return returnedExpressions(surface.callable).some((returned) =>
    surface.trapName === DESCRIPTOR_TRAP
      ? descriptorExposesReference(returned, reference, sourceFile)
      : containsReference(returned, reference)
  );
}

function isNativeProxyConstruction(node) {
  const callee = ts.isNewExpression(node) && unwrapExpression(node.expression);
  const globalAccess = callee && memberAccess(callee);
  return (
    ts.isNewExpression(node) &&
    ((ts.isIdentifier(callee) &&
      callee.text === 'Proxy' &&
      isUnshadowedGlobalValueReference(callee)) ||
      (globalAccess?.name === 'Proxy' &&
        ts.isIdentifier(globalAccess.receiver) &&
        globalAccess.receiver.text === 'globalThis' &&
        isUnshadowedGlobalValueReference(globalAccess.receiver))) &&
    Boolean(node.arguments?.[1])
  );
}

function proxyConstructionsInPublicValue(expression) {
  const proxies = [];
  const visit = (node) => {
    const current = unwrapExpression(node);
    if (isNativeProxyConstruction(current)) {
      proxies.push(current);
      return;
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return;
    ts.forEachChild(current, visit);
  };
  if (expression) visit(expression);
  return proxies;
}

function directCommonJsPublicValues(sourceFile, targetPathsAt, finalPropertyWrites) {
  if (!targetPathsAt || !finalPropertyWrites) return [];
  const publicValues = [];
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      return;
    }
    const targetPaths = targetPathsAt(node.left, node.getStart(sourceFile));
    if (
      targetPaths.some(
        (path) => !pathWasOverwrittenAfter(finalPropertyWrites, path, node.end)
      )
    ) {
      publicValues.push({ expression: node.right, owner: targetPaths[0]?.[0] ?? '*' });
    }
  });
  return publicValues;
}

export function analyzePublicProxySurfaces({
  bindingModel,
  commonJsFinalTargetPaths,
  finalCommonJsPropertyWrites,
  commonJsTargetPaths,
  directCommonJsExpression,
  identityOwners,
  sourceFile,
}) {
  const publicValues = [];
  const publicKeys = new Set([...identityOwners.keys(), ...commonJsTargetPaths.keys()]);
  for (const key of publicKeys) {
    const binding = bindingModel.versions.get(key);
    if (!binding) continue;
    const commonJsPath = commonJsTargetPaths.get(key)?.[0] ?? [];
    const owner = identityOwners.get(key) ?? commonJsPath[0] ?? '*';
    publicValues.push(
      ...(binding.candidateInitializers ?? [binding.initializer]).map((expression) => ({
        expression,
        owner,
      }))
    );
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      publicValues.push({ expression: statement.expression, owner: 'default' });
    }
  }
  if (directCommonJsExpression) {
    publicValues.push({ expression: directCommonJsExpression, owner: '*' });
  }
  publicValues.push(
    ...directCommonJsPublicValues(
      sourceFile,
      commonJsFinalTargetPaths,
      finalCommonJsPropertyWrites
    )
  );

  const surfaces = [];
  const seenCallables = new Set();
  for (const publicValue of publicValues) {
    for (const proxy of proxyConstructionsInPublicValue(publicValue.expression)) {
      const handlerExpression = proxy.arguments?.[1];
      for (const candidate of valueAlternatives(handlerExpression, sourceFile)) {
        const handler = unwrapExpression(candidate);
        if (!ts.isObjectLiteralExpression(handler)) continue;
        for (const trapName of [...PUBLIC_VALUE_TRAPS, DESCRIPTOR_TRAP]) {
          for (const callable of selectedTrapCallables(handler, trapName, sourceFile)) {
            const key = `${publicValue.owner}:${trapName}:${callable.pos}:${callable.end}`;
            if (seenCallables.has(key)) continue;
            seenCallables.add(key);
            surfaces.push({ callable, owner: publicValue.owner, trapName });
          }
        }
      }
    }
  }

  return {
    classifyReference(reference) {
      let insidePublicTrap = false;
      for (const surface of surfaces) {
        if (!containsReference(surface.callable, reference)) continue;
        insidePublicTrap = true;
        if (trapExposesReference(surface, reference, sourceFile)) {
          return {
            localName: surface.owner,
            selection: { getterOnly: false, localMember: '*' },
          };
        }
      }
      return insidePublicTrap ? { selection: null } : undefined;
    },
  };
}
