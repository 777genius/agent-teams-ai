const REPO_OWNER = '777genius';
const REPO_NAME = 'agent-teams-ai';
const LEGACY_REPO_NAME = 'claude_agent_teams_ui';

const UPDATER_SKIP_MARKERS = [
  '[skip-updater]',
  '[test-release]',
  '[internal-release]',
  '[no-autoupdate]',
];

export interface GithubReleaseMetadata {
  tag_name?: string | null;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

export function buildReleaseAssetBase(version: string, repoName = REPO_NAME): string {
  return `https://github.com/${REPO_OWNER}/${repoName}/releases/download/v${version}`;
}

export function buildReleaseAssetBases(version: string): readonly string[] {
  return [buildReleaseAssetBase(version), buildReleaseAssetBase(version, LEGACY_REPO_NAME)];
}

export function getReleaseApiUrls(version: string): readonly string[] {
  return [REPO_NAME, LEGACY_REPO_NAME].map(
    (repoName) => `https://api.github.com/repos/${REPO_OWNER}/${repoName}/releases/tags/v${version}`
  );
}

export function shouldSkipReleaseForUpdater(release: GithubReleaseMetadata): boolean {
  if (release.draft || release.prerelease) {
    return true;
  }

  const searchableText = [release.tag_name, release.name, release.body]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();

  return UPDATER_SKIP_MARKERS.some((marker) => searchableText.includes(marker));
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
        ? `${base}/Agent.Teams.AI-${version}-arm64.dmg`
        : `${base}/Agent.Teams.AI-${version}-x64.dmg`;
    case 'win32':
      return `${base}/Agent.Teams.AI.Setup.${version}.exe`;
    case 'linux':
      return `${base}/Agent.Teams.AI-${version}.AppImage`;
    default:
      return null;
  }
}

export function getExpectedReleaseAssetUrls(
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): readonly string[] {
  const assetUrl = getExpectedReleaseAssetUrl(version, platform, arch);
  if (!assetUrl) {
    return [];
  }

  const primaryBase = buildReleaseAssetBase(version);
  return buildReleaseAssetBases(version).map((base) => assetUrl.replace(primaryBase, base));
}

export function getLatestMacMetadataUrl(version: string): string {
  return `${buildReleaseAssetBase(version)}/latest-mac.yml`;
}

export function getLatestMacMetadataUrls(version: string): readonly string[] {
  return buildReleaseAssetBases(version).map((base) => `${base}/latest-mac.yml`);
}

export function getExpectedLatestMacArtifacts(
  version: string,
  arch: Extract<NodeJS.Architecture, 'arm64' | 'x64'>
): readonly string[] {
  return arch === 'arm64'
    ? [`Agent.Teams.AI-${version}-arm64-mac.zip`, `Agent.Teams.AI-${version}-arm64.dmg`]
    : [`Agent.Teams.AI-${version}-x64-mac.zip`, `Agent.Teams.AI-${version}-x64.dmg`];
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
    const normalizedLine = line.startsWith('- ') ? line.slice(2).trimStart() : line;
    const separatorIndex = normalizedLine.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (key !== 'url' && key !== 'path') {
      continue;
    }

    assets.add(stripYamlScalar(normalizedLine.slice(separatorIndex + 1)));
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
