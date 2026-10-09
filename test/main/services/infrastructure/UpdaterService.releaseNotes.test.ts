import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(availableStatus()).toMatchObject({ releaseNotes: migrationNote });
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
