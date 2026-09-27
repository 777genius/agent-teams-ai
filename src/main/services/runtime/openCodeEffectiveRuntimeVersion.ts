import { probeOpenCodeBinaryVersion } from '@features/runtime-provider-management/main';
import {
  OpenCodeRuntimeInstallerService,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';

import {
  OPENCODE_CONSOLE_WRAPPER_TARGET_ENV,
  OPENCODE_LEGACY_BINARY_PATH_ENV,
  OPENCODE_RUNTIME_BINARY_PATH_ENV,
} from './openCodeRuntimeBinaryEnv';

export interface OpenCodeEffectiveRuntimeStatus {
  installed: boolean;
  version?: string;
}

export function hasExplicitOpenCodeBinaryOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim() || env[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim()
  );
}

/** Read the version the next bridge command will use, including a user override. */
export async function readOpenCodeEffectiveRuntimeStatus(
  env: NodeJS.ProcessEnv,
  readDefaultStatus: () => Promise<OpenCodeEffectiveRuntimeStatus>,
  probeBinaryVersion: (
    binaryPath: string
  ) => Promise<{ ok: boolean; version?: string | null }> = probeOpenCodeBinaryVersion
): Promise<OpenCodeEffectiveRuntimeStatus> {
  if (!hasExplicitOpenCodeBinaryOverride(env)) return readDefaultStatus();
  const binaryPath =
    env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV]?.trim() ||
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim() ||
    env[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim();
  if (!binaryPath) return { installed: false };
  const result = await probeBinaryVersion(binaryPath);
  return { installed: result.ok, version: result.version ?? undefined };
}

export function readOpenCodeCurrentRuntimeStatus(): Promise<OpenCodeEffectiveRuntimeStatus> {
  return readOpenCodeEffectiveRuntimeStatus(process.env, () =>
    new OpenCodeRuntimeInstallerService().getStatus()
  );
}

export async function resolveOpenCodeRuntimeBinaryForBridgeEnv(
  options: { includeShellEnv?: boolean },
  readRuntimeStatus: () => Promise<{ installed: boolean; binaryPath?: string } | undefined>,
  onWarning: (message: string) => void
): Promise<string | null> {
  const resolvedPath = await resolveVerifiedOpenCodeRuntimeBinaryPath({
    includeShellEnv: options.includeShellEnv,
  });
  if (resolvedPath) return resolvedPath;
  if (options.includeShellEnv === false) return null;
  try {
    const status = await readRuntimeStatus();
    return status?.installed && status.binaryPath ? status.binaryPath : null;
  } catch (error) {
    onWarning(
      `[OpenCode] Runtime installer status unavailable while resolving bridge binary: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
