import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  applyOpenCodeRuntimeBinaryEnv,
  OPENCODE_LEGACY_BINARY_PATH_ENV,
  OPENCODE_RUNTIME_BINARY_PATH_ENV,
} from './openCodeRuntimeBinaryEnv';

export interface EnsureOpenCodeBridgeRuntimeBinaryEnvOptions {
  targetEnv: NodeJS.ProcessEnv;
  bridgeEnv?: NodeJS.ProcessEnv;
  resolveVerifiedOpenCodeRuntimeBinaryPath: () => Promise<string | null>;
  isSupportedOpenCodeRuntimeBinaryPath?: (binaryPath: string) => Promise<boolean>;
  onWarning?: (message: string) => void;
}

function resolveExistingFilePath(filePath: string): string | null {
  const resolvedPath = path.resolve(filePath.trim());
  if (!existsSync(resolvedPath)) {
    return null;
  }
  try {
    return statSync(resolvedPath).isFile() ? resolvedPath : null;
  } catch {
    return null;
  }
}

function getOpenCodeRuntimeBinaryEnvValues(env: NodeJS.ProcessEnv): string[] {
  return [
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim(),
    env[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim(),
  ].filter((value): value is string => Boolean(value));
}

function resolveExistingOpenCodeRuntimeBinaryEnvPath(env: NodeJS.ProcessEnv): string | null {
  for (const value of getOpenCodeRuntimeBinaryEnvValues(env)) {
    const resolvedPath = resolveExistingFilePath(value);
    if (resolvedPath) {
      return resolvedPath;
    }
  }
  return null;
}

function clearOpenCodeRuntimeBinaryEnvValues(
  env: NodeJS.ProcessEnv,
  invalidValues: Set<string>
): void {
  for (const key of [OPENCODE_RUNTIME_BINARY_PATH_ENV, OPENCODE_LEGACY_BINARY_PATH_ENV]) {
    const value = env[key]?.trim();
    if (value && invalidValues.has(value)) {
      delete env[key];
    }
  }
}

export async function ensureOpenCodeBridgeRuntimeBinaryEnv({
  targetEnv,
  bridgeEnv = targetEnv,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
  isSupportedOpenCodeRuntimeBinaryPath,
  onWarning,
}: EnsureOpenCodeBridgeRuntimeBinaryEnvOptions): Promise<void> {
  if (
    targetEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim() ||
    targetEnv[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim()
  ) {
    const existingBinaryPath = resolveExistingOpenCodeRuntimeBinaryEnvPath(targetEnv);
    if (!existingBinaryPath) {
      const invalidValues = new Set(getOpenCodeRuntimeBinaryEnvValues(targetEnv));
      clearOpenCodeRuntimeBinaryEnvValues(targetEnv, invalidValues);
      if (targetEnv !== bridgeEnv) {
        clearOpenCodeRuntimeBinaryEnvValues(bridgeEnv, invalidValues);
      }
    } else if (
      !isSupportedOpenCodeRuntimeBinaryPath ||
      (await isSupportedOpenCodeRuntimeBinaryPath(existingBinaryPath).catch(() => false))
    ) {
      targetEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV] = existingBinaryPath;
      targetEnv[OPENCODE_LEGACY_BINARY_PATH_ENV] = existingBinaryPath;
      applyOpenCodeRuntimeBinaryEnv(targetEnv, existingBinaryPath);
      return;
    } else {
      const invalidValues = new Set(getOpenCodeRuntimeBinaryEnvValues(targetEnv));
      clearOpenCodeRuntimeBinaryEnvValues(targetEnv, invalidValues);
      if (targetEnv !== bridgeEnv) {
        clearOpenCodeRuntimeBinaryEnvValues(bridgeEnv, invalidValues);
      }
      onWarning?.(`[OpenCode] Ignoring unsupported runtime binary override: ${existingBinaryPath}`);
    }
  }

  if (
    targetEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim() ||
    targetEnv[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim()
  ) {
    applyOpenCodeRuntimeBinaryEnv(targetEnv, null);
    return;
  }

  try {
    const openCodeBinary = await resolveVerifiedOpenCodeRuntimeBinaryPath();
    applyOpenCodeRuntimeBinaryEnv(targetEnv, openCodeBinary);
    if (
      targetEnv !== bridgeEnv &&
      targetEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV] &&
      !bridgeEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV]
    ) {
      applyOpenCodeRuntimeBinaryEnv(bridgeEnv, targetEnv[OPENCODE_RUNTIME_BINARY_PATH_ENV]);
    }
  } catch (error) {
    onWarning?.(`[OpenCode] Runtime adapter OpenCode binary unresolved: ${getErrorMessage(error)}`);
  }
}
