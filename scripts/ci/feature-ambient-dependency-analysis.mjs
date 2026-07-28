import ts from 'typescript';

import {
  isIdentifierReference,
  isShadowedTypeReference,
  memberAccess,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import {
  reachingLocalValueWrites,
  resolvedLocalValueNodes,
} from './feature-constructor-local-value-analysis.mjs';
import { executedInvocationParameterInitializer } from './feature-executed-iife-analysis.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';
import { forEachChildIncludingJsDoc } from './feature-module-syntax-analysis.mjs';

const SAFE_LANGUAGE_LIB_PATTERN = /^(?:es(?:5|6|20\d{2}|next)(?:\..+)?|decorators(?:\.legacy)?)$/i;
const AMBIENT_TYPE_NAMESPACE_SPECIFIERS = new Map([
  ['Electron', 'electron'],
  ['NodeJS', 'node:types'],
]);
const AMBIENT_TYPE_NAME_SPECIFIERS = new Map(
  [
    'AllowSharedBuffer',
    'BufferEncoding',
    'NodeModule',
    'NodeRequire',
    'NonSharedBuffer',
    'RequireResolve',
  ].map((name) => [name, 'node:types'])
);
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
  ['crypto', 'runtime:crypto'],
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

function jsxRuntimeEdges(sourceFile, sourcePath) {
  let firstJsxNode = null;
  const visit = (node) => {
    if (firstJsxNode) return;
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      firstJsxNode = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!firstJsxNode) return [];

  const pragmaImportSource = sourceFile.pragmas.get('jsximportsource')?.arguments?.factory;
  const importSource =
    typeof pragmaImportSource === 'string' && pragmaImportSource.length > 0
      ? pragmaImportSource.replace(/\/+$/, '')
      : 'react';

  return [
    {
      isTypeOnly: false,
      kind: 'import',
      line: sourceFile.getLineAndCharacterOfPosition(firstJsxNode.getStart(sourceFile)).line + 1,
      source: sourcePath,
      specifier: `${importSource}/jsx-runtime`,
    },
  ];
}

function importDeclaresLocalName(statement, name) {
  if (ts.isImportEqualsDeclaration(statement)) return statement.name.text === name;
  if (!ts.isImportDeclaration(statement)) return false;
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return (
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some((element) => element.name.text === name)
  );
}

function statementDeclaresTypeName(statement, name) {
  if (importDeclaresLocalName(statement, name)) return true;
  const isTypeDeclaration =
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return isTypeDeclaration && ts.isIdentifier(statement.name) && statement.name.text === name;
}

function scopeStatements(node) {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  return ts.isCaseBlock(node)
    ? node.clauses.flatMap((clause) => clause.statements)
    : [];
}

function isShadowedAmbientTypeReference(reference, sourceFile) {
  if (isShadowedTypeReference(reference, sourceFile)) return true;
  let current = reference.parent;
  while (current) {
    if (
      scopeStatements(current).some((statement) =>
        statementDeclaresTypeName(statement, reference.text)
      )
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function outermostEntityAccess(reference) {
  let current = reference;
  while (
    (ts.isQualifiedName(current.parent) && current.parent.left === current) ||
    (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current)
  ) {
    current = current.parent;
  }
  return current;
}

function typeEntityUsage(reference) {
  const entity = outermostEntityAccess(reference);
  const parent = entity.parent;
  if (ts.isTypeReferenceNode(parent) && parent.typeName === entity) {
    return { entity, space: 'type' };
  }
  if (ts.isTypeQueryNode(parent) && parent.exprName === entity) {
    return { entity, space: 'value' };
  }
  if (!ts.isExpressionWithTypeArguments(parent) || parent.expression !== entity) {
    return null;
  }

  const heritage = parent.parent;
  const extendsClass =
    ts.isHeritageClause(heritage) &&
    heritage.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(heritage.parent);
  return { entity, space: extendsClass ? 'value' : 'type' };
}

function ambientTypeNamespaceEdges(sourceFile, sourcePath) {
  const edges = [];
  const ambientSpecifierForReference = (reference, specifiers, space) => {
    if (!ts.isIdentifier(reference) || !specifiers.has(reference.text)) return null;
    const isTypeShadowed = isShadowedAmbientTypeReference(reference, sourceFile);
    const isValueShadowed = !isUnshadowedGlobalValueReference(reference);
    const isShadowed =
      space === 'type'
        ? isTypeShadowed
        : space === 'value'
          ? isValueShadowed
          : isTypeShadowed || isValueShadowed;
    return isShadowed ? null : specifiers.get(reference.text);
  };
  const rootEntityName = (entityName) => {
    let current = entityName;
    while (ts.isQualifiedName(current)) current = current.left;
    return ts.isIdentifier(current) ? current : null;
  };
  const visit = (node) => {
    const directUsage = ts.isIdentifier(node) ? typeEntityUsage(node) : null;
    const directSpecifiers =
      directUsage?.entity === node
        ? AMBIENT_TYPE_NAME_SPECIFIERS
        : AMBIENT_TYPE_NAMESPACE_SPECIFIERS;
    const aliasReference =
      ts.isImportEqualsDeclaration(node) &&
      !ts.isExternalModuleReference(node.moduleReference)
        ? rootEntityName(node.moduleReference)
        : null;
    const reference = directUsage ? node : aliasReference;
    const specifier = reference
      ? ambientSpecifierForReference(
          reference,
          directUsage ? directSpecifiers : AMBIENT_TYPE_NAMESPACE_SPECIFIERS,
          directUsage?.space ?? 'namespace'
        )
      : null;
    if (specifier) {
      edges.push({
        isTypeOnly: true,
        kind: 'reference',
        line: sourceFile.getLineAndCharacterOfPosition(reference.getStart(sourceFile)).line + 1,
        source: sourcePath,
        specifier,
      });
    }
    forEachChildIncludingJsDoc(node, visit);
  };
  visit(sourceFile);
  return edges;
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
  let invocationsByCallable = null;
  const collectLocalInvocations = () => {
    if (invocationsByCallable) return invocationsByCallable;
    invocationsByCallable = new Map();
    const visitCall = (node) => {
      if (ts.isCallExpression(node)) {
        const access = memberAccess(node.expression);
        const isCallMethod = access?.name === 'call';
        const target = isCallMethod ? access.receiver : node.expression;
        if (!access || isCallMethod) {
          for (const callable of resolvedLocalValueNodes(target, sourceFile, {
            captureOuter: true,
          })) {
            if (!ts.isFunctionLike(callable)) continue;
            const invocations = invocationsByCallable.get(callable) ?? [];
            invocations.push({
              arguments: isCallMethod ? node.arguments.slice(1) : [...node.arguments],
              call: node,
            });
            invocationsByCallable.set(callable, invocations);
          }
        }
      }
      ts.forEachChild(node, visitCall);
    };
    visitCall(sourceFile);
    return invocationsByCallable;
  };
  const parameterArgumentWrites = (write) => {
    if (!ts.isParameter(write.node) || !ts.isFunctionLike(write.node.parent)) return [];
    const callable = write.node.parent;
    const parameterIndex = callable.parameters.indexOf(write.node);
    if (parameterIndex < 0 || write.node.dotDotDotToken) return [];

    return (collectLocalInvocations().get(callable) ?? []).flatMap((invocation) => {
      const value = executedInvocationParameterInitializer(
        write.node,
        invocation.arguments[parameterIndex]
      );
      return value
        ? [
            {
              key: `${write.key}:call:${invocation.call.pos}`,
              selected: write.selected,
              value,
            },
          ]
        : [];
    });
  };
  const globalThisSelections = (expression, selected = [], visited = new Set()) => {
    const current = expression && unwrapExpression(expression);
    if (!current) return [];
    if (ts.isIdentifier(current)) {
      if (current.text === 'globalThis' && isUnshadowedGlobalValueReference(current)) {
        return [selected];
      }
      return reachingLocalValueWrites(current, sourceFile, { captureOuter: true }).flatMap(
        (write) => {
          const candidates = [
            ...(write.value ? [write] : []),
            ...parameterArgumentWrites(write),
          ];
          return candidates.flatMap(({ key, selected: writeSelection, value }) => {
            if (visited.has(key)) return [];
            return globalThisSelections(
              value,
              [...writeSelection, ...selected],
              new Set(visited).add(key)
            );
          });
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
    ...jsxRuntimeEdges(sourceFile, sourcePath),
    ...ambientTypeNamespaceEdges(sourceFile, sourcePath),
    ...runtimeGlobalEdges(sourceFile, sourcePath),
  ];
}
