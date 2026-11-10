import { describe, expect, it } from 'vitest';
import {
  encodeReleaseCache,
  manifestAssetApiUrl,
  parseReleaseDownloads,
  platformReleaseInfo,
  readGitHubRelease,
  readReleaseCache,
  releaseCacheKey,
  resolveReleaseDownload,
  type GitHubRelease,
} from './releaseDownloads';

const repository = '777genius/agent-teams-ai';
const now = Date.parse('2026-10-05T12:00:00Z');
const macDate = '2026-09-20T10:00:00Z';
const publishedAt = '2026-10-04T11:00:00Z';
const canonicalNames = [
  'Agent.Teams.AI.Setup.2.17.2.exe',
  'Agent.Teams.AI.Setup.2.17.2-arm64.exe',
  'Agent.Teams.AI-2.17.2.AppImage',
  'agent-teams-ai_2.17.2_amd64.deb',
  'agent-teams-ai-2.17.2.x86_64.rpm',
  'agent-teams-ai-2.17.2.pacman',
  'Agent.Teams.AI-2.17.1-arm64.dmg',
  'Agent.Teams.AI-2.17.1-x64.dmg',
  'Agent.Teams.AI-2.17.1-arm64-mac.zip',
  'Agent.Teams.AI-2.17.1-x64-mac.zip',
];

function release(names = canonicalNames, tag = 'v2.17.2'): GitHubRelease {
  return {
    tag_name: tag,
    body: 'Release notes',
    published_at: publishedAt,
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    })),
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    phase: 'assembled',
    input: {
      repository,
      mode: 'carry-mac',
      macProductMinimum: '12.0',
      target: { tag: 'v2.17.2' },
      macSource: { productMinimum: '12.0', release: { tag: 'v2.17.1', createdAt: macDate } },
    },
    versions: { windows: '2.17.2', linux: '2.17.2', mac: '2.17.1' },
  };
}

