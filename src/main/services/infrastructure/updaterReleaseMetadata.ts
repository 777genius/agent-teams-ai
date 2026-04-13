const REPO_OWNER = '777genius';
const REPO_NAME = 'claude_agent_teams_ui';

export function buildReleaseAssetBase(version: string): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}`;
}

export function getExpectedReleaseAssetUrl(
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string | null {
  const base = buildReleaseAssetBase(version);

  switch (platform) {
    case 'darwin':
      return arch === 'arm64'
        ? `${base}/Claude.Agent.Teams.UI-${version}-arm64.dmg`
        : `${base}/Claude.Agent.Teams.UI-${version}.dmg`;
    case 'win32':
      return `${base}/Claude.Agent.Teams.UI.Setup.${version}.exe`;
    case 'linux':
      return `${base}/Claude.Agent.Teams.UI-${version}.AppImage`;
    default:
      return null;
  }
}

export function getLatestMacMetadataUrl(version: string): string {
  return `${buildReleaseAssetBase(version)}/latest-mac.yml`;
}

export function getExpectedLatestMacArtifacts(
  version: string,
  arch: Extract<NodeJS.Architecture, 'arm64' | 'x64'>
): readonly string[] {
  return arch === 'arm64'
    ? [
        `Claude.Agent.Teams.UI-${version}-arm64-mac.zip`,
        `Claude.Agent.Teams.UI-${version}-arm64.dmg`,
      ]
    : [`Claude.Agent.Teams.UI-${version}-mac.zip`, `Claude.Agent.Teams.UI-${version}.dmg`];
}

function stripYamlScalar(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseReleaseMetadataAssetNames(metadataText: string): Set<string> {
  const assets = new Set<string>();

  for (const rawLine of metadataText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(?:-\s+)?(url|path):\s+(.+)$/u.exec(line);
    if (!match) {
      continue;
    }

    assets.add(stripYamlScalar(match[2]));
  }

  return assets;
}

export function isLatestMacMetadataCompatible(
  metadataText: string,
  version: string,
  arch: Extract<NodeJS.Architecture, 'arm64' | 'x64'>
): boolean {
  const assets = parseReleaseMetadataAssetNames(metadataText);
  return getExpectedLatestMacArtifacts(version, arch).every((asset) => assets.has(asset));
}
