import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildUpdaterFeeds,
  getPromotionLayout,
  parsePromotionConfig,
} from '../../scripts/ci/promote-existing-draft.mjs';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('promote-existing-draft', () => {
  it('defines every stable, legacy, and updater source once', () => {
    const layout = getPromotionLayout('2.9.0');

    expect(layout.sourceAssets).toHaveLength(9);
    expect(Object.keys(layout.stableAliases)).toHaveLength(7);
    expect(Object.keys(layout.legacyStableAliases)).toHaveLength(7);
    expect(Object.keys(layout.legacyUpdaterAliases)).toHaveLength(6);
    expect(layout.sourceAssets).toContain('Agent.Teams.AI-2.9.0-arm64-mac.zip');
    expect(layout.sourceAssets).toContain('Agent.Teams.AI.Setup.2.9.0.exe');
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
    });

    const windowsBytes = Buffer.from(`fixture:${layout.feedSources.windows}`);
    const windowsSha = createHash('sha512').update(windowsBytes).digest('base64');
    expect(feeds['latest.yml']).toContain('version: 2.9.0');
    expect(feeds['latest.yml']).toContain(`sha512: ${windowsSha}`);
    expect(feeds['latest-linux.yml']).toContain(layout.feedSources.linux);
    expect(feeds['latest-mac.yml']).toContain(layout.feedSources.macArm64Zip);
    expect(feeds['latest-mac.yml']).toContain(layout.feedSources.macX64Zip);
  });

  it('runs an isolated end-to-end dry run with verified release assets', async () => {
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
    expect(calls.filter((args) => args[0] === 'release' && args[1] === 'download')).toHaveLength(9);
    expect(calls.some((args) => args[0] === 'release' && args[1] === 'upload')).toBe(false);
    expect(calls.some((args) => args[0] === 'release' && args[1] === 'edit')).toBe(false);
  });
});