describe('release download versions', () => {
  it('resolves carried Mac payloads and both new Windows architectures independently of asset order', () => {
    const names = [
      'Agent.Teams.AI-arm64.dmg',
      'Agent.Teams.AI-x64.dmg',
      'Claude.Agent.Teams.UI-2.17.1.dmg',
      ...canonicalNames.toReversed(),
    ];
    const data = parseReleaseDownloads(release(names), repository, manifest(), now);
    expect(data.manifestValid).toBe(true);
    expect(data.version).toBe('2.17.2');
    for (const arch of ['arm64', 'x64'] as const) {
      expect(resolveReleaseDownload(data, 'macos', arch)).toEqual({
        url: `https://github.com/${repository}/releases/download/v2.17.2/Agent.Teams.AI-2.17.1-${arch}.dmg`,
        version: '2.17.1',
        pubDate: null,
        macProductMinimum: '12.0',
      });
      expect(resolveReleaseDownload(data, 'windows', arch)).toEqual({
        url: `https://github.com/${repository}/releases/download/v2.17.2/Agent.Teams.AI.Setup.2.17.2${arch === 'arm64' ? '-arm64' : ''}.exe`,
        version: '2.17.2',
        pubDate: publishedAt,
      });
    }
    expect(resolveReleaseDownload(data, 'linux', 'x64')).toMatchObject({
      version: '2.17.2',
      pubDate: publishedAt,
    });
    expect(data.variants.linux.deb.version).toBe('2.17.2');
    expect(platformReleaseInfo(data, 'macos')).toEqual({ version: '2.17.1', pubDate: null, macProductMinimum: '12.0' });
    expect(resolveReleaseDownload(data, 'macos', 'unknown')).toBeNull();
    expect(resolveReleaseDownload(data, 'windows', 'unknown')).toBeNull();
  });

  it('shows a carried Mac date only when its source has a publication timestamp', () => {
    const value = manifest();
    const withPublication = {
      ...value,
      input: {
        ...value.input,
        macSource: {
          ...value.input.macSource,
          release: { ...value.input.macSource.release, publishedAt: macDate },
        },
      },
    };
    const data = parseReleaseDownloads(release(), repository, withPublication, now);
    expect(data.manifestValid).toBe(true);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.pubDate).toBe(macDate);
    const invalidPublication = {
      ...value,
      input: {
        ...value.input,
        macSource: {
          ...value.input.macSource,
          release: { ...value.input.macSource.release, publishedAt: 'unavailable' },
        },
      },
    };
    expect(
      resolveReleaseDownload(
        parseReleaseDownloads(release(), repository, invalidPublication, now),
        'macos',
        'arm64'
      )?.pubDate
    ).toBeNull();
  });

  it.each([
    null,
    {},
    'not JSON',
    { ...manifest(), phase: 'ready' },
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), versions: { windows: '2.17.2', linux: '2.17.2', mac: '2.17.2' } },
    { ...manifest(), input: { ...manifest().input, repository: 'someone/else' } },
    { ...manifest(), input: { ...manifest().input, target: { tag: 'v2.17.3' } } },
  ])('uses canonical versions when manifest is missing or invalid (%j)', (value) => {
    const data = parseReleaseDownloads(release(), repository, value, now);
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')).toMatchObject({
      version: '2.17.1',
      pubDate: null,
    });
    expect(resolveReleaseDownload(data, 'windows', 'x64')?.version).toBe('2.17.2');
  });

  it('rejects a manifest whose claimed platform version conflicts with canonical payloads', () => {
    const data = parseReleaseDownloads(
      release([...canonicalNames, 'Agent.Teams.AI-2.17.2-x64.dmg']),
      repository,
      manifest(),
      now
    );
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'x64')).toBeNull();
    expect(platformReleaseInfo(data, 'macos').version).toBe('2.17.1');
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.pubDate).toBeNull();
  });

  it('does not infer a version for generic aliases or unrecognized installer names', () => {
    const data = parseReleaseDownloads(
      release(['Agent.Teams.AI-arm64.dmg', 'Agent.Teams.AI.Setup.exe', 'random-2.17.2.exe']),
      repository,
      manifest(),
      now
    );
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')).toMatchObject({
      version: null,
      pubDate: null,
    });
    expect(resolveReleaseDownload(data, 'windows', 'x64')).toMatchObject({ version: null });
    expect(platformReleaseInfo(data, 'macos').version).toBeNull();
  });

  it('preserves full releases with legacy canonical filenames and their publication date', () => {
    const data = parseReleaseDownloads(
      release(
        [
          'Claude.Agent.Teams.UI-2.16.0-arm64.dmg',
          'Claude.Agent.Teams.UI-2.16.0.dmg',
          'Claude.Agent.Teams.UI.Setup.2.16.0.exe',
          'Claude.Agent.Teams.UI-2.16.0.AppImage',
        ],
        'v2.16.0'
      ),
      repository,
      null,
      now
    );
    expect(resolveReleaseDownload(data, 'macos', 'x64')).toMatchObject({
      version: '2.16.0',
      pubDate: publishedAt,
    });
    expect(resolveReleaseDownload(data, 'windows', 'x64')?.version).toBe('2.16.0');
    expect(resolveReleaseDownload(data, 'linux', 'x64')?.version).toBe('2.16.0');
  });

  it('accepts a full manifest only when all canonical platform payloads agree with the latest tag', () => {
    const full = manifest();
    const value = {
      ...full,
      input: { ...full.input, mode: 'full', macSource: null },
      versions: { windows: '2.17.2', linux: '2.17.2', mac: '2.17.2' },
    };
    const data = parseReleaseDownloads(
      release(canonicalNames.map((name) => name.replace('2.17.1', '2.17.2'))),
      repository,
      value,
      now
    );
    expect(data.manifestValid).toBe(true);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')).toMatchObject({
      version: '2.17.2',
      pubDate: publishedAt,
    });
    const missing = release(canonicalNames.filter((name) => !name.endsWith('-x64-mac.zip')));
    expect(parseReleaseDownloads(missing, repository, manifest(), now).manifestValid).toBe(false);
    expect(
      resolveReleaseDownload(
        parseReleaseDownloads(missing, repository, manifest(), now),
        'macos',
        'x64'
      )?.version
    ).toBe('2.17.1');
  });
});

