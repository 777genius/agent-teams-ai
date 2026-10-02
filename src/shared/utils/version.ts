import {
  classifyNativeVersion,
  isLegacyOpenCodeVersionSupported,
  MINIMUM_AGENT_TEAMS_OPENCODE_VERSION,
} from '@features/opencode-compatibility';

export { MINIMUM_AGENT_TEAMS_OPENCODE_VERSION } from '@features/opencode-compatibility';

/**
 * Extract semver-like version from strings such as "v1.2.3" or "1.2.3 (beta)".
 */
export function normalizeVersion(raw: string): string {
  const match = /\d{1,10}\.\d{1,10}\.\d{1,10}/.exec(raw);
  return match ? match[0] : raw.trim();
}

export function formatRuntimeVersionTransition(current: string, latest: string): string {
  return `v${normalizeVersion(current)} → v${normalizeVersion(latest)}`;
}

/**
 * Numeric semver comparison.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = normalizeVersion(a).split('.').map(Number);
  const bParts = normalizeVersion(b).split('.').map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }

  return 0;
}

export function isVersionOlder(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) < 0;
}

/** Minimum reported by OpenCode for its built-in free-tier model routes. */
export const MINIMUM_OPENCODE_FREE_TIER_VERSION = '1.18.0';

export function isOpenCodeFreeTierVersionOutdated(version: string | null | undefined): boolean {
  return Boolean(
    version &&
    /\d{1,10}\.\d{1,10}\.\d{1,10}/.test(version) &&
    isVersionOlder(version, MINIMUM_OPENCODE_FREE_TIER_VERSION)
  );
}

export function isAgentTeamsOpenCodeVersionSupported(version: string | null | undefined): boolean {
  return isLegacyOpenCodeVersionSupported(version);
}

export function getUnsupportedAgentTeamsOpenCodeVersionMessage(
  version: string | null | undefined
): string {
  const detected = version?.trim() || 'unknown';
  const classification = classifyNativeVersion(detected);
  if (classification.kind === 'recognized' && classification.generation === 'v2') {
    return `OpenCode ${detected} is not yet qualified for team launch. Select OpenCode V1 until V2 runtime compatibility is verified.`;
  }
  if (classification.kind === 'blocked' && classification.reason !== 'too_old') {
    const reason =
      classification.reason === 'invalid'
        ? 'has an invalid version'
        : classification.reason === 'prerelease'
          ? 'is a prerelease'
          : 'has an unsupported native generation';
    return `OpenCode ${detected} ${reason}. Select a supported stable OpenCode V1 version before loading providers, models, or launching teammates.`;
  }
  return (
    `OpenCode ${detected} is below the supported minimum ` +
    `${MINIMUM_AGENT_TEAMS_OPENCODE_VERSION}. Update OpenCode before loading providers, ` +
    'models, or launching teammates.'
  );
}
