import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { expect } from 'vitest';

import cases from '../fixtures/native-tool-parity/lint-cases.json';

interface Diagnostic { ruleId: string | null; severity: number; message: string }
export interface LintResult { filePath: string; messages: Diagnostic[] }
export interface NativeDiagnostic {
  code: string;
  severity: string;
  filename: string;
  labels: { span: { line: number; column: number; offset: number; length: number } }[];
}
interface Effective { rules: Record<string, [number, ...unknown[]]>; languageOptions: { parserOptions: Record<string, unknown> } }
const project = process.cwd();
export const sandbox = mkdtempSync(resolve(tmpdir(), 'desktop-native-parity-'));
const evidence = resolve(process.env.NATIVE_PARITY_EVIDENCE_DIR ?? sandbox, 'cli.jsonl');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const tools = {
  eslint: 'eslint/bin/eslint.js', oxlint: 'oxlint/bin/oxlint', oxfmt: 'oxfmt/bin/oxfmt',
  prettier: 'prettier/bin/prettier.cjs',
};
export function put(path: string, content: string): void {
  const target = resolve(sandbox, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
export function command(executable: string, args: string[], input?: string) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: sandbox, input, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
  });
  const stdoutPath = resolve(dirname(evidence), 'cli.stdout.txt');
  const stderrPath = resolve(dirname(evidence), 'cli.stderr.txt');
  const retain = (path: string, bytes: Buffer) => {
    const offset = existsSync(path) ? statSync(path).size : 0;
    appendFileSync(path, bytes);
    return { path, offset, length: bytes.length, sha256: hash(bytes) };
  };
  appendFileSync(evidence, `${JSON.stringify({
    executable, executableHash: hash(readFileSync(executable)), node: process.version,
    nodeHash: hash(readFileSync(process.execPath)), cwd: sandbox,
    args, inputHash: input === undefined ? undefined : hash(input), exit: result.status,
    signal: result.signal, error: result.error?.message, ms: performance.now() - started,
    stdout: retain(stdoutPath, result.stdout ?? Buffer.alloc(0)),
    stderr: retain(stderrPath, result.stderr ?? Buffer.alloc(0)),
    environment: { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
  })}\n`);
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  // Keep exact bytes before decoding. Non-UTF8 output fails; its raw file remains
  // available for supported separate retrieval, never silently transcoded.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return { ...result, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}
export function run(tool: keyof typeof tools, args: string[], input?: string) {
  return command(resolve(project, 'node_modules', tools[tool]), args, input);
}
export const messages = (results: LintResult[], path: string): Diagnostic[] => {
  const result = results.find((entry) => entry.filePath === resolve(sandbox, path));
  expect(result, `missing observed ESLint result: ${path}`).toBeDefined();
  return result?.messages ?? [];
};
export let bad: LintResult[];
export let good: LintResult[];
export const configs = new Map<string, Effective>();
export function requireNativeTools(): void {
  for (const tool of ['oxlint', 'oxfmt'] as const) {
    const executable = resolve(project, 'node_modules', tools[tool]);
    if (!existsSync(executable)) {
      throw new Error(`Native pilot prerequisite missing: ${tool}. Install the exact candidate dependency fragments in a disposable qualification copy; ordinary tests do not require native tools.`);
    }
  }
}

export function prepareSandbox(): void {
  mkdirSync(dirname(evidence), { recursive: true });
  symlinkSync(resolve(project, 'node_modules'), resolve(sandbox, 'node_modules'), 'dir');
  for (const file of [
    'eslint.config.js', 'eslint.fast.config.js', 'eslint.feature-overrides.mts',
    '.oxlintrc.json', '.oxfmtrc.json', '.prettierrc.json', '.prettierignore', 'tailwind.config.js',
    'tsconfig.json', 'tsconfig.node.json', 'scripts/local-checks/desktop-native-check.ts',
  ]) {
    const target = resolve(sandbox, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(project, file), target);
  }
  put('package.json', JSON.stringify({ private: true, type: 'module' }));
  for (const path of [
    'src/main/parity/value.ts', 'src/shared/parity/value.ts',
    'src/features/parity/core/domain/value.ts', 'src/features/parity/contracts/index.ts',
    'src/renderer/store/parity.ts',
  ]) put(path, 'export const value = 1;');
  // Local value declarations keep the rejecting graph a real cycle without an
  // unresolved circular export alias that crashes the retained typed ESLint rule.
  put('src/main/parity/cycleB.ts', "import { third } from './cycleC'; export const value = third;");
  put('src/main/parity/cycleC.ts', "import { first } from './cycle'; export const third = first;");
  put('test/parity.test.ts', "import { expect, it } from 'vitest'; it('floating control', () => { Promise.resolve(1); expect(1).toBe(1); });");
  for (const row of cases) put(row.path, row.bad);
}

export function captureEslintPolicy(): void {
  const scopes = [
    'src/main/parity/var.ts', 'src/preload/parity/private.ts', 'src/renderer/parity/Alt.tsx',
    'src/shared/parity/value.ts', 'src/features/parity/core/domain/platform.ts',
    'src/features/parity/renderer/ui/Store.tsx', 'test/parity.test.ts',
    'src/features/external-agent-connection/renderer/ExternalAgentPromptDialog.tsx',
  ];
  for (const config of ['eslint.config.js', 'eslint.fast.config.js']) {
    for (const path of scopes) {
      const result = run('eslint', ['--config', config, '--print-config', path]);
      expect(result.status).toBe(0);
      configs.set(`${config}:${path}`, JSON.parse(result.stdout) as Effective);
    }
  }
  const paths = cases.map((row) => row.path);
  const reject = run('eslint', ['--config', 'eslint.config.js', '--format', 'json', ...paths]);
  expect(reject.status).toBe(1);
  bad = JSON.parse(reject.stdout) as LintResult[];
  for (const row of cases) put(row.path, row.good);
  const allow = run('eslint', ['--config', 'eslint.config.js', '--format', 'json', ...paths]);
  expect([0, 1]).toContain(allow.status); // unrelated recommendations can still diagnose controls
  good = JSON.parse(allow.stdout) as LintResult[];
}

export function proposal(path: string, input: string): string {
  const result = run('oxfmt', ['--config', '.oxfmtrc.json', '--disable-nested-config', '--stdin-filepath', resolve(sandbox, path)], input);
  expect(result.status).toBe(0);
  return result.stdout;
}
export function execute(source: string): unknown {
  const calls: string[] = [];
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, require: (name: string) => { calls.push(name); return { value: 3 }; } });
  return { calls, exports };
}
