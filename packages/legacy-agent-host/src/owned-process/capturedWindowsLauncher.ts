import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';

import { isCanonicalNativePath } from './nativePath.js';
import { buildWindowsShellFallbackCommand, inspectWindowsBatchPolicy,
  isWindowsBatchLauncher, resolveDirectWindowsLauncher } from './windowsCliLauncher.js';

import type { NativeProcessProfile } from '../composition/nativeProcessProfile.js';
import type { ResolvedLaunchSpec } from './contract.js';
import type { WindowsBatchPolicy } from './windowsCliLauncher.js';

export interface CapturedWindowsFile {
  readonly path: string;
  readonly sha256: string;
}

/** Private immutable launch selection. No process, ambient environment or PATH lookup at launch. */
export interface CapturedWindowsLauncher {
  readonly original: CapturedWindowsFile;
  readonly executable: CapturedWindowsFile;
  readonly files: readonly CapturedWindowsFile[];
  readonly argsPrefix: readonly string[];
  readonly batch?: WindowsBatchPolicy;
}

function unavailable(): never { throw new Error('Captured Windows launcher unavailable'); }

/** Fresh same-file content checks; this is not an OS execute-pinned-image guarantee. */
function readFile(path: string, expected?: string): { file: CapturedWindowsFile; bytes: Buffer } {
  if (!isCanonicalNativePath(`win32-${process.arch}`, path)) unavailable();
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || realpathSync(path) !== path) unavailable();
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const after = lstatSync(path, { bigint: true });
  if ((expected !== undefined && sha256 !== expected) || !after.isFile() || after.isSymbolicLink() ||
      realpathSync(path) !== path || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    unavailable();
  return { file: Object.freeze({ path, sha256 }), bytes };
}

function environmentValue(environment: NativeProcessProfile['environment'], name: string): string | undefined {
  const values = Object.entries(environment).filter(([key]) => key.toUpperCase() === name.toUpperCase());
  if (values.length > 1) unavailable();
  return values[0]?.[1];
}

/** Known npm/Bun wrappers name only these native interpreters; no shell resolver is involved. */
function captureInterpreter(command: string, profile: NativeProcessProfile): CapturedWindowsFile {
  if (win32.isAbsolute(command)) return readFile(realpathSync(command)).file;
  if (command !== 'node' && command !== 'bun') unavailable();
  const capturedPath = environmentValue(profile.environment, 'PATH');
  if (!capturedPath) unavailable();
  for (const entry of capturedPath.split(';')) {
    if (!entry) continue;
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    const candidate = win32.resolve(profile.cwd, directory, `${command}.exe`);
    try { return readFile(realpathSync(candidate)).file; }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return unavailable();
}

export function captureWindowsLauncher(profile: NativeProcessProfile): CapturedWindowsLauncher {
  const original = Object.freeze({ ...profile.executable });
  // A native selection already carries its immutable image hash. Preserve its old no-read capture.
  if (!isWindowsBatchLauncher(original.path)) return Object.freeze({ original, executable: original,
    files: Object.freeze([original]), argsPrefix: Object.freeze([]) });
  if (process.platform !== 'win32') unavailable();
  const content = readFile(original.path, original.sha256).bytes.toString('utf8');
  const direct = resolveDirectWindowsLauncher(original.path, content);
  if (direct) {
    const executable = captureInterpreter(direct.command, profile);
    const entrypoints = direct.argsPrefix.map(path => readFile(realpathSync(path)).file);
    return Object.freeze({ original, executable,
      files: Object.freeze([original, executable, ...entrypoints]),
      argsPrefix: Object.freeze(entrypoints.map(file => file.path)) });
  }
  // Same explicit cmd image policy as the existing frontend helper, using captured SystemRoot.
  const systemRoot = environmentValue(profile.environment, 'SystemRoot') ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) unavailable();
  const executable = readFile(realpathSync(win32.join(systemRoot, 'System32', 'cmd.exe'))).file;
  return Object.freeze({ original, executable, files: Object.freeze([original, executable]),
    argsPrefix: Object.freeze([]), batch: inspectWindowsBatchPolicy(content) });
}

export function verifyCapturedWindowsLauncher(captured: CapturedWindowsLauncher): void {
  for (const file of captured.files) readFile(file.path, file.sha256);
}

/** Standard CreateProcessW argv quoting for a direct executable/interpreter. */
export function quoteWindowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function capturedWindowsCommandLine(captured: CapturedWindowsLauncher, args: readonly string[]): string {
  if (captured.batch) {
    const command = buildWindowsShellFallbackCommand([captured.original.path, ...args], captured.batch);
    return `${quoteWindowsArg(captured.executable.path)} /d /s /v:off /c "${command}"`;
  }
  return [captured.executable.path, ...captured.argsPrefix, ...args].map(quoteWindowsArg).join(' ');
}

/** Main independently binds the actual image and fixed launcher prefix to its captured recipe. */
export function matchesCapturedWindowsLauncher(captured: CapturedWindowsLauncher, spec: ResolvedLaunchSpec): boolean {
  if (spec.executable !== captured.executable.path) return false;
  // Direct native images keep the existing ResolvedLaunchSpec argv0 contract.
  if (!isWindowsBatchLauncher(captured.original.path)) return true;
  const empty = capturedWindowsCommandLine(captured, []);
  const prefix = captured.batch ? empty.slice(0, -1) : empty;
  return spec.commandLine === empty || spec.commandLine.startsWith(prefix + ' ');
}
