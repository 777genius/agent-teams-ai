import { existsSync, readFileSync } from 'fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const srcRoot = join(repoRoot, 'src');
const contractsRoot = join(srcRoot, 'features/hosted-web-transport/contracts');
const entrypoints = [
  join(contractsRoot, 'index.ts'),
  join(contractsRoot, 'http.ts'),
  join(contractsRoot, 'events.ts'),
  join(contractsRoot, 'primitives.ts'),
];

const forbiddenModulePatterns = [/^electron$/, /^node:electron$/];
const forbiddenPathSegments = [
  normalize('/src/main/'),
  normalize('/src/preload/'),
  normalize('/src/renderer/'),
];

describe('hosted web transport contract dependency boundary', () => {
  it('keeps the public contract graph browser-safe and main-free', () => {
    const visited = new Set<string>();
    const edges: string[] = [];
    const violations: string[] = [];

    for (const entrypoint of entrypoints) {
      walkImports(entrypoint, visited, edges, violations);
    }

    expect(violations).toEqual([]);
    expect(edges).not.toContain(
      'src/features/hosted-web-transport/contracts/http.ts -> @shared/types/team'
    );
    expect(edges).not.toContain(
      'src/features/hosted-web-transport/contracts/events.ts -> @shared/types/team'
    );
  });
});

function walkImports(
  filePath: string,
  visited: Set<string>,
  edges: string[],
  violations: string[]
): void {
  const normalizedFilePath = normalize(filePath);
  if (visited.has(normalizedFilePath)) {
    return;
  }
  visited.add(normalizedFilePath);

  const source = readFileSync(normalizedFilePath, 'utf8');
  for (const specifier of getImportSpecifiers(source)) {
    const edge = `${toRepoRelative(normalizedFilePath)} -> ${specifier}`;
    edges.push(edge);

    if (forbiddenModulePatterns.some((pattern) => pattern.test(specifier))) {
      violations.push(`${edge} imports a non-browser module`);
      continue;
    }

    const resolvedImport = resolveImport(normalizedFilePath, specifier);
    if (!resolvedImport) {
      continue;
    }

    if (!isContractSafePath(resolvedImport)) {
      violations.push(`${edge} resolves to ${toRepoRelative(resolvedImport)}`);
      continue;
    }

    walkImports(resolvedImport, visited, edges, violations);
  }
}

function getImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importExportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(importExportPattern)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveImport(importer: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return resolveTsModule(join(dirname(importer), specifier));
  }
  if (specifier.startsWith('@features/')) {
    return resolveTsModule(join(srcRoot, 'features', specifier.slice('@features/'.length)));
  }
  if (specifier.startsWith('@shared/')) {
    return resolveTsModule(join(srcRoot, 'shared', specifier.slice('@shared/'.length)));
  }
  if (specifier.startsWith('@main/')) {
    return resolveTsModule(join(srcRoot, 'main', specifier.slice('@main/'.length)));
  }
  if (specifier.startsWith('@preload/')) {
    return resolveTsModule(join(srcRoot, 'preload', specifier.slice('@preload/'.length)));
  }
  if (specifier.startsWith('@renderer/')) {
    return resolveTsModule(join(srcRoot, 'renderer', specifier.slice('@renderer/'.length)));
  }
  return null;
}

function resolveTsModule(modulePath: string): string | null {
  const candidates =
    extname(modulePath).length > 0
      ? [modulePath]
      : [
          `${modulePath}.ts`,
          `${modulePath}.tsx`,
          `${modulePath}.mts`,
          join(modulePath, 'index.ts'),
          join(modulePath, 'index.tsx'),
        ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isContractSafePath(filePath: string): boolean {
  const normalizedFilePath = normalize(filePath);
  if (!isAbsolute(normalizedFilePath) || !normalizedFilePath.startsWith(srcRoot)) {
    return false;
  }
  return !forbiddenPathSegments.some((segment) => normalizedFilePath.includes(segment));
}

function toRepoRelative(filePath: string): string {
  return relative(repoRoot, filePath).replaceAll('\\', '/');
}
