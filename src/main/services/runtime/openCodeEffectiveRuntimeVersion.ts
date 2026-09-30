import {
  OpenCodeRuntimeInstallerService,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { probeOpenCodeBinaryVersion } from '@main/services/infrastructure/openCodeVersionDiagnostics';
import { isAgentTeamsOpenCodeVersionSupported } from '@shared/utils/version';

import { resolveExistingOpenCodeRuntimeBinaryEnvPath } from './openCodeBridgeRuntimeEnv';
import {
  isOpenCodeConsoleWrapperBinaryPath,
  OPENCODE_CONSOLE_WRAPPER_TARGET_ENV,
  OPENCODE_LEGACY_BINARY_PATH_ENV,
  OPENCODE_RUNTIME_BINARY_PATH_ENV,
} from './openCodeRuntimeBinaryEnv';

export interface OpenCodeEffectiveRuntimeStatus {
  installed: boolean;
  version?: string;
  binaryOverrideEnvName?: string;
}

const currentRuntimeStatusReader = new OpenCodeRuntimeInstallerService();

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
  const selectedBinary = resolveExistingOpenCodeRuntimeBinaryEnvPath(env);
  if (!selectedBinary) return readDefaultStatus();
  const binaryPath = isOpenCodeConsoleWrapperBinaryPath(selectedBinary.binaryPath)
    ? env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV]?.trim() || selectedBinary.binaryPath
    : selectedBinary.binaryPath;
  try {
    const result = await probeBinaryVersion(binaryPath);
    if (result.ok && isAgentTeamsOpenCodeVersionSupported(result.version)) {
      return {
        installed: true,
        version: result.version ?? undefined,
        binaryOverrideEnvName: selectedBinary.envName,
      };
    }
  } catch {
    // Bridge runtime selection also falls back when an override cannot be probed.
  }
  return readDefaultStatus();
}

export function readOpenCodeCurrentRuntimeStatus(): Promise<OpenCodeEffectiveRuntimeStatus> {
  return readOpenCodeEffectiveRuntimeStatus(process.env, () =>
    currentRuntimeStatusReader.getReadinessStatus()
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
