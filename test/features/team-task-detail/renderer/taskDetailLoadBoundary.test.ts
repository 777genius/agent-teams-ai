// @vitest-environment node
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const aliases = (
  JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  }
).compilerOptions.paths;
const rendererEntry = 'src/renderer/main.tsx';
const feature = 'src/features/team-task-detail/renderer/';
const deferredModules = [
  `${feature}index.ts`,
  `${feature}adapters/TaskDetailTab.tsx`,
  `${feature}adapters/TaskDetailPage.tsx`,
  `${feature}ui/TaskDetailContent.tsx`,
  `${feature}ui/TaskDetailBody.tsx`,
  'src/renderer/components/ui/tiptap/TiptapEditor.tsx',
];
const shellModules = [
  `${feature}adapters/TaskDetailReadCoordinator.tsx`,
  `${feature}adapters/TaskDetailEditorRouteFeedback.tsx`,
  `${feature}adapters/TaskDetailReviewRouteFeedback.tsx`,
  `${feature}hooks/useTaskDetailTabLabel.ts`,
  `${feature}context/TaskDetailFileLinkContext.tsx`,
];

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

function sourceGraph(entry: string): {
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

function eagerChain(parents: Map<string, string | null>, target: string): string {
  const chain: string[] = [];
  let current: string | null | undefined = target;
  while (current) {
    chain.push(path.relative(root, current));
    current = parents.get(current);
  }
  return chain.toReversed().join(' -> ');
}

// This is a conservative source import/re-export boundary, not a Vite request
// trace or memory measurement. Normally declared type-only uses may overcount.
describe('TaskDetail renderer load boundary', () => {
  const eager = sourceGraph(rendererEntry);

  it('keeps full TaskDetail UI and its editor outside the eager application graph', () => {
    const reached = deferredModules.filter((file) => eager.parents.has(path.resolve(root, file)));
    const chains = reached.map((file) => eagerChain(eager.parents, path.resolve(root, file)));
    expect(reached, chains.join('\n')).toEqual([]);
  });

  it('keeps the original coordinator, recovery feedback, label and shared context eager', () => {
    expect(shellModules.filter((file) => !eager.parents.has(path.resolve(root, file)))).toEqual([]);
  });

  it.each([
    {
      route: 'task tab',
      from: 'src/renderer/components/layout/PaneContent.tsx',
      to: `${feature}index.ts`,
    },
    {
      route: 'global task dialog',
      from: 'src/renderer/components/layout/GlobalTaskDetailDialogSlot.tsx',
      to: 'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
    },
  ])('retains the existing $route on-demand route to the complete detail UI', ({ from, to }) => {
    expect(eager.deferred).toContainEqual({
      from: path.resolve(root, from),
      to: path.resolve(root, to),
    });
    const opened = sourceGraph(to);
    expect(deferredModules.filter((file) => !opened.parents.has(path.resolve(root, file)))).toEqual(
      []
    );
  });
});
