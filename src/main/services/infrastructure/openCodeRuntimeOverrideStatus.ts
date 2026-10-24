import { classifyNativeVersion } from '@features/opencode-compatibility';
import { resolveExistingOpenCodeRuntimeBinaryEnvPath } from '@main/services/runtime/openCodeBridgeRuntimeEnv';
import {
  type OpenCodeBinaryOverride,
  readOpenCodeBinaryOverride,
} from '@main/services/runtime/openCodeRuntimeBinaryEnv';
import { getUnsupportedAgentTeamsOpenCodeVersionMessage } from '@shared/utils/version';

import type { OpenCodeBinaryVersionProbe } from '@features/runtime-provider-management/main';
import type { OpenCodeRuntimeIgnoredOverride, OpenCodeRuntimeStatus } from '@shared/types';

export function getUnverifiedOpenCodeOverrideMessage(binaryPath: string): string {
  return (
    `Could not verify the explicitly selected OpenCode binary: ${binaryPath}. ` +
    'Retry the version check, or update/remove the binary override before launching. ' +
    'The app will not substitute its managed OpenCode runtime.'
  );
}

export type OpenCodeOverrideStatusResult =
  | { kind: 'selected'; status: OpenCodeRuntimeStatus }
  | { kind: 'ignored'; ignoredOverride: OpenCodeRuntimeIgnoredOverride };

/**
 * The status must name the binary the team bridge launches: it selects the first override
 * variable that names an existing file and then applies isSupportedOpenCodeRuntimeBinaryPath.
 */
export async function resolveOpenCodeOverrideStatus(
  configured: OpenCodeBinaryOverride,
  env: NodeJS.ProcessEnv,
  probeVersion: (binaryPath: string) => Promise<OpenCodeBinaryVersionProbe>
): Promise<OpenCodeOverrideStatusResult> {
  const selected = resolveExistingOpenCodeRuntimeBinaryEnvPath(env);
  if (!selected) {
    return {
      kind: 'ignored',
      ignoredOverride: {
        binaryPath: configured.binaryPath,
        envName: configured.envName,
        version: null,
        reason: `${configured.envName} does not name an existing file. Using the default OpenCode instead.`,
      },
    };
  }
  const { binaryPath, envName } = selected;
  const version = await probeVersion(binaryPath);
  if (!version.ok) {
    // Launch fails closed for an override it cannot verify, so status does too.
    return {
      kind: 'selected',
      status: {
        installed: false,
        binaryPath,
        source: 'override',
        state: 'failed',
        error: getUnverifiedOpenCodeOverrideMessage(binaryPath),
        diagnostics: version.diagnostics,
      },
    };
  }
  const classification = version.version ? classifyNativeVersion(version.version) : null;
  if (classification?.kind === 'recognized') {
    return {
      kind: 'selected',
      status: {
        installed: true,
        binaryPath,
        version: classification.version,
        source: 'override',
        state: 'ready',
      },
    };
  }
  // Keep the reported version exact, without the V2 CLI banner: it may not parse.
  const reportedVersion = version.version?.replace(/^opencode v/, '') ?? null;
  return {
    kind: 'ignored',
    ignoredOverride: {
      binaryPath,
      envName,
      version: reportedVersion,
      reason: `${getUnsupportedAgentTeamsOpenCodeVersionMessage(reportedVersion)} Using the default OpenCode instead.`,
    },
  };
}

/** Runtime status with the binary override applied the way launch applies it. */
export async function resolveOpenCodeStatusWithOverride(
  env: NodeJS.ProcessEnv,
  probeVersion: (binaryPath: string) => Promise<OpenCodeBinaryVersionProbe>,
  readDefaultStatus: () => Promise<OpenCodeRuntimeStatus>
): Promise<OpenCodeRuntimeStatus> {
  const override = readOpenCodeBinaryOverride(env);
  if (!override) return readDefaultStatus();
  const overrideStatus = await resolveOpenCodeOverrideStatus(override, env, probeVersion);
  if (overrideStatus.kind === 'selected') return overrideStatus.status;
  return { ...(await readDefaultStatus()), ignoredOverride: overrideStatus.ignoredOverride };
}
