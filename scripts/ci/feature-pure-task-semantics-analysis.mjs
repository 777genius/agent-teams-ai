import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

function hasOnlyStaticModuleReferences(source, sourcePath) {
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  let valid = true;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname' || node.text === '__filename') valid = false;
      if (
        node.text === 'module' &&
        (!ts.isPropertyAccessExpression(node.parent) ||
          node.parent.expression !== node ||
          node.parent.name.text !== 'exports')
      ) {
        valid = false;
      }
      if (
        node.text === 'require' &&
        (!ts.isCallExpression(node.parent) || node.parent.expression !== node)
      ) {
        valid = false;
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))
    ) {
      valid = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return valid;
}

export function hasVerifiedPureTaskSemanticsExport(repoRoot, collectModuleEdgesFromSource) {
  try {
    const packageRoot = 'agent-teams-controller';
    const sourceRoot = `${packageRoot}/src/`;
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, packageRoot, 'package.json'), 'utf8')
    );
    const entry = manifest.exports?.['./task-semantics'];
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== 'default,require,types' ||
      entry?.require !== './src/task-semantics.js' ||
      entry.default !== entry.require ||
      entry.types !== './src/task-semantics.d.ts'
    ) {
      return false;
    }
    const pending = [`${sourceRoot}task-semantics.js`, `${sourceRoot}task-semantics.d.ts`];
    const visited = new Set();
    while (pending.length > 0) {
      const sourcePath = pending.pop();
      if (visited.has(sourcePath)) continue;
      visited.add(sourcePath);
      const source = readFileSync(path.join(repoRoot, sourcePath), 'utf8');
      if (!hasOnlyStaticModuleReferences(source, sourcePath)) return false;
      for (const edge of collectModuleEdgesFromSource(source, sourcePath)) {
        // CommonJS module.exports is browser-bundleable; all other runtime globals remain denied.
        if (edge.kind === 'global' && edge.specifier === 'node:module') continue;
        if (!['import', 'export'].includes(edge.kind) || !edge.specifier.startsWith('.')) {
          return false;
        }
        const targetPath = path.posix.normalize(
          path.posix.join(path.posix.dirname(sourcePath), edge.specifier)
        );
        if (!targetPath.startsWith(sourceRoot) || !/\.(?:js|d\.ts)$/.test(targetPath)) {
          return false;
        }
        pending.push(targetPath);
      }
    }
    return true;
  } catch {
    return false;
  }
}
