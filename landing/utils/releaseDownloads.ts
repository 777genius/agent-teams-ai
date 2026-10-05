import type { DownloadArch, DownloadOs } from '../data/downloads';

export type ReleaseAsset = { name: string; browser_download_url: string; url?: string };
export type GitHubRelease = {
  tag_name: string;
  body: string | null;
  published_at: string | null;
  assets: ReleaseAsset[];
};
type Variant = {
  url: string | null;
  platformKey: string | null;
  version: string | null;
  pubDate: string | null;
};
export type DownloadsApiResponse = {
  ok: boolean;
  source: 'github-releases';
  fetchedAt: string;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
  manifestValid: boolean;
  variants: {
    macos: { arm64: Variant; x64: Variant; universal: Variant };
    windows: { arm64: Variant; x64: Variant };
    linux: { appimage: Variant; deb: Variant };
  };
};
type Candidate = {
  asset: ReleaseAsset;
  os: DownloadOs;
  slot: string;
  version: string;
  rank: number;
};
type PlatformManifest = {
  versions: { windows: string; linux: string; mac: string };
  macDate: string | null;
};
export type ResolvedDownload = { url: string; version: string | null; pubDate: string | null };
const CACHE_SCHEMA = 2;
const CACHE_TTL = 10 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const emptyVariant = (): Variant => ({
  url: null,
  platformKey: null,
  version: null,
  pubDate: null,
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function date(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function version(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

export function readGitHubRelease(value: unknown, repository: string): GitHubRelease | null {
  const release = record(value);
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets))
    return null;
  const tagVersion = version(release.tag_name.replace(/^v/, ''));
  if (!tagVersion || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
  const prefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  const assets: ReleaseAsset[] = [];
  for (const value of release.assets) {
    const asset = record(value);
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string')
      continue;
    // Only links to this release in the configured repository are usable downloads.
    if (asset.browser_download_url !== `${prefix}${encodeURIComponent(asset.name)}`) continue;
    assets.push({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      ...(typeof asset.url === 'string' ? { url: asset.url } : {}),
    });
  }
  return {
    tag_name: release.tag_name,
    body: typeof release.body === 'string' ? release.body : null,
    published_at: date(release.published_at),
    assets,
  };
}

export function manifestAssetApiUrl(release: GitHubRelease, repository: string): string | null {
  const assets = release.assets.filter((asset) => asset.name === 'release-platform-manifest.json');
  const url = assets.length === 1 ? assets[0]?.url : null;
  const prefix = `https://api.github.com/repos/${repository}/releases/assets/`;
  return url?.startsWith(prefix) && /^\d+$/.test(url.slice(prefix.length)) ? url : null;
}

function candidate(asset: ReleaseAsset): Candidate | null {
  const patterns: { pattern: RegExp; os: DownloadOs; slot: string }[] = [
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)-(.+)-arm64\.dmg$/,
      os: 'macos',
      slot: 'arm64',
    },
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)-(.+)-x64\.dmg$/,
      os: 'macos',
      slot: 'x64',
    },
    { pattern: /^(Claude\.Agent\.Teams\.UI)-(.+)\.dmg$/, os: 'macos', slot: 'x64' },
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)-(.+)-(?:arm64|x64)-mac\.zip$/,
      os: 'macos',
      slot: 'zip',
    },
    { pattern: /^(Claude\.Agent\.Teams\.UI)-(.+)-mac\.zip$/, os: 'macos', slot: 'zip' },
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)\.Setup\.(.+)-arm64\.exe$/,
      os: 'windows',
      slot: 'arm64',
    },
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)\.Setup\.(.+)\.exe$/,
      os: 'windows',
      slot: 'x64',
    },
    {
      pattern: /^(Agent\.Teams\.AI|Claude\.Agent\.Teams\.UI)-(.+)\.AppImage$/,
      os: 'linux',
      slot: 'appimage',
    },
    {
      pattern: /^(agent-teams-ai|claude-agent-teams-ui)_(.+)_amd64\.deb$/,
      os: 'linux',
      slot: 'deb',
    },
    {
      pattern: /^(agent-teams-ai|claude-agent-teams-ui)-(.+)\.x86_64\.rpm$/,
      os: 'linux',
      slot: 'rpm',
    },
    {
      pattern: /^(agent-teams-ai|claude-agent-teams-ui)-(.+)\.pacman$/,
      os: 'linux',
      slot: 'pacman',
    },
  ];
  for (const { pattern, os, slot } of patterns) {
    const match = pattern.exec(asset.name);
    const parsedVersion = version(match?.[2]);
    if (match && parsedVersion)
      return {
        asset,
        os,
        slot,
        version: parsedVersion,
        rank: match[1] === 'Agent.Teams.AI' || match[1] === 'agent-teams-ai' ? 0 : 1,
      };
  }
  return null;
}

