/**
 * Extract semver-like version from strings such as "v1.2.3" or "1.2.3 (beta)".
 */
export function normalizeVersion(raw: string): string {
  const match = /\d{1,10}\.\d{1,10}\.\d{1,10}/.exec(raw);
  return match ? match[0] : raw.trim();
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

/**
 * OpenCode 1.16 introduced the session storage schema used by the current
 * Agent Teams integration. Older binaries can read parts of a newer profile
 * and then fail writes, which makes catalogs appear transiently available.
 */
export const MINIMUM_AGENT_TEAMS_OPENCODE_VERSION = '1.16.0';

export function isAgentTeamsOpenCodeVersionSupported(version: string | null | undefined): boolean {
  if (!version || !/\d{1,10}\.\d{1,10}\.\d{1,10}/.test(version)) {
    return false;
  }
  return !isVersionOlder(version, MINIMUM_AGENT_TEAMS_OPENCODE_VERSION);
}

export function getUnsupportedAgentTeamsOpenCodeVersionMessage(
  version: string | null | undefined
): string {
  const detected = version?.trim() || 'unknown';
  return (
    `OpenCode ${detected} is below the supported minimum ` +
    `${MINIMUM_AGENT_TEAMS_OPENCODE_VERSION}. Update OpenCode before loading providers, ` +
    'models, or launching teammates.'
  );
}
