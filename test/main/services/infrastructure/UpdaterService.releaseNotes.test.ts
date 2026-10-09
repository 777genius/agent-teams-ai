import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

import { parseUpdateInfo } from 'electron-updater/out/providers/Provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderFeed } from '../../../../scripts/ci/release/contract';
import { UpdaterService } from '../../../../src/main/services/infrastructure/UpdaterService';
import { stripDownloadsSection } from '../../../../src/shared/utils/releaseNotes';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (info: unknown) => void>(),
  fetch: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '2.17.1' },
  net: { fetch: fixture.fetch },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, handler: (info: unknown) => void) => {
        fixture.handlers.set(event, handler);
      },
    },
  },
}));
vi.mock('@main/utils/safeWebContentsSend', () => ({ safeSendToRenderer: fixture.send }));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const version = '2.17.10';
const migrationNote = 'Install this version from its DMG once to change the Apple signing team.';
const macFeed = `version: ${version}
files:
  - url: Agent.Teams.AI-${version}-arm64-mac.zip
  - url: Agent.Teams.AI-${version}-arm64.dmg
  - url: Agent.Teams.AI-${version}-x64-mac.zip
  - url: Agent.Teams.AI-${version}-x64.dmg
`;

async function announce(releaseNotes: unknown = null): Promise<void> {
  fixture.handlers.get('update-available')?.({ version, releaseNotes });
  await setImmediate();
}

function availableStatus(): unknown {
  return fixture.send.mock.calls.find((call) => call[2]?.type === 'available')?.[2];
}

