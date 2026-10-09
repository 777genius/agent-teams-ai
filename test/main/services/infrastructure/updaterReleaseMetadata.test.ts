import { describe, expect, it } from 'vitest';

import {
  getExpectedLatestMacArtifacts,
  getExpectedReleaseAssetUrl,
  getExpectedReleaseAssetUrls,
  getLatestMacMetadataUrl,
  getLatestMacMetadataUrls,
  getReleaseApiUrls,
  getReleaseAtomUrls,
  getReleaseHistoryApiUrl,
  getUpdaterAtomHistory,
  getUpdaterReleaseHistory,
  isLatestMacMetadataCompatible,
  MAX_UPDATER_ATOM_BYTES,
  mergeUpdaterReleaseNotes,
  parseReleaseMetadataAssetNames,
  shouldSkipReleaseForUpdater,
} from '../../../../src/main/services/infrastructure/updaterReleaseMetadata';

const version = '2.17.10';

describe('updaterReleaseMetadata', () => {
  it('builds platform-specific asset URLs', () => {
    expect(getExpectedReleaseAssetUrl('1.2.3', 'darwin', 'arm64')).toBe(
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI-1.2.3-arm64.dmg'
    );
    expect(getExpectedReleaseAssetUrl('1.2.3', 'darwin', 'x64')).toBe(
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI-1.2.3-x64.dmg'
    );
    expect(getExpectedReleaseAssetUrl('1.2.3', 'win32', 'x64')).toBe(
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI.Setup.1.2.3.exe'
    );
    expect(getExpectedReleaseAssetUrl('1.2.3', 'win32', 'arm64')).toBe(
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI.Setup.1.2.3-arm64.exe'
    );
    expect(getExpectedReleaseAssetUrl('1.2.3', 'linux', 'x64')).toBe(
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI-1.2.3.AppImage'
    );
  });

  it('builds primary and legacy repo asset URLs after the GitHub repo rename', () => {
    expect(getExpectedReleaseAssetUrls('1.2.3', 'darwin', 'arm64')).toEqual([
      'https://github.com/777genius/agent-teams-ai/releases/download/v1.2.3/Agent.Teams.AI-1.2.3-arm64.dmg',
      'https://github.com/777genius/claude_agent_teams_ui/releases/download/v1.2.3/Agent.Teams.AI-1.2.3-arm64.dmg',
    ]);
    expect(getReleaseApiUrls('1.2.3')).toEqual([
      'https://api.github.com/repos/777genius/agent-teams-ai/releases/tags/v1.2.3',
      'https://api.github.com/repos/777genius/claude_agent_teams_ui/releases/tags/v1.2.3',
    ]);
  });

  it('detects releases that must be hidden from auto-updater', () => {
    expect(shouldSkipReleaseForUpdater({ tag_name: 'v1.2.3', name: 'v1.2.3' })).toBe(false);
    expect(shouldSkipReleaseForUpdater({ tag_name: 'v1.2.4', prerelease: true })).toBe(true);
    expect(shouldSkipReleaseForUpdater({ tag_name: 'v1.2.5', draft: true })).toBe(true);
    expect(
      shouldSkipReleaseForUpdater({
        tag_name: 'v1.2.6',
        name: 'Internal smoke [skip-updater]',
      })
    ).toBe(true);
    expect(
      shouldSkipReleaseForUpdater({
        tag_name: 'v1.2.7',
        body: 'Temporary QA build [test-release]',
      })
    ).toBe(true);
  });

  it('filters and sorts only intervening public stable app notes', () => {
    expect(
      getUpdaterReleaseHistory(
        [
          { tag_name: 'v2.17.6', body: 'Newest older notes.' },
          { tag_name: '2.17.2', body: 'Earlier notes.' },
          { tag_name: 'v2.17.6', body: 'Duplicate notes.' },
          { tag_name: 'v2.17.10', body: 'Candidate race.' },
          { tag_name: 'v2.17.11', body: 'Future notes.' },
          { tag_name: 'v2.17.1', body: 'Installed notes.' },
          { tag_name: 'v2.17.0', body: 'Old notes.' },
          { tag_name: 'v2.17.3', body: 'Draft.', draft: true },
          { tag_name: 'v2.17.4', body: 'Prerelease.', prerelease: true },
          { tag_name: 'v2.17.5', body: '[no-autoupdate]' },
          { tag_name: 'v2.17.8-beta', body: 'Beta.' },
          { tag_name: 'runtime-v2.17.7', body: 'Tooling.' },
          { tag_name: 'v02.17.7', body: 'Invalid stable version.' },
          { tag_name: 'v2.17.9', body: '### Downloads\nlinks' },
          null,
        ],
        '2.17.1',
        '2.17.10'
      )
    ).toEqual([
      { version: '2.17.6', note: 'Newest older notes.' },
      { version: '2.17.2', note: 'Earlier notes.' },
    ]);
  });

  it('parses bounded Atom entries with the official XML parser and applies repository/version/marker filters', () => {
    const url = getReleaseAtomUrls()[0]!;
    const link = 'https://github.com/777genius/agent-teams-ai/releases/tag/';
    const atom = `<feed>
      <entry><title>Stable &amp; reviewed</title><link href="${link}v2.17.6"/><content>&lt;p&gt;Older &amp; useful changes.&lt;/p&gt;</content></entry>
      <entry><link href="${link}v2.17.2"/><content><![CDATA[Earlier changes.]]></content></entry>
      <entry><link href="${link}v2.17.10"/><content>Candidate race.</content></entry>
      <entry><link href="${link}v2.17.1"/><content>Installed.</content></entry>
      <entry><link href="${link}v2.17.11"/><content>Future.</content></entry>
      <entry><link href="${link}v2.17.5-beta"/><content>Beta.</content></entry>
      <entry><link href="${link}tool-v2.17.7"/><content>Service release.</content></entry>
      <entry><title>[skip-updater]</title><link href="${link}v2.17.4"/><content>Hidden.</content></entry>
      <entry><link href="https://github.com/other/repository/releases/tag/v2.17.8"/><content>Wrong repo.</content></entry>
    </feed>`;
    expect(getUpdaterAtomHistory(atom, url, '2.17.1', version)).toEqual([
      { version: '2.17.6', note: '<p>Older & useful changes.</p>' },
      { version: '2.17.2', note: 'Earlier changes.' },
    ]);
    expect(getUpdaterAtomHistory('<feed><entry></feed>', url, '2.17.1', version)).toBeNull();
    expect(
      getUpdaterAtomHistory(
        atom,
        'https://github.com/other/repository/releases.atom',
        '2.17.1',
        version
      )
    ).toBeNull();
    expect(getReleaseAtomUrls(getReleaseApiUrls(version)[1])).toEqual([
      'https://github.com/777genius/claude_agent_teams_ui/releases.atom',
    ]);
  });

  it('caps Atom text bytes and inspected entries', () => {
    const url = getReleaseAtomUrls()[0]!;
    expect(
      getUpdaterAtomHistory(
        `<feed>${'x'.repeat(MAX_UPDATER_ATOM_BYTES)}</feed>`,
        url,
        '2.17.1',
        version
      )
    ).toBeNull();
    const atom = `<feed>${Array.from({ length: 100 }, () => '<entry><title>Tool release.</title></entry>').join('')}<entry><link href="https://github.com/777genius/agent-teams-ai/releases/tag/v2.17.6"/><content>Beyond bound.</content></entry></feed>`;
    expect(getUpdaterAtomHistory(atom, url, '2.17.1', version)).toEqual([]);
  });

  it('uses semantic version bounds rather than lexical ordering', () => {
    expect(
      getUpdaterReleaseHistory(
        [
          { tag_name: 'v2.9.0', body: 'Installed.' },
          { tag_name: 'v2.10.0', body: 'Intermediate.' },
          { tag_name: 'v2.11.0', body: 'Candidate.' },
        ],
        '2.9.0',
        '2.11.0'
      )
    ).toEqual([{ version: '2.10.0', note: 'Intermediate.' }]);
  });

  it('retains partial provided notes on API failure while adding exact-tag fallback', () => {
    expect(
      mergeUpdaterReleaseNotes(
        [{ version: '2.17.6', note: 'Provider notes.' }],
        '2.17.1',
        '2.17.10',
        'Candidate warning.',
        []
      )
    ).toBe('## v2.17.10\n\nCandidate warning.\n\n## v2.17.6\n\nProvider notes.');
  });

  it('derives history pages from the exact-tag repository URL', () => {
    expect(getReleaseHistoryApiUrl(getReleaseApiUrls('2.17.10')[0]!, 2)).toBe(
      'https://api.github.com/repos/777genius/agent-teams-ai/releases?per_page=100&page=2'
    );
  });

  it('extracts updater asset names from latest-mac.yml text', () => {
    const metadata = `
version: 1.2.3
files:
  - url: "Agent.Teams.AI-1.2.3-arm64-mac.zip"
    sha512: abc
    size: 123
  - url: 'Agent.Teams.AI-1.2.3-arm64.dmg'
    sha512: def
    size: 456
path: Agent.Teams.AI-1.2.3-arm64-mac.zip
`;

    expect(parseReleaseMetadataAssetNames(metadata)).toEqual(
      new Set(['Agent.Teams.AI-1.2.3-arm64-mac.zip', 'Agent.Teams.AI-1.2.3-arm64.dmg'])
    );
  });

  it('validates arch compatibility for latest-mac.yml', () => {
    const version = '1.2.3';
    const arm64Metadata = `
version: ${version}
files:
  - url: Agent.Teams.AI-${version}-arm64-mac.zip
    sha512: abc
    size: 123
  - url: Agent.Teams.AI-${version}-arm64.dmg
    sha512: def
    size: 456
path: Agent.Teams.AI-${version}-arm64-mac.zip
`;

    expect(getExpectedLatestMacArtifacts(version, 'arm64')).toEqual([
      `Agent.Teams.AI-${version}-arm64-mac.zip`,
      `Agent.Teams.AI-${version}-arm64.dmg`,
    ]);
    expect(getExpectedLatestMacArtifacts(version, 'x64')).toEqual([
      `Agent.Teams.AI-${version}-x64-mac.zip`,
      `Agent.Teams.AI-${version}-x64.dmg`,
    ]);
    expect(getLatestMacMetadataUrl(version)).toBe(
      `https://github.com/777genius/agent-teams-ai/releases/download/v${version}/latest-mac.yml`
    );
    expect(getLatestMacMetadataUrls(version)).toEqual([
      `https://github.com/777genius/agent-teams-ai/releases/download/v${version}/latest-mac.yml`,
      `https://github.com/777genius/claude_agent_teams_ui/releases/download/v${version}/latest-mac.yml`,
    ]);
    expect(isLatestMacMetadataCompatible(arm64Metadata, version, 'arm64')).toBe(true);
    expect(isLatestMacMetadataCompatible(arm64Metadata, version, 'x64')).toBe(false);
  });
});
