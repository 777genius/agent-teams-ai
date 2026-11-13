import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Shared legacy launcher policy; process custody and recipe capture live separately. */
export interface DirectWindowsLauncher {
  command: string;
  argsPrefix: string[];
}

export function isWindowsBatchLauncher(binaryPath: string): boolean {
  const extension = path.extname(binaryPath).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

const launcherPath = (value: string) => /^[A-Za-z]:\\/.test(value) ? path.win32 : path;

function resolveCmdPathTemplate(template: string, launcherDir: string): string {
  const nativePath = launcherPath(launcherDir);
  const dirWithSep = launcherDir.endsWith(nativePath.sep) ? launcherDir : `${launcherDir}${nativePath.sep}`;
  return nativePath.resolve(
    template
      .replace(/%SCRIPT_DIR%/gi, dirWithSep)
      .replace(/%~dp0/gi, dirWithSep)
      .replace(/%dp0%/gi, dirWithSep)
      .replace(/\\/g, nativePath.sep)
  );
}

function resolveGeneratedBunLauncher(
  content: string,
  launcherDir: string
): DirectWindowsLauncher | null {
  if (!/\bbun\s+"%TARGET%"\s+%\*/i.test(content)) {
    return null;
  }
  const targetMatch = /set\s+"TARGET=([^"]+)"/i.exec(content);
  const targetTemplate = targetMatch?.[1];
  if (!targetTemplate) {
    return null;
  }

  const target = resolveCmdPathTemplate(targetTemplate, launcherDir);
  if (!existsSync(target)) {
    return null;
  }
  return { command: 'bun', argsPrefix: [target] };
}

function resolveNpmNodeShim(content: string, launcherDir: string): DirectWindowsLauncher | null {
  const scriptMatch = /"%_prog%"\s+"([^"]+(?:\.(?:cjs|mjs|js))?)"\s+%\*/i.exec(content);
  const scriptTemplate = scriptMatch?.[1];
  if (!scriptTemplate) {
    return null;
  }

  const scriptPath = resolveCmdPathTemplate(scriptTemplate, launcherDir);
  if (!existsSync(scriptPath)) {
    return null;
  }

  const localNode = launcherPath(launcherDir).join(launcherDir, 'node.exe');
  return {
    command: existsSync(localNode) ? localNode : 'node',
    argsPrefix: [scriptPath],
  };
}

function resolveNpmNativeShim(content: string, launcherDir: string): DirectWindowsLauncher | null {
  const nativeTarget = /(?:^|[&|])\s*"([^"]+\.(?:exe|com))"\s+%\*/im.exec(content)?.[1];
  if (!nativeTarget) {
    return null;
  }

  const target = resolveCmdPathTemplate(nativeTarget, launcherDir);
  if (!existsSync(target)) {
    return null;
  }

  return { command: target, argsPrefix: [] };
}

/**
 * Some Windows launchers are thin wrappers around a real JS entrypoint.
 * Running that entrypoint directly with an argv array avoids cmd.exe's
 * percent expansion, which cannot safely represent args like `%PATH%`.
 */
export function resolveDirectWindowsLauncher(binaryPath: string, capturedContent?: string): DirectWindowsLauncher | null {
  if (process.platform !== 'win32' || !isWindowsBatchLauncher(binaryPath)) {
    return null;
  }

  try {
    const content = capturedContent ?? readFileSync(binaryPath, 'utf8');
    const launcherDir = launcherPath(binaryPath).dirname(binaryPath);
    return (
      resolveGeneratedBunLauncher(content, launcherDir) ??
      resolveNpmNodeShim(content, launcherDir) ??
      resolveNpmNativeShim(content, launcherDir)
    );
  } catch {
    return null;
  }
}

/**
 * Quote an argument for cmd.exe shell invocation on Windows.
 *
 * cmd.exe rules:
 * - Double-quote args containing spaces or special characters
 * - Inside double quotes, escape literal `"` as `\"` for the target argv parser
 * - Double trailing backslashes so they do not escape the closing quote
 * - `%` is expanded as env var even inside double quotes. Keep it outside
 *   quoted chunks and escape it as `^%`.
 * - `^`, `&`, `|`, `<`, `>` are safe inside double quotes
 *
 * Our callers only pass controlled strings (binary paths, CLI flags),
 * NOT arbitrary user input.
 */
