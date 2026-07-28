import ts from 'typescript';

import { isIdentifierReference } from './feature-export-analysis.mjs';
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
  const globalThisSpecifier = (node) => {
    const isDirectPropertyAccess =
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis';
    const isDirectElementAccess =
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis';
    if (!isDirectPropertyAccess && !isDirectElementAccess) return null;
    if (!isUnshadowedGlobalValueReference(node.expression)) return null;

    const propertyName = isDirectPropertyAccess
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    return propertyName ? (RUNTIME_GLOBAL_SPECIFIERS.get(propertyName) ?? null) : null;
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
