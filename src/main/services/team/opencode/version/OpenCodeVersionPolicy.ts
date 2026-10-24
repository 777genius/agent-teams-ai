import { evaluateLegacyOpenCodeSupport } from '@features/opencode-compatibility';
import { MINIMUM_AGENT_TEAMS_OPENCODE_VERSION } from '@shared/utils/version';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

import type {
  OpenCodeApiCapabilities,
  OpenCodeApiEndpointKey,
  OpenCodeEndpointEvidence,
} from '../capabilities/OpenCodeApiCapabilities';
import type {
  OpenCodeSemver,
  OpenCodeSupportDecision,
  OpenCodeSupportedVersionPolicy,
  OpenCodeSupportLevel,
} from '@features/opencode-compatibility';

export type {
  OpenCodeSemver,
  OpenCodeSupportDecision,
  OpenCodeSupportedVersionPolicy,
  OpenCodeSupportLevel,
} from '@features/opencode-compatibility';
export { parseOpenCodeSemver, semverLt } from '@features/opencode-compatibility';

export const OPENCODE_TEAM_LAUNCH_VERSION_POLICY: OpenCodeSupportedVersionPolicy = {
  minimumVersion: MINIMUM_AGENT_TEAMS_OPENCODE_VERSION,
  allowedPrerelease: false,
  requireCapabilities: true,
};

export type OpenCodeInstallMethod = 'brew' | 'npm' | 'bun' | 'manual' | 'unknown';

export interface OpenCodeCompatibilitySnapshot {
  schemaVersion: 1;
  createdAt: string;
  binaryPath: string;
  binaryFingerprint: string;
  installMethod: OpenCodeInstallMethod;
  version: string;
  semver: OpenCodeSemver;
  supported: boolean;
  supportLevel: OpenCodeSupportLevel;
  apiCapabilities: OpenCodeApiCapabilities;
  diagnostics: string[];
}

export interface OpenCodeRouteCompatibilityCache {
  binaryFingerprint: string;
  version: string;
  routes: Record<
    OpenCodeApiEndpointKey,
    {
      available: boolean;
      evidence: OpenCodeEndpointEvidence;
      lastVerifiedAt: string;
    }
  >;
}

export type OpenCodePermissionReplyRoute =
  | {
      kind: 'primary_permission_reply';
      method: 'POST';
      pathTemplate: '/permission/:requestID/reply';
      bodyShape: { reply: 'once' };
    }
  | {
      kind: 'deprecated_session_permission';
      method: 'POST';
      pathTemplate: '/session/:sessionID/permissions/:permissionID';
      bodyShape: { response: 'once' };
    };

export async function buildOpenCodeBinaryFingerprint(binaryPath: string): Promise<string> {
  const stat = await fs.stat(binaryPath);
  return stableHash({
    binaryPath,
    realPath: await fs.realpath(binaryPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

export function shouldReuseCompatibilitySnapshot(input: {
  cached: OpenCodeCompatibilitySnapshot | null;
  binaryPath: string;
  binaryFingerprint: string;
  version: string;
}): boolean {
  return Boolean(
    input.cached?.binaryPath === input.binaryPath &&
    input.cached.binaryFingerprint === input.binaryFingerprint &&
    input.cached.version === input.version
  );
}

export function evaluateOpenCodeSupport(input: {
  version: string;
  capabilities: OpenCodeApiCapabilities;
  policy?: OpenCodeSupportedVersionPolicy;
}): OpenCodeSupportDecision {
  return evaluateLegacyOpenCodeSupport({
    version: input.version,
    policy: input.policy ?? OPENCODE_TEAM_LAUNCH_VERSION_POLICY,
    capabilities: () => input.capabilities.requiredForTeamLaunch,
  });
}

export function selectPermissionReplyRouteFromCache(
  cache: OpenCodeRouteCompatibilityCache
): OpenCodePermissionReplyRoute | null {
  if (cache.routes.permissionReply?.available) {
    return {
      kind: 'primary_permission_reply',
      method: 'POST',
      pathTemplate: '/permission/:requestID/reply',
      bodyShape: { reply: 'once' },
    };
  }

  if (cache.routes.permissionLegacySessionRespond?.available) {
    return {
      kind: 'deprecated_session_permission',
      method: 'POST',
      pathTemplate: '/session/:sessionID/permissions/:permissionID',
      bodyShape: { response: 'once' },
    };
  }

  return null;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(',')}}`;
}