function readManifest(
  value: unknown,
  release: GitHubRelease,
  repository: string,
  candidates: Candidate[]
): PlatformManifest | null {
  const manifest = record(value);
  const input = record(manifest?.input);
  const target = record(input?.target);
  const versions = record(manifest?.versions);
  const windows = version(versions?.windows);
  const linux = version(versions?.linux);
  const mac = version(versions?.mac);
  const latest = release.tag_name.replace(/^v/, '');
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.phase !== 'assembled' ||
    input?.repository !== repository ||
    target?.tag !== release.tag_name ||
    !windows ||
    !linux ||
    !mac ||
    windows !== latest ||
    linux !== latest
  )
    return null;
  if (input.mode !== 'full' && input.mode !== 'carry-mac') return null;
  if (input.mode === 'full' && mac !== latest) return null;
  let macDate = release.published_at;
  if (input.mode === 'carry-mac') {
    const source = record(record(input.macSource)?.release);
    if (mac === latest || source?.tag !== `v${mac}` || !date(source.createdAt)) return null;
    macDate = date(source.publishedAt);
  }
  const expected = [
    `Agent.Teams.AI.Setup.${windows}.exe`,
    `Agent.Teams.AI.Setup.${windows}-arm64.exe`,
    `Agent.Teams.AI-${linux}.AppImage`,
    `agent-teams-ai_${linux}_amd64.deb`,
    `agent-teams-ai-${linux}.x86_64.rpm`,
    `agent-teams-ai-${linux}.pacman`,
    `Agent.Teams.AI-${mac}-arm64.dmg`,
    `Agent.Teams.AI-${mac}-x64.dmg`,
    `Agent.Teams.AI-${mac}-arm64-mac.zip`,
    `Agent.Teams.AI-${mac}-x64-mac.zip`,
  ];
  if (!expected.every((name) => release.assets.filter((asset) => asset.name === name).length === 1))
    return null;
  if (
    candidates.some(
      (item) =>
        item.rank === 0 && item.version !== (item.os === 'macos' ? mac : versions?.[item.os])
    )
  )
    return null;
  return { versions: { windows, linux, mac }, macDate };
}

function selectVariant(
  candidates: Candidate[],
  release: GitHubRelease,
  manifest: PlatformManifest | null,
  os: DownloadOs,
  slot: string,
  aliases: string[]
): Variant {
  const matching = candidates
    .filter((item) => item.os === os && item.slot === slot)
    .sort((a, b) => a.rank - b.rank || a.asset.name.localeCompare(b.asset.name));
  const bestRank = matching[0]?.rank;
  const best = matching.filter((item) => item.rank === bestRank);
  if (best.length === 1) {
    const item = best[0];
    if (!item) return emptyVariant();
    const pubDate =
      os === 'macos' && manifest
        ? manifest.macDate
        : item.version === release.tag_name.replace(/^v/, '')
          ? release.published_at
          : null;
    return {
      url: item.asset.browser_download_url,
      platformKey: item.asset.name,
      version: item.version,
      pubDate,
    };
  }
  // Ambiguous canonical payloads cannot acquire a version from a generic alias.
  for (const name of aliases) {
    const assets = release.assets.filter((asset) => asset.name === name);
    const asset = assets.length === 1 ? assets[0] : null;
    if (asset)
      return { ...emptyVariant(), url: asset.browser_download_url, platformKey: asset.name };
  }
  return emptyVariant();
}

