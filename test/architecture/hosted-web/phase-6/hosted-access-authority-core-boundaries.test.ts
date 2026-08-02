// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import {
  HostedAccessAuthority,
  parseAuthorityDeploymentId,
  parseOpaqueAuthoritySecret,
} from '@features/hosted-access';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FEATURE_ROOT = resolve(ROOT, 'src/features/hosted-access');
const PURE_LAYER_ROOTS = [
  resolve(FEATURE_ROOT, 'contracts'),
  resolve(FEATURE_ROOT, 'core'),
] as const;
const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'better-sqlite3',
  'node:',
  '@main/',
  '@renderer/',
  '@preload/',
  'src/main',
  'team-runtime',
  'team-provisioning',
] as const;

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  // The root and every descendant are fixed repository-owned paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    if (entry.isFile() && extname(entry.name) === '.ts') files.push(path);
  }
  return files;
}

describe('Phase 6 hosted-access authority core boundary', () => {
  it('keeps the pure authority slice free of transport, Electron, filesystem, and team runtime imports', () => {
    for (const path of PURE_LAYER_ROOTS.flatMap((root) => sourceFiles(root))) {
      // Paths are descendants of the fixed repository-owned FEATURE_ROOT.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(path, 'utf8');
      const imports = [
        ...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g),
      ].map((match) => match[1]!);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.some((specifier) => specifier === forbidden || specifier.startsWith(forbidden)),
          `${path} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source).not.toMatch(
        /\b(?:BrowserWindow|ipcMain|IpcMain|FastifyInstance|FastifyRequest|FastifyReply|readFileSync|writeFileSync|createReadStream|createWriteStream|registerRoute)\b/
      );
    }
  });

  it('keeps contracts and core free of route or adapter assembly', () => {
    const pureLayerFiles = PURE_LAYER_ROOTS.flatMap((root) => sourceFiles(root));
    expect(pureLayerFiles.length).toBeGreaterThan(0);
    expect(pureLayerFiles.every((path) => !path.includes('/adapters/'))).toBe(true);
  });

  it('exports the authority facade and strict opaque contracts without framework types', () => {
    expect(HostedAccessAuthority).toBeTypeOf('function');
    expect(parseAuthorityDeploymentId('deployment_00000001')).toBe('deployment_00000001');
    expect(
      parseOpaqueAuthoritySecret('authority_secret_abcdefghijklmnopqrstuvwxyz0123456789')
    ).toContain('authority_secret_');
  });
});
