import fs from 'node:fs';
import path from 'node:path';

export const OPENCODE_RUNTIME_BINARY_PATH_ENV = 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH';
export const OPENCODE_LEGACY_BINARY_PATH_ENV = 'OPENCODE_BIN_PATH';
/** Env the console wrapper reads to find the real OpenCode binary. */
export const OPENCODE_CONSOLE_WRAPPER_TARGET_ENV = 'OPENCODE_CONSOLE_WRAPPER_TARGET';
/** Set to "0" to launch the real OpenCode binary directly (no console wrapper). */
export const OPENCODE_CONSOLE_WRAPPER_DISABLE_ENV = 'AGENT_TEAMS_OPENCODE_CONSOLE_WRAPPER';
const OPENCODE_CONSOLE_WRAPPER_RELATIVE_PATH = ['runtime', 'opencode-console', 'opencode.exe'];
const OPENCODE_CONSOLE_WRAPPER_SIDECAR = 'opencode.real.path';

export interface OpenCodeConsoleWrapperOptions {
  /** Electron resources path (defaults to process.resourcesPath). */
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * On Windows the orchestrator starts `opencode serve` hosts detached (no
 * console), so every console child they spawn (cmd.exe for the bash tool,
 * cursor-agent.cmd -> powershell, ...) allocates a new visible console window
 * that flashes and steals focus. resources/runtime/opencode-console/opencode.exe
 * (tools/opencode-console-wrapper) is a GUI-subsystem launcher that starts the
 * real binary with CREATE_NO_WINDOW, giving the host a hidden console that all
 * descendants inherit. When it is present, the orchestrator is pointed at the
 * wrapper and the real path is published through env + a sidecar file.
 */
export function resolveOpenCodeConsoleWrapperPath(
  realBinaryPath: string,
  options: OpenCodeConsoleWrapperOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.env ?? process.env;
  if (platform !== 'win32' || sourceEnv[OPENCODE_CONSOLE_WRAPPER_DISABLE_ENV]?.trim() === '0') {
    return null;
  }
  const resourcesPath = (options.resourcesPath ?? process.resourcesPath)?.trim();
  if (!resourcesPath) {
    return null;
  }
  const wrapperPath = path.join(resourcesPath, ...OPENCODE_CONSOLE_WRAPPER_RELATIVE_PATH);
  if (normalizePathEntryForCompare(realBinaryPath) === normalizePathEntryForCompare(wrapperPath)) {
    return wrapperPath;
  }
  try {
    if (!fs.statSync(wrapperPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const sidecarPath = path.join(path.dirname(wrapperPath), OPENCODE_CONSOLE_WRAPPER_SIDECAR);
  try {
    let current = '';
    try {
      current = fs.readFileSync(sidecarPath, 'utf8').trim();
    } catch {
      current = '';
    }
    if (current !== realBinaryPath) {
      fs.writeFileSync(sidecarPath, realBinaryPath, 'utf8');
    }
  } catch {
    // A read-only resources directory only costs the sidecar: the wrapper also
    // reads its target from OPENCODE_CONSOLE_WRAPPER_TARGET, set below.
  }
  return wrapperPath;
}

function normalizePathEntryForCompare(value: string): string {
  const normalized = path.resolve(value.trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function prependPathEntry(env: NodeJS.ProcessEnv, directory: string): void {
  const trimmedDirectory = directory.trim();
  if (!trimmedDirectory) {
    return;
  }

  const currentPath = env.PATH ?? '';
  const currentEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedDirectory = normalizePathEntryForCompare(trimmedDirectory);
  const remainingEntries = currentEntries.filter(
    (entry) => normalizePathEntryForCompare(entry) !== normalizedDirectory
  );
  env.PATH = [trimmedDirectory, ...remainingEntries].join(path.delimiter);
}

export function applyOpenCodeRuntimeBinaryEnv(
  env: NodeJS.ProcessEnv,
  discoveredBinaryPath: string | null | undefined,
  wrapperOptions: OpenCodeConsoleWrapperOptions = {}
): void {
  const existingBinaryPath = env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim();
  const existingLegacyBinaryPath = env[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim();
  const nextBinaryPath =
    existingBinaryPath || existingLegacyBinaryPath || discoveredBinaryPath?.trim() || '';
  if (!nextBinaryPath) {
    return;
  }

  const wrapperPath = path.isAbsolute(nextBinaryPath)
    ? resolveOpenCodeConsoleWrapperPath(nextBinaryPath, wrapperOptions)
    : null;
  if (
    wrapperPath &&
    normalizePathEntryForCompare(wrapperPath) !== normalizePathEntryForCompare(nextBinaryPath)
  ) {
    env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV] = nextBinaryPath;
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = wrapperPath;
    env[OPENCODE_LEGACY_BINARY_PATH_ENV] = wrapperPath;
    // PATH-based lookups keep resolving the real runtime directory.
    prependPathEntry(env, path.dirname(nextBinaryPath));
    return;
  }

  if (!existingBinaryPath) {
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = nextBinaryPath;
  }
  if (!existingLegacyBinaryPath) {
    env[OPENCODE_LEGACY_BINARY_PATH_ENV] = nextBinaryPath;
  }

  if (!path.isAbsolute(nextBinaryPath)) {
    return;
  }
  if (wrapperPath) {
    // env already points at the wrapper: make sure PATH carries the real runtime
    // directory (the sidecar file carries the real path for the wrapper itself).
    const target = env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV]?.trim();
    if (target && path.isAbsolute(target)) {
      prependPathEntry(env, path.dirname(target));
      return;
    }
  }

  // Facts:
  // - The app-managed OpenCode status is resolved from the app runtime manifest.
  // - Released claude-multimodel builds have used both OPENCODE_BIN_PATH and
  //   CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH while the managed runtime path evolved.
  // - Older claude-multimodel readiness inventory still resolves "opencode" through PATH.
  // - Exposing the selected binary directory keeps both checks on the same runtime.
  prependPathEntry(env, path.dirname(nextBinaryPath));
}
