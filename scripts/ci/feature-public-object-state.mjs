import ts from 'typescript';

import { memberAccess, propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';

export const LOGICAL_ASSIGNMENT_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function uniqueRanges(ranges) {
  return [...new Map(ranges.map((range) => [`${range.start}:${range.end}`, range])).values()];
}

export function staticPublicValueState(expression) {
  const current = unwrapExpression(expression);
  if (
    current.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(current) ||
    (ts.isIdentifier(current) &&
      current.text === 'undefined' &&
      isUnshadowedGlobalValueReference(current))
  ) {
    return 'nullish';
  }
  if (current.kind === ts.SyntaxKind.FalseKeyword) return 'falsy';
  if (current.kind === ts.SyntaxKind.TrueKeyword) return 'truthy';
  if (ts.isNumericLiteral(current)) return Number(current.text) === 0 ? 'falsy' : 'truthy';
  if (ts.isBigIntLiteral(current)) {
    return BigInt(current.text.slice(0, -1)) === 0n ? 'falsy' : 'truthy';
  }
  if (ts.isStringLiteralLike(current)) return current.text.length === 0 ? 'falsy' : 'truthy';
  return ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isFunctionLike(current) ||
    ts.isClassLike(current) ||
    ts.isNewExpression(current)
    ? 'truthy'
    : 'unknown';
}

function logicalAssignmentDecision(operator, currentState) {
  if (currentState === 'unknown') return null;
  if (operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
    return currentState === 'truthy';
  }
  if (operator === ts.SyntaxKind.BarBarEqualsToken) {
    return currentState !== 'truthy';
  }
  return currentState === 'nullish';
}

function clearsExposedObject(operator, valueState) {
  return (
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
    (valueState === 'falsy' || valueState === 'nullish')
  );
}

function mergedValueState(left, right) {
  return left === right ? left : 'unknown';
}

export function collectOrdinaryPropertyDefinitions(expression, prefix = []) {
  const definitions = [];
  const collect = (value, pathPrefix) => {
    const current = unwrapExpression(value);
    if (ts.isCallExpression(current)) {
      const method = memberAccess(current.expression);
      if (
        method &&
        ts.isIdentifier(method.receiver) &&
        method.receiver.text === 'Object' &&
        method.name === 'assign' &&
        current.arguments[0]
      ) {
        collect(current.arguments[0], pathPrefix);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(current)) return;
    for (const property of current.properties) {
      if (
        !property.name ||
        (!ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property) &&
          !ts.isMethodDeclaration(property) &&
          !ts.isGetAccessorDeclaration(property) &&
          !ts.isSetAccessorDeclaration(property))
      ) {
        continue;
      }
      const path = [...pathPrefix, propertyNameText(property.name)];
      const accessorKind = ts.isGetAccessorDeclaration(property)
        ? 'get'
        : ts.isSetAccessorDeclaration(property)
          ? 'set'
          : undefined;
      const propertyValue = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : property;
      definitions.push({
        accessorKind,
        configurable: true,
        end: property.end,
        enumerable: true,
        path,
        position: property.getStart(),
        referenceNodes: [propertyValue],
        valueState: accessorKind ? 'unknown' : staticPublicValueState(propertyValue),
        writable: accessorKind ? false : true,
      });
      if (ts.isPropertyAssignment(property)) collect(property.initializer, path);
    }
  };
  collect(expression, prefix);
  return definitions;
}

export function createPublicObjectState() {
  const states = new Map();
  const stateKey = (sourceKey, path) => `${sourceKey}:${JSON.stringify(path)}`;
  const removeDescendants = (sourceKey, path) => {
    for (const [key, state] of states) {
      if (
        state.sourceKey === sourceKey &&
        state.path.length > path.length &&
        path.every((segment, index) => state.path[index] === segment)
      ) {
        states.delete(key);
      }
    }
  };
  const applyWrite = ({
    accessorKind,
    configurable,
    definition = false,
    enumerable,
    frozen = false,
    locked = false,
    logicalOperator,
    path,
    recordsValue = true,
    referenceRanges = [],
    removed = false,
    sourceKey,
    valueState = 'unknown',
    writable,
  }) => {
    const key = stateKey(sourceKey, path);
    const current = states.get(key);
    if (removed) {
      if (current?.configurable !== true || locked) return { recordsWrite: false };
      states.delete(key);
      removeDescendants(sourceKey, path);
      return { enumerable: true, recordsWrite: true, referenceRanges: [] };
    }
    if (frozen || (!definition && current?.writable === false)) {
      return { recordsWrite: false };
    }

    let decision = true;
    let nextValueState = valueState;
    let nextRanges = uniqueRanges(referenceRanges);
    let definitelyReplaces = true;
    if (logicalOperator) {
      decision = logicalAssignmentDecision(logicalOperator, current?.valueState ?? 'nullish');
      if (decision === false) return { recordsWrite: false };
      const terminalClear = decision === null && clearsExposedObject(logicalOperator, valueState);
      if (decision === null && !terminalClear) {
        nextRanges = uniqueRanges([...(current?.referenceRanges ?? []), ...nextRanges]);
        nextValueState = mergedValueState(current?.valueState ?? 'nullish', valueState);
        definitelyReplaces = false;
      }
    }

    const next = {
      configurable: definition
        ? current?.configurable === false || locked
          ? false
          : (configurable ?? current?.configurable ?? false)
        : (current?.configurable ?? true),
      enumerable: definition
        ? (enumerable ?? current?.enumerable ?? false)
        : (current?.enumerable ?? true),
      kind: accessorKind ? 'accessor' : definition ? (current?.kind ?? 'data') : 'data',
      path,
      referenceRanges: current?.referenceRanges ?? [],
      sourceKey,
      valueState: current?.valueState ?? 'unknown',
      writable: definition
        ? current?.configurable === false && current?.writable === false
          ? false
          : (writable ?? current?.writable ?? false)
        : (current?.writable ?? true),
    };
    if (recordsValue) {
      if (accessorKind) {
        const accessorRanges = current?.kind === 'accessor' ? { ...current.accessorRanges } : {};
        accessorRanges[accessorKind] = nextRanges;
        next.accessorRanges = accessorRanges;
        next.referenceRanges = uniqueRanges(Object.values(accessorRanges).flat());
      } else {
        next.referenceRanges = nextRanges;
      }
      next.valueState = nextValueState;
      if (definitelyReplaces) removeDescendants(sourceKey, path);
    }
    states.set(key, next);
    return {
      enumerable: next.enumerable,
      recordsWrite: recordsValue,
      referenceRanges: next.referenceRanges,
    };
  };

  const applyCopyRelation = (relation, equivalentSourceKeys) => {
    const candidates = [];
    for (const sourceKey of equivalentSourceKeys(relation.sourceKey)) {
      for (const state of states.values()) {
        if (
          state.sourceKey === sourceKey &&
          state.enumerable === true &&
          relation.path.every((segment, index) => state.path[index] === segment)
        ) {
          const relativePath = state.path.slice(relation.path.length);
          if (
            relativePath.length > 0 &&
            !relation.overwrittenPaths.some((overwrittenPath) =>
              overwrittenPath.every((segment, index) => relativePath[index] === segment)
            )
          ) {
            candidates.push({ relativePath, state });
          }
        }
      }
    }
    candidates.sort((left, right) => left.relativePath.length - right.relativePath.length);
    const rejectedRoots = new Set();
    for (const { relativePath, state } of candidates) {
      const root = relativePath[0];
      if (rejectedRoots.has(root)) continue;
      const targetPath = [...(relation.targetPath ?? []), ...relativePath];
      if (relativePath.length === 1) {
        const spread = relation.copyKind === 'spread';
        const result = applyWrite({
          configurable: spread ? true : undefined,
          definition: spread,
          enumerable: spread ? true : undefined,
          path: targetPath,
          recordsValue: true,
          referenceRanges: state.referenceRanges,
          sourceKey: relation.ownerKey,
          valueState: state.valueState,
          writable: spread ? true : undefined,
        });
        if (!result.recordsWrite) rejectedRoots.add(root);
      } else {
        states.set(stateKey(relation.ownerKey, targetPath), {
          ...state,
          path: targetPath,
          sourceKey: relation.ownerKey,
        });
      }
    }
  };

  return { applyCopyRelation, applyWrite };
}
