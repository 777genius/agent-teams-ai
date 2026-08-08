// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAuthenticatedHostedQueryContextFactory } from '../../../../src/features/hosted-query-context/main/composition/createAuthenticatedHostedQueryContextFactory';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FEATURE_ROOT = resolve(ROOT, 'src/features/hosted-query-context');
const CORE_PATHS = [
  resolve(FEATURE_ROOT, 'core/application/ports.ts'),
  resolve(FEATURE_ROOT, 'core/application/AuthenticatedHostedQueryContextFactory.ts'),
] as const;
const NODE_IDENTITY_PATH = resolve(
  FEATURE_ROOT,
  'main/infrastructure/NodeHostedQueryContextIdentity.ts'
);
const MAIN_INDEX_PATH = resolve(FEATURE_ROOT, 'main/index.ts');

function source(path: string): string {
  // Every caller supplies a fixed repository-owned path declared above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(path, 'utf8');
}

function imports(value: string): readonly string[] {
  return [...value.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(
    (match) => match[1]!
  );
}

describe('hosted-query-context boundaries', () => {
  it('keeps core free of Node, HTTP, Fastify, Electron, and concrete infrastructure', () => {
    const forbidden = ['node:', 'fastify', 'electron', '@main/', '@renderer/', '@preload/'];
    for (const path of CORE_PATHS) {
      const value = source(path);
      const specifiers = imports(value);
      for (const prefix of forbidden) {
        expect(
          specifiers.some((specifier) => specifier === prefix || specifier.startsWith(prefix)),
          `${path} imports ${prefix}`
        ).toBe(false);
      }
      expect(value).not.toMatch(/\b(?:FastifyRequest|FastifyReply|BrowserWindow|ipcMain)\b/);
      expect(value).not.toMatch(/\b(?:console|logger)\s*\./);
    }
  });

  it('confines SHA-256 projection and cryptorandom RequestId generation to Node infrastructure', () => {
    const core = CORE_PATHS.map(source).join('\n');
    const nodeIdentity = source(NODE_IDENTITY_PATH);

    expect(core).not.toMatch(/\b(?:createHash|randomBytes|sha256)\b/i);
    expect(nodeIdentity).toContain("createHash('sha256')");
    expect(nodeIdentity).toContain('nodeRandomBytes');
    expect(nodeIdentity).toContain('writeUInt32BE');
    expect(nodeIdentity).not.toContain(".update('\\0'");
    expect(nodeIdentity).not.toMatch(/sessionSecret|deviceSecret|csrfToken|cookie/i);
  });

  it('keeps concrete host composition non-public while preserving feature-neutral ports', () => {
    const mainIndex = source(MAIN_INDEX_PATH);

    expect(createAuthenticatedHostedQueryContextFactory).toBeTypeOf('function');
    expect(mainIndex).toContain('AuthenticatedHostedQueryContextFactoryPort');
    expect(mainIndex).toContain('AuthenticatedHostedPrincipalSourcePort');
    expect(mainIndex).not.toContain('createAuthenticatedHostedQueryContextFactory');
    expect(mainIndex).not.toContain('NodeHostedQueryContextIdentity');
    expect(mainIndex).not.toContain('/infrastructure/');
  });
});