export function parseReleaseDownloads(
  release: GitHubRelease,
  repository: string,
  manifestValue: unknown = null,
  now = Date.now()
): DownloadsApiResponse {
  const candidates = release.assets
    .map(candidate)
    .filter((item): item is Candidate => item !== null);
  const manifest = readManifest(manifestValue, release, repository, candidates);
  const select = (os: DownloadOs, slot: string, aliases: string[]) =>
    selectVariant(candidates, release, manifest, os, slot, aliases);
  return {
    ok: release.assets.length > 0,
    source: 'github-releases',
    fetchedAt: new Date(now).toISOString(),
    version: release.tag_name.replace(/^v/, ''),
    notes: release.body,
    pubDate: release.published_at,
    manifestValid: manifest !== null,
    variants: {
      macos: {
        arm64: select('macos', 'arm64', [
          'Agent.Teams.AI-arm64.dmg',
          'Claude-Agent-Teams-UI-arm64.dmg',
        ]),
        x64: select('macos', 'x64', ['Agent.Teams.AI-x64.dmg', 'Claude-Agent-Teams-UI-x64.dmg']),
        universal: emptyVariant(),
      },
      windows: {
        arm64: select('windows', 'arm64', ['Agent.Teams.AI.Setup-arm64.exe']),
        x64: select('windows', 'x64', [
          'Agent.Teams.AI.Setup.exe',
          'Claude-Agent-Teams-UI-Setup.exe',
        ]),
      },
      linux: {
        appimage: select('linux', 'appimage', [
          'Agent.Teams.AI.AppImage',
          'Claude-Agent-Teams-UI.AppImage',
        ]),
        deb: select('linux', 'deb', [
          'agent-teams-ai-amd64.deb',
          'Claude-Agent-Teams-UI-amd64.deb',
        ]),
      },
    },
  };
}

export function resolveReleaseDownload(
  data: DownloadsApiResponse | null | undefined,
  os: DownloadOs,
  arch: DownloadArch | 'unknown'
): ResolvedDownload | null {
  if (!data?.ok) return null;
  const variants = data.variants;
  const selected =
    os === 'linux'
      ? variants.linux.appimage.url
        ? variants.linux.appimage
        : variants.linux.deb
      : arch === 'arm64' || arch === 'x64'
        ? variants[os][arch]
        : null;
  return selected?.url
    ? { url: selected.url, version: selected.version, pubDate: selected.pubDate }
    : null;
}

export function platformReleaseInfo(
  data: DownloadsApiResponse | null | undefined,
  os: DownloadOs
): { version: string | null; pubDate: string | null } {
  const variants = data ? Object.values(data.variants[os]).filter((item) => item.url !== null) : [];
  const versions = new Set(variants.map((item) => item.version));
  const dates = new Set(variants.map((item) => item.pubDate));
  return {
    version: versions.size === 1 ? (variants[0]?.version ?? null) : null,
    pubDate: versions.size === 1 && dates.size === 1 ? (variants[0]?.pubDate ?? null) : null,
  };
}

export function releaseCacheKey(repository: string): string {
  return `release-downloads-v${CACHE_SCHEMA}:${repository}`;
}

export function encodeReleaseCache(
  repository: string,
  release: GitHubRelease,
  manifest: unknown,
  now = Date.now()
): string {
  return JSON.stringify({ schemaVersion: CACHE_SCHEMA, repository, ts: now, release, manifest });
}

export function readReleaseCache(
  raw: string | null,
  repository: string,
  now = Date.now()
): DownloadsApiResponse | null {
  if (!raw) return null;
  try {
    const cache = record(JSON.parse(raw));
    if (
      !cache ||
      cache.schemaVersion !== CACHE_SCHEMA ||
      cache.repository !== repository ||
      typeof cache.ts !== 'number' ||
      !Number.isFinite(cache.ts) ||
      cache.ts > now ||
      now - cache.ts > CACHE_TTL
    )
      return null;
    const release = readGitHubRelease(cache.release, repository);
    return release ? parseReleaseDownloads(release, repository, cache.manifest, cache.ts) : null;
  } catch {
    return null;
  }
}
