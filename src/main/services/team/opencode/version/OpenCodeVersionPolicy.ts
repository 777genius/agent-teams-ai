import { createHash } from 'crypto';
import { promises as fs } from 'fs';

import type {
  OpenCodeApiCapabilities,
  OpenCodeApiEndpointKey,
  OpenCodeEndpointEvidence,
} from '../capabilities/OpenCodeApiCapabilities';

export interface OpenCodeSupportedVersionPolicy {
  minimumVersion: string;
  allowedPrerelease: boolean;
  requireCapabilities: boolean;
}

export const OPENCODE_TEAM_LAUNCH_VERSION_POLICY: OpenCodeSupportedVersionPolicy = {
  minimumVersion: '1.14.19',
  allowedPrerelease: false,
  requireCapabilities: true,
};

export type OpenCodeInstallMethod = 'brew' | 'npm' | 'bun' | 'manual' | 'unknown';

export interface OpenCodeSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export type OpenCodeSupportLevel =
  | 'unsupported_too_old'
  | 'unsupported_prerelease'
  | 'supported_capabilities_pending'
  | 'production_supported';

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

export interface OpenCodeSupportDecision {
  supported: boolean;
  supportLevel: OpenCodeSupportLevel;
  semver: OpenCodeSemver | null;
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
  const policy = input.policy ?? OPENCODE_TEAM_LAUNCH_VERSION_POLICY;
  const parsed = parseOpenCodeSemver(input.version);
  if (!parsed || semverCoreLt(parsed, policy.minimumVersion)) {
    return {
      supported: false,
      supportLevel: 'unsupported_too_old',
      semver: parsed,
      diagnostics: [
        `OpenCode ${input.version} is below supported minimum ${policy.minimumVersion}`,
      ],
    };
  }

  if (parsed.prerelease.length > 0 && !policy.allowedPrerelease) {
    return {
      supported: false,
      supportLevel: 'unsupported_prerelease',
      semver: parsed,
      diagnostics: [
        `OpenCode prerelease ${input.version} is not enabled for production team launch`,
      ],
    };
  }

  if (policy.requireCapabilities && !input.capabilities.requiredForTeamLaunch.ready) {
    return {
      supported: false,
      supportLevel: 'supported_capabilities_pending',
      semver: parsed,
      diagnostics: input.capabilities.requiredForTeamLaunch.missing,
    };
  }

  return {
    supported: true,
    supportLevel: 'production_supported',
    semver: parsed,
    diagnostics: [],
  };
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

export function parseOpenCodeSemver(version: string): OpenCodeSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.').filter(Boolean) ?? [],
  };
}

export function semverLt(left: OpenCodeSemver, right: string | OpenCodeSemver): boolean {
  const parsedRight = typeof right === 'string' ? parseOpenCodeSemver(right) : right;
  if (!parsedRight) {
    return true;
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < parsedRight[key]) {
      return true;
    }
    if (left[key] > parsedRight[key]) {
      return false;
    }
  }

  if (left.prerelease.length > 0 && parsedRight.prerelease.length === 0) {
    return true;
  }

  return false;
}

function semverCoreLt(left: OpenCodeSemver, right: string | OpenCodeSemver): boolean {
  const parsedRight = typeof right === 'string' ? parseOpenCodeSemver(right) : right;
  if (!parsedRight) {
    return true;
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < parsedRight[key]) {
      return true;
    }
    if (left[key] > parsedRight[key]) {
      return false;
    }
  }

  return false;
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
