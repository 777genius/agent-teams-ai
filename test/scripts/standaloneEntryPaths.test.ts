import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { build } from 'vite';
import { afterEach, beforeEach, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
interface OwnedStage {
  root: string;
  preparing: boolean;
  closed: boolean;
  children: Set<ChildProcess>;
}
const stages: OwnedStage[] = [];
let accepting = false;
beforeEach(() => {
  accepting = true;
});
afterEach(async () => {
  accepting = false;
  for (const owner of stages) owner.closed = true;
  // A timeout never transfers ownership or authorizes deleting a live writer's root.
  if (stages.some((owner) => owner.preparing || owner.children.size > 0)) {
    throw new Error(
      'Offline fixture is still active; retain its root and exact original references',
    );
  }
  for (const owner of stages) await rm(owner.root, { recursive: true });
  stages.length = 0;
});
async function stage(): Promise<OwnedStage> {
  if (!accepting || stages.length) throw new Error('Previous offline fixture still retained');
  const owner: OwnedStage = { root: '', preparing: true, closed: false, children: new Set() };
  stages.push(owner);
  owner.root = await mkdtemp(path.join(homedir(), 'TEST-standalone-entry-'));
  if (owner.closed) throw new Error('Offline fixture admission closed during preparation');
  owner.root = await realpath(owner.root);
  if (owner.closed) throw new Error('Offline fixture admission closed during preparation');
  return owner;
}
async function execute(
  file: string,
  owner: OwnedStage,
): Promise<{ code: number | null; out: string; error: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (!accepting || owner.closed) throw new Error('Offline fixture admission closed');
  return new Promise((resolve, reject) => {
    owner.preparing = false;
    const child = spawn(process.execPath, [file], {
      cwd: homedir(),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    owner.children.add(child);
    let out = '',
      error = '',
      overflow = false,
      failed = false;
    child.stdout.once('error', () => {
      failed = true;
    });
    child.stderr.once('error', () => {
      failed = true;
    });
    child.once('error', () => {
      failed = true;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length + chunk.length > 16_384) overflow = true;
      else out += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (error.length + chunk.length > 16_384) overflow = true;
      else error += String(chunk);
    });
    // Only exact physical close permits the owning fixture's cleanup. No signals.
    child.once('close', (code, signal) => {
      owner.children.delete(child);
      if (failed || signal !== null || overflow)
        reject(new Error('Offline entry fixture did not close cleanly'));
      else resolve({ code, out, error });
    });
  });
}
const dataModule = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
function source(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function esm(text: string): string {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
async function offlineRunner(root: string): Promise<string> {
  const original = source(
    'runStandalone.ts',
    await readFile(path.join(sourceRoot, 'scripts/runStandalone.ts'), 'utf8'),
  );
  const builder = dataModule(
    'export async function buildPublicationHelper(root) { globalThis.__pathProof.roots.push(root); return []; }',
  );
  const application = dataModule(
    'globalThis.__pathProof.imports++; globalThis.__pathProof.finish(); export {};',
  );
  let builderPorts = 0,
    applicationPorts = 0;
  const transformed = ts.transform(original, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          if (node.moduleSpecifier.text === './build/publicationHelper') {
            builderPorts++;
            return ts.factory.updateImportDeclaration(
              node,
              node.modifiers,
              node.importClause,
              ts.factory.createStringLiteral(builder),
              node.attributes,
            );
          }
          if (!['node:path', 'node:url'].includes(node.moduleSpecifier.text))
            throw new Error('Unexpected runner dependency');
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (
            node.arguments.length !== 1 ||
            !ts.isStringLiteral(node.arguments[0]) ||
            node.arguments[0].text !== '../src/main/standalone'
          )
            throw new Error('Unexpected application import');
          applicationPorts++;
          return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
            ts.factory.createStringLiteral(application),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit) as ts.SourceFile;
    },
  ]);
  expect([builderPorts, applicationPorts]).toEqual([1, 1]);
  const body = esm(ts.createPrinter().printFile(transformed.transformed[0]));
  transformed.dispose();
  const file = path.join(root, 'scripts/runStandalone.mjs');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `let finish; const done = new Promise(resolve => { finish = resolve; });
globalThis.__pathProof = { roots: [], imports: 0, finish };
${body}
await done;
if (globalThis.__pathProof.roots.length !== 1 || globalThis.__pathProof.roots[0] !== ${JSON.stringify(root)} || globalThis.__pathProof.imports !== 1) throw new Error('Offline runner path/order mismatch');
console.log('RUNNER_PATH_OK');
`,
  );
  return file;
}
async function configurationSource(): Promise<string> {
  const file = source(
    'standalone.ts',
    await readFile(path.join(sourceRoot, 'src/main/standalone.ts'), 'utf8'),
  );
  const start = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'start',
  );
  if (!start || !ts.isFunctionDeclaration(start) || !start.body)
    throw new Error('Missing standalone start');
  const index = start.body.statements.findIndex(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'configurePublicationHelper',
  );
  if (
    index < 0 ||
    start.body.statements.slice(0, index).some((node) => !ts.isVariableStatement(node))
  )
    throw new Error('Unexpected configuration boundary');
  const imports = file.statements.filter(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['node:path', 'node:url'].includes(node.moduleSpecifier.text),
  );
  return [...imports, ...start.body.statements.slice(0, index + 1)]
    .map((node) => node.getText(file))
    .join('\n');
}
function port(body: string, expected: string): string {
  return `let value; function configurePublicationHelper(input) { value = input; }
${body}
if (!value || value.directory !== ${JSON.stringify(expected)} || value.mode !== 'node' || value.prepareStandaloneRoot !== true) throw new Error('Offline standalone configuration mismatch');
console.log('STANDALONE_PATH_OK');`;
}
it('runs the actual source runner as ESM with only builder/application ports', async () => {
  const owner = await stage(),
    root = owner.root;
  const result = await execute(await offlineRunner(root), owner);
  expect(result.code, result.error).toBe(0);
  expect(result.out.trim()).toBe('RUNNER_PATH_OK');
});
it('resolves the actual standalone configuration in ESM source layout without booting the app', async () => {
  const owner = await stage(),
    root = owner.root,
    file = path.join(root, 'src/main/standalone.mjs');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    esm(port(await configurationSource(), path.join(root, 'dist-local-http-auth'))),
  );
  const result = await execute(file, owner);
  expect(result.code, result.error).toBe(0);
  expect(result.out.trim()).toBe('STANDALONE_PATH_OK');
});
it('preserves the actual standalone CJS bundle layout without booting the app', async () => {
  const owner = await stage(),
    root = owner.root,
    input = path.join(root, 'configuration.ts');
  await writeFile(
    input,
    port(await configurationSource(), path.join(root, 'dist-local-http-auth')),
  );
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      outDir: path.join(root, 'dist-standalone'),
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      ssr: true,
      rollupOptions: {
        input,
        external: (id) => id.startsWith('node:'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  });
  const result = await execute(path.join(root, 'dist-standalone/index.cjs'), owner);
  expect(result.code, result.error).toBe(0);
  expect(result.out.trim()).toBe('STANDALONE_PATH_OK');
});
