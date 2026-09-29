import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildUpdaterFeeds,
  getPromotionLayout,
  getMacUpdaterMinimumSystemVersion,
  parsePromotionConfig,
} from '../../scripts/ci/promote-existing-draft.mjs';

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const nodeOs: typeof import('node:os') = require('node:os');
const {
  AppUpdater,
}: typeof import('electron-updater/out/AppUpdater') = require('electron-updater/out/AppUpdater');
const {
  GenericProvider,
}: typeof import('electron-updater/out/providers/GenericProvider') = require('electron-updater/out/providers/GenericProvider');
const {
  ElectronHttpExecutor,
}: typeof import('electron-updater/out/electronHttpExecutor') = require('electron-updater/out/electronHttpExecutor');
const {
  parseUpdateInfo,
}: typeof import('electron-updater/out/providers/Provider') = require('electron-updater/out/providers/Provider');

// Use the real updater's eligibility/check pipeline. Only metadata transport and
// app lifecycle are replaced; no Electron process, server or download is needed.
class FeedCompatibilityUpdater extends AppUpdater {
  constructor(
    private readonly feed: string,
    directory: string
  ) {
    super(undefined, {
      version: '2.15.0',
      name: 'release-compatibility-test',
      isPackaged: true,
      appUpdateConfigPath: path.join(directory, 'app-update.yml'),
      userDataPath: directory,
      baseCachePath: directory,
      whenReady: async () => {},
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {},
    });
    this.autoDownload = false;
    this.logger = null;
  }

  protected override async getUpdateInfoAndProvider() {
    const url = new URL('https://release-compatibility.invalid/');
    return {
      info: parseUpdateInfo(this.feed, 'latest-mac.yml', url),
      provider: new GenericProvider({ provider: 'generic', url: url.href }, this, {
        platform: 'darwin',
        isUseMultipleRangeRequest: false,
        executor: new ElectronHttpExecutor(() => {}),
      }),
    };
  }

  protected override async doDownloadUpdate(): Promise<string[]> {
    throw new Error('Compatibility test must never download an update');
  }