describe('Mac product minimum provenance', () => {
  const names = canonicalNames.map((name) => name.replace(/2\.17\.[12]/g, '2.17.8'));
  const future = () => release(names, 'v2.17.8');
  const full = (minimum: unknown) => ({
    ...manifest(),
    input: { ...manifest().input, mode: 'full', target: { tag: 'v2.17.8' }, macProductMinimum: minimum },
    versions: { windows: '2.17.8', linux: '2.17.8', mac: '2.17.8' },
  });

  it.each(['12.0', '13.0'])('binds declared %s to both actual future Mac payloads', (minimum) => {
    const data = parseReleaseDownloads(future(), repository, full(minimum));
    expect(data.manifestValid).toBe(true);
    for (const arch of ['arm64', 'x64'] as const) {
      expect(resolveReleaseDownload(data, 'macos', arch)).toMatchObject({
        version: '2.17.8', macProductMinimum: minimum,
      });
    }
    expect(platformReleaseInfo(data, 'macos').macProductMinimum).toBe(minimum);
  });

  it.each([
    full('14.0'), full(undefined),
    { ...full('13.0'), input: { ...full('13.0').input, repository: 'someone/else' } },
    { ...full('13.0'), input: { ...full('13.0').input, target: { tag: 'v2.17.7' } } },
    { ...full('13.0'), versions: { ...full('13.0').versions, mac: '2.17.7' } },
  ])('omits unsupported or unbound declarations: %j', (value) => {
    const data = parseReleaseDownloads(future(), repository, value);
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.macProductMinimum).toBeNull();
  });

  it('rejects a carried minimum that differs from its source metadata', () => {
    const value = manifest();
    value.input.macSource.productMinimum = '13.0';
    const data = parseReleaseDownloads(release(), repository, value);
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'x64')?.macProductMinimum).toBeNull();
  });

  it('rejects a carried floor outside the supported carried-release contract', () => {
    const value = manifest();
    value.input.macProductMinimum = value.input.macSource.productMinimum = '13.0';
    const data = parseReleaseDownloads(release(), repository, value);
    expect(data.manifestValid).toBe(false);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.macProductMinimum).toBeNull();
  });

  it('preserves only the bound historical 2.17.1 floor when no manifest exists', () => {
    const mixed = release(names.map((name) => name.replace('2.17.8-arm64', '2.17.1-arm64')), 'v2.17.8');
    const data = parseReleaseDownloads(mixed, repository);
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.macProductMinimum).toBe('12.0');
    expect(resolveReleaseDownload(data, 'macos', 'x64')?.macProductMinimum).toBeNull();
    expect(platformReleaseInfo(data, 'macos').macProductMinimum).toBeNull();
  });

  it('does not assign the historical publisher floor to another repository', () => {
    const data = parseReleaseDownloads(release(), 'someone/else');
    expect(resolveReleaseDownload(data, 'macos', 'arm64')?.macProductMinimum).toBeNull();
  });
});

describe('release metadata and browser cache', () => {
  it('only accepts download URLs from this repository and this latest release', () => {
    const raw = release();
    raw.assets[0] = {
      name: 'Agent.Teams.AI.Setup.2.17.2.exe',
      browser_download_url: 'https://example.com/installer.exe',
    };
    const parsed = readGitHubRelease(raw, repository);
    expect(parsed?.assets).toHaveLength(canonicalNames.length - 1);
    expect(readGitHubRelease(raw, 'someone/else')?.assets).toHaveLength(0);
    expect(readGitHubRelease({ tag_name: 'not-a-version', assets: [] }, repository)).toBeNull();
  });

  it('only fetches a unique manifest through the configured repository asset API', () => {
    const raw = release(['release-platform-manifest.json']);
    const asset = raw.assets[0];
    if (!asset) throw new Error('Missing fixture asset');
    asset.url = `https://api.github.com/repos/${repository}/releases/assets/123`;
    expect(manifestAssetApiUrl(raw, repository)).toBe(asset.url);
    expect(manifestAssetApiUrl(raw, 'someone/else')).toBeNull();
    asset.url += '?redirect=https://example.com';
    expect(manifestAssetApiUrl(raw, repository)).toBeNull();
    raw.assets.push(asset);
    expect(manifestAssetApiUrl(raw, repository)).toBeNull();
  });

  it('rejects the old computed cache that falsely stamps Mac with the latest tag', () => {
    const old = JSON.stringify({
      ts: now,
      data: { version: '2.17.2', variants: { macos: { arm64: { version: '2.17.2' } } } },
    });
    expect(releaseCacheKey(repository)).not.toBe('cat_releases');
    expect(releaseCacheKey(repository)).not.toBe(releaseCacheKey('someone/else'));
    expect(readReleaseCache(old, repository, now)).toBeNull();
    const raw = encodeReleaseCache(repository, release(), null, now);
    expect(
      resolveReleaseDownload(readReleaseCache(raw, repository, now), 'macos', 'arm64')?.version
    ).toBe('2.17.1');
  });

  it('rejects expired, future, wrong repository and malformed cached metadata', () => {
    expect(
      readReleaseCache(
        encodeReleaseCache(repository, release(), manifest(), now),
        repository,
        now + 600001
      )
    ).toBeNull();
    expect(
      readReleaseCache(
        encodeReleaseCache(repository, release(), manifest(), now + 1),
        repository,
        now
      )
    ).toBeNull();
    expect(
      readReleaseCache(
        encodeReleaseCache(repository, release(), manifest(), now),
        'someone/else',
        now
      )
    ).toBeNull();
    expect(readReleaseCache('{', repository, now)).toBeNull();
    const malformed = JSON.stringify({
      schemaVersion: 2,
      repository,
      ts: now,
      release: { assets: [] },
    });
    expect(readReleaseCache(malformed, repository, now)).toBeNull();
  });
});
