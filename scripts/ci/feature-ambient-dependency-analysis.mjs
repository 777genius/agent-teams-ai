import ts from 'typescript';

import {
  isIdentifierReference,
  memberAccess,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { reachingLocalValueWrites } from './feature-constructor-local-value-analysis.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';

const SAFE_LANGUAGE_LIB_PATTERN = /^(?:es(?:5|6|20\d{2}|next)(?:\..+)?|decorators(?:\.legacy)?)$/i;
const RUNTIME_GLOBAL_SPECIFIERS = new Map([
  ['Buffer', 'node:buffer'],
  ['EventSource', 'browser:event-source'],
  ['WebSocket', 'browser:websocket'],
  ['Worker', 'browser:worker'],
  ['__dirname', 'node:module'],
  ['__filename', 'node:module'],
  ['clearImmediate', 'node:timers'],
  ['clearInterval', 'runtime:timers'],
  ['clearTimeout', 'runtime:timers'],
  ['document', 'browser:dom'],
  ['exports', 'node:module'],
  ['fetch', 'browser:fetch'],
  ['global', 'node:global'],
  ['localStorage', 'browser:storage'],
  ['location', 'browser:dom'],
  ['module', 'node:module'],
  ['navigator', 'browser:dom'],
  ['process', 'node:process'],
  ['require', 'node:module'],
  ['sessionStorage', 'browser:storage'],
  ['setImmediate', 'node:timers'],
  ['setInterval', 'runtime:timers'],
  ['setTimeout', 'runtime:timers'],
  ['window', 'browser:dom'],
]);

function referenceDirectiveEdges(sourceFile, sourcePath) {
  const runtimeLibReferences = sourceFile.libReferenceDirectives
    .filter((reference) => !SAFE_LANGUAGE_LIB_PATTERN.test(reference.fileName))
    .map((reference) => ({
      ...reference,
      fileName: `typescript:lib/${reference.fileName}`,
    }));

  return [
    ...sourceFile.typeReferenceDirectives,
    ...sourceFile.referencedFiles,
    ...runtimeLibReferences,
  ].map((reference) => ({
    isTypeOnly: true,
    kind: 'reference',
    line: sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1,
    source: sourcePath,
    specifier: reference.fileName,
  }));
}

function runtimeGlobalEdges(sourceFile, sourcePath) {
  const edges = [];
  let hasGlobalThisReference = false;
  const findGlobalThis = (node) => {
    if (hasGlobalThisReference) return;
    if (ts.isIdentifier(node) && node.text === 'globalThis') {
      hasGlobalThisReference = true;
      return;
    }
    ts.forEachChild(node, findGlobalThis);
  };
  findGlobalThis(sourceFile);
  const globalThisSelections = (expression, selected = [], visited = new Set()) => {
    const current = expression && unwrapExpression(expression);
    if (!current) return [];
    if (ts.isIdentifier(current)) {
      if (current.text === 'globalThis' && isUnshadowedGlobalValueReference(current)) {
        return [selected];
      }
      return reachingLocalValueWrites(current, sourceFile, { captureOuter: true }).flatMap(
        ({ key, selected: writeSelection, value }) => {
          if (visited.has(key)) return [];
          return globalThisSelections(
            value,
            [...writeSelection, ...selected],
            new Set(visited).add(key)
          );
        }
      );
    }

    const access = memberAccess(current);
    return access
      ? globalThisSelections(access.receiver, [access.name, ...selected], visited)
      : [];
  };
  const globalThisSpecifier = (node) => {
    if (!hasGlobalThisReference) return null;
    const isAssignmentTarget =
      ts.isIdentifier(node) &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.left === node &&
      ts.isAssignmentOperator(node.parent.operatorToken.kind);
    const isRuntimeExpression =
      memberAccess(node) ||
      (ts.isIdentifier(node) && !isAssignmentTarget && isIdentifierReference(node));
    if (!isRuntimeExpression) return null;

    for (const selection of globalThisSelections(node)) {
      if (selection.length !== 1 || typeof selection[0] !== 'string') continue;
      const specifier = RUNTIME_GLOBAL_SPECIFIERS.get(selection[0]);
      if (specifier) return specifier;
    }
    return null;
  };
  const visit = (node) => {
    const globalThisDependency = globalThisSpecifier(node);
    const directGlobalDependency =
      ts.isIdentifier(node) &&
      RUNTIME_GLOBAL_SPECIFIERS.has(node.text) &&
      isIdentifierReference(node) &&
      isUnshadowedGlobalValueReference(node)
        ? RUNTIME_GLOBAL_SPECIFIERS.get(node.text)
        : null;
    const specifier = globalThisDependency ?? directGlobalDependency;
    if (specifier) {
      edges.push({
        isTypeOnly: false,
        kind: 'global',
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        source: sourcePath,
        specifier,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

export function collectAmbientDependencyEdges(sourceFile, sourcePath) {
  return [
    ...referenceDirectiveEdges(sourceFile, sourcePath),
    ...runtimeGlobalEdges(sourceFile, sourcePath),
  ];
}