function quoteCmdChunk(chunk: string): string {
  const escaped = chunk
    .replace(/(\\*)"/g, (_match, backslashes: string) => `${backslashes}${backslashes}\\"`)
    .replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

export function quoteWindowsCmdArg(arg: string): string {
  if (/[^A-Za-z0-9_\-/.]/.test(arg)) {
    return arg.split('%').map(quoteCmdChunk).join('^%');
  }
  return arg;
}

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdMetaCharacters(value: string): string {
  return value.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}

/**
 * Escape the executable token for a command line that cmd.exe will parse.
 * The executable and argv use different encodings: quoting the command as an
 * argv value changes how cmd locates paths that contain spaces.
 */
function escapeWindowsCmdCommand(command: string): string {
  // Unlike argv, the executable token must retain real quote characters so
  // cmd.exe groups a path containing spaces as one command. Caret-escaping
  // those quotes/spaces makes cmd pass the tail of the path as argv instead.
  return quoteWindowsCmdArg(command);
}

/**
 * Encode one argv value through both cmd.exe parsing and the target process'
 * Windows argv parser. Caret-escaping the quotes and shell metacharacters is
 * essential once windowsVerbatimArguments disables Node's escaping.
 */
function escapeWindowsCmdFallbackArg(arg: string, doubleEscapeMetaCharacters: boolean): string {
  const quoted = `"${arg
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/g, '$1$1')}"`;
  let escaped = escapeWindowsCmdMetaCharacters(quoted);
  if (doubleEscapeMetaCharacters) {
    escaped = escapeWindowsCmdMetaCharacters(escaped);
  }
  return escaped;
}

/** Batch launchers that forward %* parse cmd metacharacters a second time. */
function windowsBatchLauncherReparsesArgs(binaryPath: string): boolean {
  if (!isWindowsBatchLauncher(binaryPath)) {
    return false;
  }
  try {
    return readFileSync(binaryPath, 'utf8').includes('%*');
  } catch {
    // A launcher that cannot be inspected is safer with the additional escape
    // layer than with metacharacters becoming active during a second parse.
    return true;
  }
}

/** `%1`/`%~1` substitution can reactivate shell syntax embedded in argv. */
function windowsBatchLauncherUsesPositionalArgs(binaryPath: string): boolean {
  if (!isWindowsBatchLauncher(binaryPath)) {
    return false;
  }
  try {
    return /%(?:[1-9]|~[^\s%]*[1-9])/.test(readFileSync(binaryPath, 'utf8'));
  } catch {
    return false;
  }
}

export interface WindowsBatchPolicy {
  readonly reparsesArgs: boolean;
  readonly usesPositionalArgs: boolean;
}

/** Inspect the already verified wrapper bytes once; launch does not rediscover shell policy. */
export function inspectWindowsBatchPolicy(content: string): WindowsBatchPolicy {
  return Object.freeze({ reparsesArgs: content.includes('%*'),
    usesPositionalArgs: /%(?:[1-9]|~[^\s%]*[1-9])/.test(content) });
}

function assertSafeWindowsBatchPositionalArgs(usesPositionalArgs: boolean, args: string[]): void {
  if (!usesPositionalArgs) {
    return;
  }
  if (args.some((arg) => /[()\][%!^"`<>&|;,]/.test(arg))) {
    throw new Error(
      'Unsafe Windows batch positional argument: launcher reparses %1..%9 shell syntax'
    );
  }
}

function containsWindowsShellUnsafeControlChar(part: string): boolean {
  for (let index = 0; index < part.length; index += 1) {
    const code = part.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function assertSafeWindowsShellFallbackPart(part: string): void {
  if (containsWindowsShellUnsafeControlChar(part)) {
    throw new Error('Unsafe Windows shell fallback argument: control characters are not allowed');
  }
}

export function buildWindowsShellFallbackCommand(parts: string[], capturedPolicy?: WindowsBatchPolicy): string {
  for (const part of parts) {
    assertSafeWindowsShellFallbackPart(part);
  }
  const [command, ...args] = parts;
  if (command === undefined) {
    return '';
  }
  assertSafeWindowsBatchPositionalArgs(
    capturedPolicy?.usesPositionalArgs ?? windowsBatchLauncherUsesPositionalArgs(command), args);
  const doubleEscapeMetaCharacters = capturedPolicy?.reparsesArgs ?? windowsBatchLauncherReparsesArgs(command);
  return [
    escapeWindowsCmdCommand(command),
    ...args.map((arg) => escapeWindowsCmdFallbackArg(arg, doubleEscapeMetaCharacters)),
  ].join(' ');
}