describe('UpdaterService release notes', () => {
  beforeEach(() => {
    fixture.handlers.clear();
    vi.clearAllMocks();
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tag_name: `v${version}`, body: migrationNote }),
        text: () => Promise.resolve(url.endsWith('.yml') ? macFeed : ''),
      })
    );
    new UpdaterService();
  });

  it('shows the exact release body when Atom notes are absent', async () => {
    await announce();
    expect(availableStatus()).toMatchObject({ version, releaseNotes: migrationNote });
    expect(
      fixture.fetch.mock.calls.filter(([url]) => String(url).includes('/releases/tags/'))
    ).toHaveLength(1);
  });

  it('uses the new release warning when the changelog contains only older notes', async () => {
    await announce([{ version: '2.17.6', note: 'Older changes.' }]);
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\n${migrationNote}\n\n## v2.17.6\n\nOlder changes.`,
    });
  });

  it.each(['   ', '### Downloads\ninstaller links'])(
    'falls back when the current note has no displayable content: %s',
    async (note) => {
      await announce([{ version, note }]);
      expect(availableStatus()).toMatchObject({ releaseNotes: migrationNote });
    }
  );

  it('keeps a complete changelog when the candidate already has notes', async () => {
    await announce([
      { version, note: 'New changes.' },
      { version: '2.17.6', note: 'Older changes.' },
    ]);
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\nNew changes.\n\n## v2.17.6\n\nOlder changes.`,
    });
    expect(fixture.fetch.mock.calls.some(([url]) => String(url).includes('?per_page='))).toBe(
      false
    );
  });

  it('keeps the migration warning while removing installer links', async () => {
    fixture.fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: `v${version}`,
            body: `${migrationNote}\n\n### Downloads\nlinks`,
          }),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce();
    expect(availableStatus()).toMatchObject({ releaseNotes: migrationNote });
  });

  it('retains the actual release migration guidance through REST fallback and dialog filtering', async () => {
    const releaseGuide = await readFile('docs/RELEASE.md', 'utf8');
    const body = releaseGuide
      .split(`<!-- RELEASE_BODY_START v${version} -->`)[1]!
      .split(`<!-- RELEASE_BODY_END v${version} -->`)[0]!
      .trim();
    expect(body.indexOf('### macOS installation')).toBeGreaterThan(body.indexOf('### Downloads'));
    fixture.fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tag_name: `v${version}`, body }),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce();
    const status = availableStatus() as { releaseNotes: string };
    // UpdateDialog filters the already formatted IPC notes a second time.
    const visibleNotes = stripDownloadsSection(status.releaseNotes);
    expect(visibleNotes).toContain('macOS 2.17.10 requires macOS 13 or later.');
    expect(visibleNotes).toContain('Automatic updates cannot perform this one-time migration.');
    expect(visibleNotes).toContain('Your local settings, teams and projects stay in place.');
    expect(visibleNotes).not.toContain('### Downloads');
    expect(visibleNotes).not.toContain('| Platform');
    expect(visibleNotes).not.toContain('/releases/download/');
    expect(visibleNotes).toBe(status.releaseNotes);
  });

  it('still suppresses a release marked to skip updates in its API body', async () => {
    fixture.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: `v${version}`, body: '[skip-updater]' }),
    });
    await announce();
    expect(availableStatus()).toBeUndefined();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects metadata for another tag and uses the legacy repository fallback', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: url.includes('/claude_agent_teams_ui/') ? `v${version}` : 'v2.17.6',
            body: url.includes('/claude_agent_teams_ui/') ? migrationNote : 'Wrong release.',
          }),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce();
    expect(availableStatus()).toMatchObject({ releaseNotes: migrationNote });
  });

  it('restores full history for a scalar feed produced by qualified release assembly', async () => {
    const scalarNote = 'Install the DMG once. Automatic updates cannot perform this migration.';
    const rawFeed = renderFeed(
      version,
      [
        {
          name: `Agent.Teams.AI-${version}-arm64-mac.zip`,
          size: 1,
          sha256: 'a'.repeat(64),
          sha512: 'abc',
        },
      ],
      '2026-10-09T00:00:00Z',
      '22.0.0',
      scalarNote
    );
    const providerInfo = parseUpdateInfo(
      rawFeed,
      'latest-mac.yml',
      new URL('https://update.invalid/')
    );
    expect(typeof providerInfo.releaseNotes).toBe('string');
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes('?per_page=')
              ? [
                  {
                    tag_name: `v${version}`,
                    body: 'Racing list candidate must not replace the warning.',
                  },
                  { tag_name: 'v2.17.6', body: 'Intervening stable changes.' },
                  { tag_name: 'v2.17.2', body: 'Earlier stable changes.' },
                ]
              : { tag_name: `v${version}`, body: 'Different API candidate body.' }
          ),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce(providerInfo.releaseNotes);
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\n${scalarNote}\n\n## v2.17.6\n\nIntervening stable changes.\n\n## v2.17.2\n\nEarlier stable changes.`,
    });
  });

  it('merges partial provider notes with filtered REST history without replacing them', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes('?per_page=')
              ? [
                  { tag_name: 'v2.17.6', body: 'REST duplicate must not replace provider notes.' },
                  { tag_name: 'v2.17.2', body: 'Missing stable changes.' },
                  { tag_name: 'v2.17.11', body: 'Future changes.' },
                  { tag_name: 'v2.17.1', body: 'Installed changes.' },
                  { tag_name: 'v2.17.0', body: 'Old changes.' },
                  { tag_name: 'v2.17.5', body: 'Draft changes.', draft: true },
                  { tag_name: 'v2.17.4', body: 'Prerelease changes.', prerelease: true },
                  { tag_name: 'v2.17.3', body: '[internal-release]' },
                  { tag_name: 'website-v2.17.7', body: 'Website changes.' },
                ]
              : { tag_name: `v${version}`, body: migrationNote }
          ),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce([{ version: '2.17.6', note: 'Provided older changes.' }]);
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\n${migrationNote}\n\n## v2.17.6\n\nProvided older changes.\n\n## v2.17.2\n\nMissing stable changes.`,
    });
  });

  it('continues past installed versions on a full page and stops after three pages', async () => {
    const page = (url: string) => Number(new URL(url).searchParams.get('page'));
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes('?per_page=')
              ? [
                  ...(page(url) === 1
                    ? [{ tag_name: 'v2.17.0', body: 'Republished old release.' }]
                    : [{ tag_name: 'v2.17.6', body: 'Later page stable changes.' }]),
                  ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `tool-${page(url)}-${i}` })),
                ]
              : { tag_name: `v${version}`, body: migrationNote }
          ),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce('Candidate warning.');
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\nCandidate warning.\n\n## v2.17.6\n\nLater page stable changes.`,
    });
    const historyCalls = fixture.fetch.mock.calls.filter(([url]) =>
      String(url).includes('?per_page=')
    );
    expect(historyCalls).toHaveLength(3);
    expect(historyCalls.map(([url]) => page(String(url)))).toEqual([1, 2, 3]);
    expect(historyCalls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true);
  });

  it('retains a successful history page when later pagination fails', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: !url.includes('page=2'),
        json: () =>
          Promise.resolve(
            url.includes('?per_page=')
              ? [
                  { tag_name: 'v2.17.6', body: 'Fetched older changes.' },
                  ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `tool-${i}` })),
                ]
              : { tag_name: `v${version}`, body: migrationNote }
          ),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce('Candidate warning.');
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\nCandidate warning.\n\n## v2.17.6\n\nFetched older changes.`,
    });
    expect(
      fixture.fetch.mock.calls.filter(([url]) => String(url).includes('?per_page='))
    ).toHaveLength(2);
  });

  it('uses the verified legacy repository for history after canonical metadata has the wrong tag', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes('?per_page=')
              ? [{ tag_name: 'v2.17.6', body: 'Legacy history.' }]
              : {
                  tag_name: url.includes('/claude_agent_teams_ui/') ? `v${version}` : 'v2.17.9',
                  body: migrationNote,
                }
          ),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce();
    expect(availableStatus()).toMatchObject({
      releaseNotes: `## v${version}\n\n${migrationNote}\n\n## v2.17.6\n\nLegacy history.`,
    });
    expect(
      fixture.fetch.mock.calls
        .filter(([url]) => String(url).includes('?per_page='))
        .map(([url]) => url)
    ).toEqual([
      'https://api.github.com/repos/777genius/claude_agent_teams_ui/releases?per_page=100&page=1',
    ]);
  });

  it('keeps the scalar warning when history API fails and does not retry other repositories', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: !url.includes('?per_page='),
        json: () => Promise.resolve({ tag_name: `v${version}`, body: migrationNote }),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce('Provided warning.');
    expect(availableStatus()).toMatchObject({ releaseNotes: 'Provided warning.' });
    expect(
      fixture.fetch.mock.calls.filter(([url]) => String(url).includes('?per_page='))
    ).toHaveLength(1);
  });

  it.each(['history', 'metadata'] as const)(
    'recovers Atom history when REST $failure is rate limited',
    async (failure) => {
      const atomUrl = 'https://github.com/777genius/agent-teams-ai/releases.atom';
      fixture.fetch.mockImplementation((url: string) =>
        Promise.resolve({
          ok:
            !url.includes('api.github.com') ||
            (failure === 'history' && !url.includes('?per_page=')),
          json: () => Promise.resolve({ tag_name: `v${version}`, body: migrationNote }),
          text: () =>
            Promise.resolve(
              url === atomUrl
                ? `<feed><entry><title>Candidate</title><link href="https://github.com/777genius/agent-teams-ai/releases/tag/v${version}"/><content>Stale Atom candidate must not replace the warning.</content></entry><entry><title>Stable</title><link href="https://github.com/777genius/agent-teams-ai/releases/tag/v2.17.6"/><content><![CDATA[Older Atom changes.]]></content></entry></feed>`
                : macFeed
            ),
        })
      );
      await announce('Provided candidate migration warning.');
      expect(availableStatus()).toMatchObject({
        releaseNotes: `## v${version}\n\nProvided candidate migration warning.\n\n## v2.17.6\n\nOlder Atom changes.`,
      });
      const atomCalls = fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('.atom'));
      expect(atomCalls).toHaveLength(1);
      if (failure === 'history') {
        const rest = fixture.fetch.mock.calls.find(([url]) => String(url).includes('?per_page='))!;
        expect(atomCalls[0]![1].signal).toBe(rest[1].signal);
      }
    }
  );

  it('keeps the candidate warning when independent Atom XML is invalid', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: !url.includes('?per_page='),
        json: () => Promise.resolve({ tag_name: `v${version}`, body: migrationNote }),
        text: () => Promise.resolve(url.endsWith('.atom') ? '<feed><entry></feed>' : macFeed),
      })
    );
    await announce('Candidate warning.');
    expect(availableStatus()).toMatchObject({ releaseNotes: 'Candidate warning.' });
  });

  it('preserves provided notes when the release API is unavailable', async () => {
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: !url.includes('api.github.com'),
        text: () => Promise.resolve(macFeed),
      })
    );
    await announce('Provided notes.');
    expect(availableStatus()).toMatchObject({ releaseNotes: 'Provided notes.' });
  });
});
