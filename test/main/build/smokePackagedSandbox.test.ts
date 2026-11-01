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
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Execute the real fixture-staging statements only. Requiring/running the smoke
// entrypoint would also load process ownership and could launch a packaged app.
function stageSandbox(temporaryDirectory: string) {
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
    fs,
    path,
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
