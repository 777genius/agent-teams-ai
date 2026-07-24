import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');
const NUMBERED_PHASE_NAME = /phase\d+/i;
const COMPATIBILITY_LITERAL_ALLOWLIST = new Set([
  'AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP',
  'agent-teams.phase2-read-bootstrap/v1',
  '^cursor_phase2_(\\d+)_([0-9a-f]{64})$',
]);

interface NamingDiagnostic {
  readonly kind: 'basename' | 'identifier' | 'regex-literal' | 'string-literal';
  readonly path: string;
  readonly value: string;
}

function sourcePaths(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sourcePaths(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

function regexParts(
  node: ts.RegularExpressionLiteral,
  sourceFile: ts.SourceFile
): {
  readonly flags: string;
  readonly pattern: string;
} {
  const text = node.getText(sourceFile);
  const match = /^\/([\s\S]*)\/([a-z]*)$/.exec(text);
  return match ? { pattern: match[1], flags: match[2] } : { pattern: text, flags: '' };
}

function scanSource(path: string, source: string): NamingDiagnostic[] {
  const relativePath = relative(process.cwd(), path);
  const diagnostics: NamingDiagnostic[] = [];
  const sourceBasename = basename(path, extname(path));
  if (NUMBERED_PHASE_NAME.test(sourceBasename)) {
    diagnostics.push({ kind: 'basename', path: relativePath, value: sourceBasename });
  }

  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NUMBERED_PHASE_NAME.test(node.text)) {
      diagnostics.push({ kind: 'identifier', path: relativePath, value: node.text });
    } else if (ts.isStringLiteralLike(node) && NUMBERED_PHASE_NAME.test(node.text)) {
      if (!COMPATIBILITY_LITERAL_ALLOWLIST.has(node.text)) {
        diagnostics.push({ kind: 'string-literal', path: relativePath, value: node.text });
      }
    } else if (ts.isRegularExpressionLiteral(node)) {
      const { flags, pattern } = regexParts(node, sourceFile);
      if (
        NUMBERED_PHASE_NAME.test(pattern) &&
        (flags !== '' || !COMPATIBILITY_LITERAL_ALLOWLIST.has(pattern))
      ) {
        diagnostics.push({
          kind: 'regex-literal',
          path: relativePath,
          value: node.getText(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return diagnostics;
}

describe('stable capability name boundary', () => {
  it('keeps numbered phase names out of every TypeScript source basename and identifier', () => {
    const diagnostics = sourcePaths(SOURCE_ROOT).flatMap((path) =>
      scanSource(path, readFileSync(path, 'utf8'))
    );

    expect(diagnostics).toEqual([]);
  });

  it('rejects numbered phase names in identifiers, basenames, and non-allowlisted literals', () => {
    expect(scanSource('src/example.ts', 'const phase3Reader = "ready";')).toContainEqual({
      kind: 'identifier',
      path: 'src/example.ts',
      value: 'phase3Reader',
    });
    expect(scanSource('src/phase4Reader.ts', 'export {};')).toContainEqual({
      kind: 'basename',
      path: 'src/phase4Reader.ts',
      value: 'phase4Reader',
    });
    expect(scanSource('src/example.ts', 'export const value = "phase5-ready";')).toContainEqual({
      kind: 'string-literal',
      path: 'src/example.ts',
      value: 'phase5-ready',
    });
    expect(scanSource('src/example.ts', 'export const value = /phase6-ready/;')).toContainEqual({
      kind: 'regex-literal',
      path: 'src/example.ts',
      value: '/phase6-ready/',
    });
  });

  it('allows only the three exact read-ingress compatibility literals', () => {
    const source = String.raw`
      const environment = 'AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP';
      const format = 'agent-teams.phase2-read-bootstrap/v1';
      const cursor = /^cursor_phase2_(\d+)_([0-9a-f]{64})$/;
    `;
    expect(scanSource('src/compatibility.ts', source)).toEqual([]);
    expect(
      scanSource('src/compatibility.ts', "const value = 'agent-teams.phase2-read-bootstrap/v2';")
    ).toContainEqual({
      kind: 'string-literal',
      path: 'src/compatibility.ts',
      value: 'agent-teams.phase2-read-bootstrap/v2',
    });
    expect(
      scanSource(
        'src/compatibility.ts',
        String.raw`const value = /^cursor_phase2_(\d+)_([0-9a-f]{64})$/i;`
      )
    ).toContainEqual({
      kind: 'regex-literal',
      path: 'src/compatibility.ts',
      value: String.raw`/^cursor_phase2_(\d+)_([0-9a-f]{64})$/i`,
    });
  });
});
