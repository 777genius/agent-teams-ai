import path from 'node:path';

export const OPENCODE_RUNTIME_BINARY_PATH_ENV = 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH';

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
  const alreadyPresent = currentEntries.some(
    (entry) => normalizePathEntryForCompare(entry) === normalizedDirectory
  );

  if (alreadyPresent) {
    env.PATH = currentEntries.join(path.delimiter);
    return;
  }

  env.PATH = [trimmedDirectory, ...currentEntries].join(path.delimiter);
}

export function applyOpenCodeRuntimeBinaryEnv(
  env: NodeJS.ProcessEnv,
  discoveredBinaryPath: string | null | undefined
): void {
  const existingBinaryPath = env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim();
  const nextBinaryPath = existingBinaryPath || discoveredBinaryPath?.trim() || '';
  if (!nextBinaryPath) {
    return;
  }

  if (!existingBinaryPath) {
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = nextBinaryPath;
  }

  if (!path.isAbsolute(nextBinaryPath)) {
    return;
  }

  // Facts:
  // - The app-managed OpenCode status is resolved from the app runtime manifest.
  // - Older claude-multimodel readiness inventory still resolves "opencode" through PATH.
  // - Exposing the selected binary directory keeps both checks on the same runtime.
  prependPathEntry(env, path.dirname(nextBinaryPath));
}