  override quitAndInstall(): void {
    throw new Error('Compatibility test must never install an update');
  }
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('promote-existing-draft', () => {
  it('defines every stable, legacy, and updater source once', () => {
    const layout = getPromotionLayout('2.9.0');

    expect(layout.sourceAssets).toHaveLength(10);
    expect(Object.keys(layout.stableAliases)).toHaveLength(8);
    expect(Object.keys(layout.legacyStableAliases)).toHaveLength(7);
    expect(Object.keys(layout.legacyUpdaterAliases)).toHaveLength(6);
    expect(layout.sourceAssets).toContain('Agent.Teams.AI-2.9.0-arm64-mac.zip');
    expect(layout.sourceAssets).toContain('Agent.Teams.AI.Setup.2.9.0.exe');
    expect(layout.sourceAssets).toContain('Agent.Teams.AI.Setup.2.9.0-arm64.exe');
  });

  it('rejects ambiguous publication settings', () => {
    expect(() =>
      parsePromotionConfig({
        RELEASE_REPOSITORY: '777genius/agent-teams-ai',
        RELEASE_TAG: 'v2.9.0',
        PROMOTE_DRY_RUN: 'true',
        PUBLISH_RELEASE: 'true',
      })
    ).toThrow('cannot be combined');
  });

  it('builds canonical updater feeds from exact artifact bytes', async () => {
    const directory = await makeTemporaryDirectory('promote-feeds-');
    const layout = getPromotionLayout('2.9.0');
    for (const sourceName of layout.sourceAssets) {
      await writeFile(path.join(directory, sourceName), `fixture:${sourceName}`);
    }

    const feeds = await buildUpdaterFeeds({
      directory,
      version: '2.9.0',
      releaseDate: '2026-07-19T00:00:00.000Z',
      feedSources: layout.feedSources,
      macMinimumSystemVersion: '13.0',
    });

    const windowsBytes = Buffer.from(`fixture:${layout.feedSources.windowsX64}`);
    const windowsSha = createHash('sha512').update(windowsBytes).digest('base64');
    const windowsArm64Bytes = Buffer.from(`fixture:${layout.feedSources.windowsArm64}`);
    const windowsArm64Sha = createHash('sha512').update(windowsArm64Bytes).digest('base64');
    expect(feeds['latest.yml']).toContain('version: 2.9.0');
    expect(feeds['latest.yml']).toContain(`sha512: ${windowsSha}`);
    expect(feeds['latest.yml']).toContain(`sha512: ${windowsArm64Sha}`);
    expect(feeds['latest.yml']).toContain(layout.feedSources.windowsArm64);
    expect(feeds['latest-linux.yml']).toContain(layout.feedSources.linux);
    expect(feeds['latest-mac.yml']).toContain(layout.feedSources.macArm64Zip);
    expect(feeds['latest-mac.yml']).toContain(layout.feedSources.macX64Zip);
    expect(feeds['latest-mac.yml']).toContain('minimumSystemVersion: 22.0.0');
  });

  it.each(['', undefined, '13.5', '14.0'])('rejects an unmapped macOS floor: %s', (floor) => {
    expect(() => getMacUpdaterMinimumSystemVersion(floor)).toThrow(
      'Unsupported release macOS minimum'
    );
  });

  it.each([
    { macMinimum: '13.0', darwin: '21.6.0', eligible: false },
    { macMinimum: '13.0', darwin: '22.0.0', eligible: true },
    { macMinimum: '12.0', darwin: '21.6.0', eligible: true },
  ])(
    'real updater eligibility for release macOS $macMinimum on Darwin $darwin',
    async ({ macMinimum, darwin, eligible }) => {
      const directory = await makeTemporaryDirectory('updater-compatibility-TEST-');
      const layout = getPromotionLayout('9.9.9');
      for (const sourceName of layout.sourceAssets) {
        await writeFile(path.join(directory, sourceName), `fixture:${sourceName}`);
      }
      const feeds = await buildUpdaterFeeds({
        directory,
        version: '9.9.9',
        releaseDate: '2026-09-28T00:00:00.000Z',
        feedSources: layout.feedSources,
        macMinimumSystemVersion: macMinimum,
      });
      vi.spyOn(nodeOs, 'release').mockReturnValue(darwin);
      const updater = new FeedCompatibilityUpdater(feeds['latest-mac.yml'], directory);
      const available = vi.fn();
      const unavailable = vi.fn();
      updater.on('update-available', available);
      updater.on('update-not-available', unavailable);
      const result = await updater.checkForUpdates();
      expect(result?.isUpdateAvailable).toBe(eligible);
      expect(available).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(unavailable).toHaveBeenCalledTimes(eligible ? 0 : 1);
    }
  );

  // The dry run fakes the gh CLI with a shebang script named `gh` and prepends
  // its directory with a colon separator - neither works on Windows, where the
  // real gh would be used against a repository that does not exist.
  it.skipIf(process.platform === 'win32')(
    'runs an isolated end-to-end dry run with verified release assets',
    async () => {
      const root = await makeTemporaryDirectory('promote-e2e-');
      const fixtures = path.join(root, 'fixtures');
      const output = path.join(root, 'output');
      const bin = path.join(root, 'bin');
      await Promise.all([mkdir(fixtures), mkdir(output), mkdir(bin)]);

      const version = '9.9.9';
      const tag = `v${version}`;
      const targetCommit = 'a'.repeat(40);
      const layout = getPromotionLayout(version);
      const assets = [];
      for (const sourceName of layout.sourceAssets) {
        const contents = Buffer.from(`fixture:${sourceName}`);
        await writeFile(path.join(fixtures, sourceName), contents);
        assets.push({
          name: sourceName,
          digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
          size: contents.length,
        });
      }

      const fakeGhPath = path.join(bin, 'gh');
      await writeFile(
        fakeGhPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(process.env.FAKE_RELEASE_JSON);
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/commits/')) {
  process.stdout.write(process.env.FAKE_TARGET_COMMIT + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/contents/package.json?ref=')) {
  process.stdout.write(JSON.stringify({ build: { mac: { minimumSystemVersion: '13.0' } } }));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  const pattern = args[args.indexOf('--pattern') + 1];
  const directory = args[args.indexOf('--dir') + 1];
  fs.copyFileSync(path.join(process.env.FAKE_FIXTURES, pattern), path.join(directory, pattern));
  process.exit(0);
}
process.stderr.write('Unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`
      );
      await chmod(fakeGhPath, 0o755);

      const release = {
        body: 'Release notes',
        assets,
        isDraft: true,
        isPrerelease: false,
        targetCommitish: targetCommit,
        name: tag,
        tagName: tag,
      };
      const logPath = path.join(root, 'gh.log');
      const scriptPath = path.resolve('scripts/ci/promote-existing-draft.mjs');
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_REPOSITORY: 'example/release-sandbox',
          RELEASE_TAG: tag,
          PROMOTE_DRY_RUN: 'true',
          PROMOTION_OUTPUT_DIR: output,
          FAKE_FIXTURES: fixtures,
          FAKE_GH_LOG: logPath,
          FAKE_RELEASE_JSON: JSON.stringify(release),
          FAKE_TARGET_COMMIT: targetCommit,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"dryRun": true');
      expect(await readFile(path.join(output, 'Agent.Teams.AI-arm64.dmg'), 'utf8')).toBe(
        `fixture:Agent.Teams.AI-${version}-arm64.dmg`
      );
      expect(await readFile(path.join(output, 'Agent.Teams.AI.Setup-arm64.exe'), 'utf8')).toBe(
        `fixture:Agent.Teams.AI.Setup.${version}-arm64.exe`
      );
      expect(await readFile(path.join(output, 'latest.yml'), 'utf8')).toContain(
        `Agent.Teams.AI.Setup.${version}.exe`
      );
      expect(await readFile(path.join(output, 'latest-linux.yml'), 'utf8')).toContain(
        `Agent.Teams.AI-${version}.AppImage`
      );
      expect(await readFile(path.join(output, 'latest-mac.yml'), 'utf8')).toContain(
        `Agent.Teams.AI-${version}-x64-mac.zip`
      );

      const calls = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[0] === 'release' && args[1] === 'download')).toHaveLength(
        10
      );
      expect(calls.some((args) => args[0] === 'release' && args[1] === 'upload')).toBe(false);
      expect(calls.some((args) => args[0] === 'release' && args[1] === 'edit')).toBe(false);
      expect(calls).toContainEqual([
        'api',
        `repos/example/release-sandbox/contents/package.json?ref=${targetCommit}`,
        '--jq',
        '.content | @base64d',
      ]);
    }
  );
});
