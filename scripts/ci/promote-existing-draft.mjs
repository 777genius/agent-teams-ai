#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

const UPDATER_SKIP_MARKER = /\[(skip-updater|test-release|internal-release|no-autoupdate)\]/i;
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:[-.][A-Za-z0-9.-]+)?$/;

export function getPromotionLayout(version) {
  const stableAliases = {
    'Agent.Teams.AI-arm64.dmg': `Agent.Teams.AI-${version}-arm64.dmg`,
    'Agent.Teams.AI-x64.dmg': `Agent.Teams.AI-${version}-x64.dmg`,
    'Agent.Teams.AI.Setup.exe': `Agent.Teams.AI.Setup.${version}.exe`,
    'Agent.Teams.AI.AppImage': `Agent.Teams.AI-${version}.AppImage`,
    'agent-teams-ai-amd64.deb': `agent-teams-ai_${version}_amd64.deb`,
    'agent-teams-ai-x86_64.rpm': `agent-teams-ai-${version}.x86_64.rpm`,
    'agent-teams-ai.pacman': `agent-teams-ai-${version}.pacman`,
  };
  const legacyStableAliases = {
    'Claude-Agent-Teams-UI-arm64.dmg': stableAliases['Agent.Teams.AI-arm64.dmg'],
    'Claude-Agent-Teams-UI-x64.dmg': stableAliases['Agent.Teams.AI-x64.dmg'],
    'Claude-Agent-Teams-UI-Setup.exe': stableAliases['Agent.Teams.AI.Setup.exe'],
    'Claude-Agent-Teams-UI.AppImage': stableAliases['Agent.Teams.AI.AppImage'],
    'Claude-Agent-Teams-UI-amd64.deb': stableAliases['agent-teams-ai-amd64.deb'],
    'Claude-Agent-Teams-UI-x86_64.rpm': stableAliases['agent-teams-ai-x86_64.rpm'],
    'Claude-Agent-Teams-UI.pacman': stableAliases['agent-teams-ai.pacman'],
  };
  const legacyUpdaterAliases = {
    [`Claude.Agent.Teams.UI-${version}-arm64-mac.zip`]: `Agent.Teams.AI-${version}-arm64-mac.zip`,
    [`Claude.Agent.Teams.UI-${version}-arm64.dmg`]: `Agent.Teams.AI-${version}-arm64.dmg`,
    [`Claude.Agent.Teams.UI-${version}-mac.zip`]: `Agent.Teams.AI-${version}-x64-mac.zip`,
    [`Claude.Agent.Teams.UI-${version}.dmg`]: `Agent.Teams.AI-${version}-x64.dmg`,
    [`Claude.Agent.Teams.UI.Setup.${version}.exe`]: `Agent.Teams.AI.Setup.${version}.exe`,
    [`Claude.Agent.Teams.UI-${version}.AppImage`]: `Agent.Teams.AI-${version}.AppImage`,
  };
  const feedSources = {
    windows: `Agent.Teams.AI.Setup.${version}.exe`,
    linux: `Agent.Teams.AI-${version}.AppImage`,
    macArm64Zip: `Agent.Teams.AI-${version}-arm64-mac.zip`,
    macArm64Dmg: `Agent.Teams.AI-${version}-arm64.dmg`,
    macX64Zip: `Agent.Teams.AI-${version}-x64-mac.zip`,
    macX64Dmg: `Agent.Teams.AI-${version}-x64.dmg`,
  };
  const sourceAssets = [
    ...new Set([
      ...Object.values(stableAliases),
      ...Object.values(legacyStableAliases),
      ...Object.values(legacyUpdaterAliases),
      ...Object.values(feedSources),
    ]),
  ].sort();

  return {
    stableAliases,
    legacyStableAliases,
    legacyUpdaterAliases,
    feedSources,
    sourceAssets,
  };
}

