// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  assertWindowsProfileRoot,
  privateDirectory,
} from '@features/local-http-auth/main/infrastructure/privateFiles';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Execute the real fixture-staging statements only. Requiring/running the smoke
// entrypoint would also load process ownership and could launch a packaged app.
interface SandboxFileSystem {
  mkdtempSync(prefix: string): string;
  realpathSync: ((file: string) => string) & { native(file: string): string };
  mkdirSync(file: string, options: { mode: number }): unknown;
  writeFileSync(file: string, content: string): unknown;
}
function stageSandbox(
  temporaryDirectory: string,
  fileSystem: SandboxFileSystem = fs,
  paths: Pick<path.PlatformPath, 'join'> = path
) {
  const source = ts.createSourceFile(
    'smokePackagedApp.cjs',
    fs.readFileSync(path.resolve('scripts/electron-builder/smokePackagedApp.cjs'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const main = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'main'
  );
  const statements = main?.body?.statements;
  if (!statements) throw new Error('Missing smoke main');
  const start = statements.findIndex(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === 'testRoot'
      )
  );
  const end = statements.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(source) === 'fs.writeFileSync' &&
      statement.getText(source).includes("'.test-only'")
  );
  if (start < 0 || end < start) throw new Error('Missing bounded smoke sandbox staging');
  const staging = statements
    .slice(start, end + 1)
    .map((statement) => statement.getText(source))
    .join('\n');
  return runInNewContext(`${staging}\n({ testRoot, homeDir, claudeRoot, userDataDir })`, {
    fs: fileSystem,
    path: paths,
    os: { tmpdir: () => temporaryDirectory },
  }) as { testRoot: string; homeDir: string; claudeRoot: string; userDataDir: string };
}

function temporaryRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-sandbox-TEST-')));
  roots.push(root);
  return root;
}

it('stages the Claude profile inside the isolated user profile required by the Windows guard', () => {
  const sandbox = stageSandbox(temporaryRoot());
  expect(() => assertWindowsProfileRoot(sandbox.claudeRoot, sandbox.homeDir)).not.toThrow();
  expect(path.dirname(sandbox.claudeRoot)).toBe(sandbox.homeDir);
  expect(fs.readFileSync(path.join(sandbox.testRoot, '.test-only'), 'utf8')).toBe(
    'packaged-app-smoke-test-v1'
  );
  if (process.platform !== 'win32') {
    for (const directory of [
      sandbox.testRoot,
      sandbox.homeDir,
      sandbox.claudeRoot,
      sandbox.userDataDir,
    ])
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  }
});

it.skipIf(process.platform === 'win32')(
  'canonicalizes linked temporary-directory ancestry before private storage uses it',
  async () => {
    const root = temporaryRoot();
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.symlinkSync(actual, alias, 'dir');
    const sandbox = stageSandbox(alias);
    await expect(privateDirectory(sandbox.claudeRoot)).resolves.toBe(
      path.join(sandbox.claudeRoot, 'local-http-auth')
    );
    expect(sandbox.testRoot).toBe(fs.realpathSync(sandbox.testRoot));
  }
);

it.each([
  {
    name: 'Windows short alias',
    supplied: String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\agent-teams-smoke-TEST-owned`,
    canonical: String.raw`C:\Users\runneradmin\AppData\Local\Temp\agent-teams-smoke-TEST-owned`,
  },
  {
    name: 'native case spelling',
    supplied: String.raw`C:\Profiles\MIXEDCASE\agent-teams-smoke-TEST-owned`,
    canonical: String.raw`C:\Profiles\MixedCase\agent-teams-smoke-TEST-owned`,
  },
])(
  'uses the native filesystem spelling for $name before deriving TEST profile paths',
  ({ supplied, canonical }) => {
    const native = vi.fn(() => canonical);
    const legacy = Object.assign(
      vi.fn((file: string) => file),
      { native }
    );
    const fileSystem: SandboxFileSystem = {
      mkdtempSync: vi.fn(() => supplied),
      realpathSync: legacy,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    };
    const sandbox = stageSandbox(
      String.raw`C:\Users\RUNNER~1\AppData\Local\Temp`,
      fileSystem,
      path.win32
    );
    expect(sandbox.testRoot).toBe(canonical);
    expect(sandbox.homeDir).toBe(path.win32.join(canonical, 'home'));
    expect(sandbox.claudeRoot).toBe(path.win32.join(canonical, 'home', '.claude'));
    expect(sandbox.userDataDir).toBe(path.win32.join(canonical, 'user-data'));
    expect(native).toHaveBeenCalledExactlyOnceWith(supplied);
    expect(legacy).not.toHaveBeenCalled();
  }
);

it('propagates native canonicalization refusal before writing TEST profile directories', () => {
  const native = vi.fn(() => {
    throw new Error('TEST native path refused');
  });
  const legacy = Object.assign(
    vi.fn((file: string) => file),
    { native }
  );
  const mkdirSync = vi.fn(),
    writeFileSync = vi.fn();
  expect(() =>
    stageSandbox(
      String.raw`C:\Temp`,
      {
        mkdtempSync: () => String.raw`C:\Temp\agent-teams-smoke-TEST-owned`,
        realpathSync: legacy,
        mkdirSync,
        writeFileSync,
      },
      path.win32
    )
  ).toThrow('TEST native path refused');
  expect(legacy).not.toHaveBeenCalled();
  expect(mkdirSync).not.toHaveBeenCalled();
  expect(writeFileSync).not.toHaveBeenCalled();
});
