import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export const sourceRoot = path.resolve(import.meta.dirname, '../..');
const root = sourceRoot;
const aliases = (
  JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  }
).compilerOptions.paths;

// Conservative source imports/re-exports only, not Vite requests or memory.
// Declared type-only uses are excluded; normal imports may overcount type uses.
function localModule(from: string, specifier: string): string | null {
  const clean = specifier.split(/[?#]/)[0];
  let target: string | undefined;
  if (clean.startsWith('.')) target = path.resolve(path.dirname(from), clean);
  for (const [alias, targets] of Object.entries(aliases)) {
    const wildcard = alias.indexOf('*');
    if (wildcard === -1 ? clean !== alias : !clean.startsWith(alias.slice(0, wildcard))) continue;
    target = path.resolve(root, targets[0].replace('*', clean.slice(wildcard)));
    break;
  }
  // External packages are outside this source-graph contract. Every expected
  // relative/configured-alias edge must resolve instead of silently disappearing.
  if (!target) return null;
  const candidates = [
    target.replace(/\.m?js$/, (extension) => (extension === '.mjs' ? '.mts' : '.ts')),
    target,
    ...['.ts', '.tsx', '.mts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map(
      (extension) => `${target}${extension}`
    ),
  ];
  const resolved = candidates.find((candidate) =>
    statSync(candidate, { throwIfNoEntry: false })?.isFile()
  );
  if (!resolved)
    throw new Error(`Unresolved local source edge: ${path.relative(root, from)} -> ${specifier}`);
  return resolved;
}

function eagerSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const clause = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return null;
    const bindings = clause?.namedBindings;
    if (
      !clause?.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((binding) => binding.isTypeOnly)
    )
      return null;
    return statement.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    const bindings = statement.exportClause;
    if (
      bindings &&
      ts.isNamedExports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((binding) => binding.isTypeOnly)
    )
      return null;
    return statement.moduleSpecifier.text;
  }
  return null;
}

function sourceEdges(file: string): { eager: string[]; deferred: string[] } {
  const eager: string[] = [];
  const deferred: string[] = [];
  if (!/\.[cm]?[jt]sx?$/.test(file)) return { eager, deferred };
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const add = (list: string[], specifier: string): void => {
    const resolved = localModule(file, specifier);
    if (resolved) list.push(resolved);
  };
  for (const statement of source.statements) {
    const specifier = eagerSpecifier(statement);
    if (specifier !== null) add(eager, specifier);
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(deferred, node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { eager, deferred };
}

export function sourceGraph(entry: string): {
  parents: Map<string, string | null>;
  deferred: { from: string; to: string }[];
} {
  const start = path.resolve(root, entry);
  const parents = new Map<string, string | null>([[start, null]]);
  const deferred: { from: string; to: string }[] = [];
  const queue = [start];
  for (const file of queue) {
    const edges = sourceEdges(file);
    deferred.push(...edges.deferred.map((to) => ({ from: file, to })));
    for (const target of edges.eager) {
      if (parents.has(target)) continue;
      parents.set(target, file);
      queue.push(target);
    }
  }
  return { parents, deferred };
}

export function eagerChain(parents: Map<string, string | null>, target: string): string {
  const chain: string[] = [];
  let current: string | null | undefined = target;
  while (current) {
    chain.push(path.relative(root, current));
    current = parents.get(current);
  }
  return chain.toReversed().join(' -> ');
}
