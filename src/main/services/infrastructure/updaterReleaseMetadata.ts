import {
  formatUpdaterReleaseNotes,
  getUpdaterReleaseNoteForVersion,
} from '@shared/utils/releaseNotes';
import { compareVersions } from '@shared/utils/version';
import { parseXml } from 'builder-util-runtime';

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

export interface UpdaterReleaseNote {
  version: string;
  note: string;
}

function stableReleaseVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^v?((?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9}))$/i.exec(raw);
  return match?.[1] ?? null;
}

export const MAX_UPDATER_ATOM_BYTES = 2 * 1024 * 1024;

export function getReleaseAtomUrls(releaseApiUrl?: string): readonly string[] {
  const repositories = releaseApiUrl
    ? [REPO_NAME, LEGACY_REPO_NAME].filter((repo) =>
        releaseApiUrl.startsWith(
          `https://api.github.com/repos/${REPO_OWNER}/${repo}/releases/tags/`
        )
      )
    : [REPO_NAME, LEGACY_REPO_NAME];
  return repositories.map((repo) => `https://github.com/${REPO_OWNER}/${repo}/releases.atom`);
}

export function getUpdaterAtomHistory(
  raw: string,
  feedUrl: string,
  installedVersion: string,
  candidateVersion: string
): UpdaterReleaseNote[] | null {
  if (
    Buffer.byteLength(raw, 'utf8') > MAX_UPDATER_ATOM_BYTES ||
    !raw.trimEnd().endsWith('</feed>') ||
    !getReleaseAtomUrls().includes(feedUrl)
  )
    return null;
  try {
    // Use the same strict SAX parser as electron-updater, including escaped HTML
    // and CDATA content. Atom is independent of GitHub's REST rate limit.
    const feed = parseXml(raw);
    if (feed.name !== 'feed') return null;
    // GitHub redirects the legacy repository's Atom feed to the canonical
    // repository, whose entries use canonical links after the rename.
    const ownedFeedUrls = getReleaseAtomUrls();
    const releasePrefixes = (feedUrl === ownedFeedUrls[1] ? ownedFeedUrls : [feedUrl]).map((url) =>
      url.replace(/releases\.atom$/, 'releases/tag/')
    );
    const releases: GithubReleaseMetadata[] = [];
    for (const entry of feed.getElements('entry').slice(0, 100)) {
      const link = entry
        .getElements('link')
        .find((item) =>
          releasePrefixes.some((prefix) => item.attributes?.href?.startsWith(prefix))
        );
      const releasePrefix = releasePrefixes.find((prefix) =>
        link?.attributes?.href?.startsWith(prefix)
      );
      const tag = releasePrefix ? link?.attributes?.href?.slice(releasePrefix.length) : undefined;
      const body = entry.elementValueOrEmpty('content');
      releases.push({
        tag_name: tag,
        name: entry.elementValueOrEmpty('title'),
        body: body === 'No content.' ? '' : body,
      });
    }
    return getUpdaterReleaseHistory(releases, installedVersion, candidateVersion);
  } catch {
    return null;
  }
}

export function getReleaseHistoryApiUrl(releaseApiUrl: string, page: number): string {
  return `${releaseApiUrl.replace(/\/tags\/[^/]+$/, '')}?per_page=100&page=${page}`;
}

export function getUpdaterReleaseHistory(
  releases: readonly unknown[],
  installedVersion: string,
  candidateVersion: string
): UpdaterReleaseNote[] {
  const installed = stableReleaseVersion(installedVersion);
  const candidate = stableReleaseVersion(candidateVersion);
  if (!installed || !candidate) return [];
  const notes = new Map<string, UpdaterReleaseNote>();
  for (const value of releases) {
    if (!value || typeof value !== 'object') continue;
    const release = value as GithubReleaseMetadata;
    const version = stableReleaseVersion(release.tag_name);
    if (
      !version ||
      compareVersions(version, installed) <= 0 ||
      compareVersions(version, candidate) >= 0 ||
      shouldSkipReleaseForUpdater(release) ||
      typeof release.body !== 'string' ||
      !formatUpdaterReleaseNotes(release.body)?.trim()
    )
      continue;
    if (!notes.has(version)) notes.set(version, { version, note: release.body });
  }
  return [...notes.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export function mergeUpdaterReleaseNotes(
  provided: unknown,
  installedVersion: string,
  candidateVersion: string,
  candidateBody: unknown,
  history: readonly UpdaterReleaseNote[]
): string | undefined {
  const providedCandidate = getUpdaterReleaseNoteForVersion(provided, candidateVersion);
  const candidateNote = formatUpdaterReleaseNotes(providedCandidate)?.trim()
    ? providedCandidate
    : typeof candidateBody === 'string'
      ? candidateBody
      : undefined;
  const previous = getUpdaterReleaseHistory(
    Array.isArray(provided)
      ? provided.map((entry: { version?: unknown; note?: unknown } | null) => ({
          tag_name: entry?.version,
          body: entry?.note,
        }))
      : [],
    installedVersion,
    candidateVersion
  );
  // Provider notes win over list bodies. The list never chooses the candidate,
  // whose exact-tag metadata has already passed the skip check.
  const notes = new Map(history.map((entry) => [entry.version, entry]));
  for (const entry of previous) notes.set(entry.version, entry);
  if (notes.size === 0) {
    return formatUpdaterReleaseNotes(candidateNote) ?? formatUpdaterReleaseNotes(provided);
  }
  const older = [...notes.values()].sort((a, b) => compareVersions(b.version, a.version));
  return formatUpdaterReleaseNotes([
    ...(formatUpdaterReleaseNotes(candidateNote)?.trim()
      ? [{ version: candidateVersion, note: candidateNote }]
      : []),
    ...older,
  ]);
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
      return arch === 'arm64'
        ? `${base}/Agent.Teams.AI.Setup.${version}-arm64.exe`
        : `${base}/Agent.Teams.AI.Setup.${version}.exe`;
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