function parseBoolean(value, name, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function parsePromotionConfig(environment = process.env) {
  const repository = environment.RELEASE_REPOSITORY || environment.GITHUB_REPOSITORY || '';
  const tag = environment.RELEASE_TAG || '';
  const match = tag.match(SEMVER_TAG);

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('RELEASE_REPOSITORY or GITHUB_REPOSITORY must be owner/repository');
  }
  if (!match) {
    throw new Error(`RELEASE_TAG must be a semantic version tag, got '${tag || '<empty>'}'`);
  }

  const dryRun = parseBoolean(environment.PROMOTE_DRY_RUN, 'PROMOTE_DRY_RUN', false);
  const publishRelease = parseBoolean(environment.PUBLISH_RELEASE, 'PUBLISH_RELEASE', false);
  const allowPublishedRecovery = parseBoolean(
    environment.ALLOW_PUBLISHED_RELEASE_RECOVERY,
    'ALLOW_PUBLISHED_RELEASE_RECOVERY',
    false
  );
  if (dryRun && publishRelease) {
    throw new Error('PROMOTE_DRY_RUN=true cannot be combined with PUBLISH_RELEASE=true');
  }

  return {
    repository,
    tag,
    version: tag.slice(1),
    dryRun,
    publishRelease,
    allowPublishedRecovery,
    outputDirectory: environment.PROMOTION_OUTPUT_DIR
      ? path.resolve(environment.PROMOTION_OUTPUT_DIR)
      : null,
  };
}

function runCommand(command, args, { capture = false, environment = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}${details ? `: ${details}` : ''}`
    );
  }
  return capture ? result.stdout : '';
}

function runGh(args, options) {
  return runCommand('gh', args, options);
}

async function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest(encoding);
}

async function describeUpdaterAsset(directory, name) {
  const filePath = path.join(directory, name);
  const [fileStats, sha512] = await Promise.all([
    stat(filePath),
    hashFile(filePath, 'sha512', 'base64'),
  ]);
  return { name, size: fileStats.size, sha512 };
}

export async function buildUpdaterFeeds({ directory, version, releaseDate, feedSources }) {
  const [windows, linux, macArm64Zip, macArm64Dmg, macX64Zip, macX64Dmg] = await Promise.all([
    describeUpdaterAsset(directory, feedSources.windows),
    describeUpdaterAsset(directory, feedSources.linux),
    describeUpdaterAsset(directory, feedSources.macArm64Zip),
    describeUpdaterAsset(directory, feedSources.macArm64Dmg),
    describeUpdaterAsset(directory, feedSources.macX64Zip),
    describeUpdaterAsset(directory, feedSources.macX64Dmg),
  ]);

  const latest = `version: ${version}
files:
  - url: ${windows.name}
    sha512: ${windows.sha512}
    size: ${windows.size}
path: ${windows.name}
sha512: ${windows.sha512}
releaseDate: '${releaseDate}'
`;
  const latestLinux = `version: ${version}
files:
  - url: ${linux.name}
    sha512: ${linux.sha512}
    size: ${linux.size}
path: ${linux.name}
sha512: ${linux.sha512}
releaseDate: '${releaseDate}'
`;
  const macFiles = [macArm64Zip, macArm64Dmg, macX64Zip, macX64Dmg];
  const latestMac = `version: ${version}
files:
${macFiles
  .map(
    (asset) => `  - url: ${asset.name}
    sha512: ${asset.sha512}
    size: ${asset.size}`
  )
  .join('\n')}
path: ${macArm64Zip.name}
sha512: ${macArm64Zip.sha512}
releaseDate: '${releaseDate}'
`;

  return {
    'latest.yml': latest,
    'latest-linux.yml': latestLinux,
    'latest-mac.yml': latestMac,
  };
}

async function linkOrCopy(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') {
      throw error;
    }
    await copyFile(source, destination);
  }
}

async function uploadWithRetry({ repository, tag, filePath, environment }) {
  const args = ['release', 'upload', tag, filePath, '--repo', repository, '--clobber'];
  try {
    runGh(args, { environment });
  } catch (firstError) {
    process.stderr.write(`Retrying upload for ${path.basename(filePath)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      runGh(args, { environment });
    } catch (secondError) {
      secondError.cause = firstError;
      throw secondError;
    }
  }
}

function validateRelease(release, config) {
  if (release.tagName !== config.tag) {
    throw new Error(`Release tag is ${release.tagName}, expected ${config.tag}`);
  }
  if (!release.isDraft && !config.allowPublishedRecovery) {
    throw new Error(`${config.tag} is not a draft`);
  }
  if (release.isPrerelease) {
    throw new Error(`${config.tag} is a prerelease`);
  }
  if (UPDATER_SKIP_MARKER.test(`${release.name || ''}\n${release.body || ''}`)) {
    throw new Error(`${config.tag} contains an updater skip marker`);
  }
}

export async function promoteExistingDraft({
  environment = process.env,
  now = () => new Date(),
} = {}) {
  const config = parsePromotionConfig(environment);
  const layout = getPromotionLayout(config.version);
  const release = JSON.parse(
    runGh(
      [
        'release',
        'view',
        config.tag,
        '--repo',
        config.repository,
        '--json',
        'body,assets,isDraft,isPrerelease,targetCommitish,name,tagName',
      ],
      { capture: true, environment }
    )
  );
  validateRelease(release, config);

  const resolvedTagCommit = runGh(
    ['api', `repos/${config.repository}/commits/${config.tag}`, '--jq', '.sha'],
    { capture: true, environment }
  ).trim();
  if (release.targetCommitish !== resolvedTagCommit) {
    throw new Error(
      `${config.tag} draft targets ${release.targetCommitish}, but the tag resolves to ${resolvedTagCommit}`
    );
  }

  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const sourceName of layout.sourceAssets) {
    const asset = assetsByName.get(sourceName);
    if (!asset) {
      throw new Error(`Missing source release asset ${sourceName}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) {
      throw new Error(`Missing SHA-256 digest for source release asset ${sourceName}`);
    }
  }

  const ownsOutputDirectory = !config.outputDirectory;
  const outputDirectory =
    config.outputDirectory ||
    (await mkdtemp(path.join(tmpdir(), 'agent-teams-release-promotion-')));
  await mkdir(outputDirectory, { recursive: true });

  try {
    for (const sourceName of layout.sourceAssets) {
      process.stdout.write(`Downloading and verifying ${sourceName}\n`);
      runGh(
        [
          'release',
          'download',
          config.tag,
          '--repo',
          config.repository,
          '--pattern',
          sourceName,
          '--dir',
          outputDirectory,
          '--clobber',
        ],
        { environment }
      );
      const expectedDigest = assetsByName.get(sourceName).digest.slice('sha256:'.length);
      const actualDigest = await hashFile(path.join(outputDirectory, sourceName), 'sha256', 'hex');
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `SHA-256 mismatch for ${sourceName}: expected ${expectedDigest}, got ${actualDigest}`
        );
      }
    }

    const aliasGroups = [
      ['stable', layout.stableAliases],
      ['legacy stable', layout.legacyStableAliases],
      ['legacy updater', layout.legacyUpdaterAliases],
    ];
    const aliasPaths = [];
    for (const [label, aliases] of aliasGroups) {
      for (const [aliasName, sourceName] of Object.entries(aliases)) {
        process.stdout.write(`Preparing ${label} alias: ${aliasName} -> ${sourceName}\n`);
        const aliasPath = path.join(outputDirectory, aliasName);
        await rm(aliasPath, { force: true });
        await linkOrCopy(path.join(outputDirectory, sourceName), aliasPath);
        aliasPaths.push(aliasPath);
      }
    }

    const feeds = await buildUpdaterFeeds({
      directory: outputDirectory,
      version: config.version,
      releaseDate: now().toISOString(),
      feedSources: layout.feedSources,
    });
    const feedPaths = [];
    for (const [name, contents] of Object.entries(feeds)) {
      const feedPath = path.join(outputDirectory, name);
      await writeFile(feedPath, contents);
      feedPaths.push(feedPath);
    }

    if (!config.dryRun) {
      for (const filePath of aliasPaths) {
        await uploadWithRetry({
          repository: config.repository,
          tag: config.tag,
          filePath,
          environment,
        });
      }
      for (const filePath of feedPaths) {
        await uploadWithRetry({
          repository: config.repository,
          tag: config.tag,
          filePath,
          environment,
        });
      }
    }

    if (config.publishRelease) {
      runGh(
        ['release', 'edit', config.tag, '--repo', config.repository, '--draft=false', '--latest'],
        { environment }
      );
      runCommand('bash', ['scripts/ci/verify-published-updater-release.sh'], {
        environment: {
          ...environment,
          RELEASE_REPOSITORY: config.repository,
          RELEASE_TAG: config.tag,
          REDRAFT_INCOMPLETE_RELEASE: 'true',
        },
      });
    }

    const result = {
      repository: config.repository,
      tag: config.tag,
      targetCommit: resolvedTagCommit,
      sourceAssets: layout.sourceAssets.length,
      aliases: aliasPaths.length,
      feeds: feedPaths.map((feedPath) => path.basename(feedPath)),
      dryRun: config.dryRun,
      published: config.publishRelease,
      outputDirectory: config.outputDirectory ? outputDirectory : undefined,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (ownsOutputDirectory) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPointUrl === import.meta.url) {
  promoteExistingDraft().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
