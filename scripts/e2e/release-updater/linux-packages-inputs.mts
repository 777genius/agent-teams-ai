import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';

import { canonical, checkRelease, digest } from '../../ci/release/contract.ts';
import {
  applicationSha,
  boundLinuxInputs,
  hashFile,
  linuxFeedAssets,
  stageArguments,
  verifyLinuxFile,
} from './inputs.mts';

import type { Release } from '../../ci/release/contract.ts';
import type { StageReference } from './inputs.mts';

export type PackageKind = 'deb' | 'rpm' | 'pacman';
export const packageCases = {
  deb: {
    updater: 'DebUpdater',
    old: 'agent-teams-ai_2.17.1_amd64.deb',
    target: 'agent-teams-ai_2.17.2_amd64.deb',
    size: 193985224,
    sha256: 'd2daf11bc93fde813d1df2fef25bfc5d6beebd419f7d47b8082d8da9e0ccf6ec',
  },
  rpm: {
    updater: 'RpmUpdater',
    old: 'agent-teams-ai-2.17.1.x86_64.rpm',
    target: 'agent-teams-ai-2.17.2.x86_64.rpm',
    size: 162558461,
    sha256: '1945bc52e0ca212e9565c0593b1eb60701cb4d30087f6eb272cbe8edaa5c62b0',
  },
  pacman: {
    updater: 'PacmanUpdater',
    old: 'agent-teams-ai-2.17.1.pacman',
    target: 'agent-teams-ai-2.17.2.pacman',
    size: 170698056,
    sha256: '8fce9a2885784244ea33919d133f541c884add63d96455ab74f8575c911b5627',
  },
} as const;
const targetPins = [
  {
    name: 'Agent.Teams.AI-2.17.2.AppImage',
    sha256: '21ee04fac11e8436cc3a6fee9c3691435ce0a19abc367e0db8336ad2698efbb9',
  },
  {
    name: 'agent-teams-ai_2.17.2_amd64.deb',
    sha256: '42631946cc926151f58efd664377de78567fc14b996593f5c39c0878871df3e9',
  },
  {
    name: 'agent-teams-ai-2.17.2.x86_64.rpm',
    sha256: '4c7abee045d35fdd85e2597d7c08060dce5cfa7796200e8ba053f51813e71067',
  },
  {
    name: 'agent-teams-ai-2.17.2.pacman',
    sha256: '154ecf00647706326941fbad66fdd779838a280593af648e3661f31c803a96bd',
  },
] as const;
export function packageKind(value: unknown): PackageKind {
  assert(
    value === 'deb' || value === 'rpm' || value === 'pacman',
    'Exact native package kind required'
  );
  return value;
}
export function packageName(kind: PackageKind, version: string) {
  assert(
    ['2.17.1', '2.17.2', '2.17.6', '2.17.8'].includes(version),
    'Only exact release scenarios supported'
  );
  return {
    deb: `agent-teams-ai_${version}_amd64.deb`,
    rpm: `agent-teams-ai-${version}.x86_64.rpm`,
    pacman: `agent-teams-ai-${version}.pacman`,
  }[kind];
}
export async function packageInputs(
  directory: string,
  stage?: StageReference,
  historicalPreview = false
) {
  if (stage) {
    const prepared = await boundLinuxInputs(directory, stage);
    const verified = [];
    for (const expected of prepared.assets)
      verified.push(
        await verifyLinuxFile(directory, expected.name, expected, prepared.target, expected.assetId)
      );
    for (const pin of Object.values(packageCases)) {
      const actual = await hashFile(path.join(directory, pin.old));
      assert.equal(actual.sha256, pin.sha256, 'Independent immutable predecessor package');
      assert.equal(actual.size, pin.size);
      const matches = prepared.source.assets.filter((item) => item.name === pin.old);
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.digest, `sha256:${pin.sha256}`);
      assert.equal(matches[0]?.size, pin.size);
      verified.push({ file: pin.old, name: pin.old, tag: 'v2.17.1', ...actual });
    }
    return {
      source: prepared.source,
      target: prepared.target,
      verified,
      feed: prepared.feed,
      binding: prepared.binding,
      targetVersion: prepared.targetVersion,
      targetTag: prepared.targetTag,
      feedAssets: prepared.assets,
    };
  }
  assert(
    historicalPreview,
    '2.17.6/2.17.8 native packages require authenticated stage; historical 2.17.2 must be explicit'
  );
  const source = JSON.parse(
    await readFile(path.join(directory, 'source-api.json'), 'utf8')
  ) as Release;
  const target = JSON.parse(
    await readFile(path.join(directory, 'draft-api.json'), 'utf8')
  ) as Release;
  checkRelease(source, undefined, false);
  checkRelease(target, undefined, true);
  assert.equal(source.target_commitish, '395572f9ff2a261cb28224754883a39d2c3c8827');
  assert.equal(source.id, 398386033);
  assert.equal(source.tag_name, 'v2.17.1');
  assert.equal(source.draft, false);
  assert.equal(source.prerelease, false);
  assert.equal(target.id, 401358336);
  assert.equal(target.tag_name, 'v2.17.2');
  assert.equal(target.target_commitish, applicationSha);
  assert.equal(target.draft, true);
  assert.equal(target.prerelease, false);
  const verified = [];
  for (const pin of targetPins) {
    const expected = linuxFeedAssets.find((item) => item.name === pin.name);
    assert(expected);
    const actual = await hashFile(path.join(directory, pin.name));
    assert.equal(actual.sha256, pin.sha256, pin.name);
    assert.equal(actual.sha512, expected.sha512, pin.name);
    assert.equal(actual.size, expected.size, pin.name);
    const api = target.assets.filter((item) => item.name === pin.name);
    assert.equal(api.length, 1);
    assert.equal(api[0]?.digest, `sha256:${pin.sha256}`);
    assert.equal(api[0]?.size, actual.size);
    verified.push({ tag: 'v2.17.2', name: pin.name, ...actual });
  }
  for (const pin of Object.values(packageCases)) {
    const actual = await hashFile(path.join(directory, pin.old));
    assert.equal(actual.sha256, pin.sha256, pin.old);
    assert.equal(actual.size, pin.size, pin.old);
    const api = source.assets.filter((item) => item.name === pin.old);
    assert.equal(api.length, 1);
    assert.equal(api[0]?.digest, `sha256:${pin.sha256}`);
    assert.equal(api[0]?.size, pin.size);
    verified.push({ tag: 'v2.17.1', name: pin.old, ...actual });
  }
  const first = linuxFeedAssets[0];
  assert(first);
  const feed = stringify({
    version: '2.17.2',
    files: linuxFeedAssets.map((item) => ({
      url: item.name,
      sha512: item.sha512,
      size: item.size,
    })),
    path: first.name,
    sha512: first.sha512,
    releaseDate: target.created_at,
  });
  const binding: {
    manifestBound: boolean;
    inputDigest: string;
    planSha256?: string;
    manifestSha256?: string;
  } = { manifestBound: false, inputDigest: digest(canonical({ source, target, verified })) };
  return {
    source,
    target,
    verified,
    feed,
    binding,
    targetVersion: '2.17.2',
    targetTag: target.tag_name,
    feedAssets: linuxFeedAssets,
  };
}

if (process.argv.includes('--verify-inputs')) {
  const index = process.argv.indexOf('--verify-inputs');
  const directory = process.argv[index + 1];
  assert(directory);
  const result = await packageInputs(
    directory,
    stageArguments(process.argv),
    process.argv.includes('--historical-preview')
  );
  if (!process.argv.includes('--readonly'))
    await writeFile(
      path.join(directory, 'linux-package-input-verification.json'),
      JSON.stringify({ verified: result.verified, binding: result.binding }, null, 2)
    );
}
if (process.argv.includes('--name')) {
  const index = process.argv.indexOf('--name');
  const kind = packageKind(process.argv[index + 1]);
  const version = process.argv[index + 2];
  assert(version);
  process.stdout.write(`${packageName(kind, version)}\n`);
}
if (process.argv.includes('--seccomp')) {
  const index = process.argv.indexOf('--seccomp');
  const source = process.argv[index + 1];
  const output = process.argv[index + 2];
  assert(source && output);
  const profile = JSON.parse(await readFile(source, 'utf8')) as {
    defaultAction: string;
    syscalls: { names: string[]; action: string }[];
  };
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert(Array.isArray(profile.syscalls));
  // Preserve Docker's complete default profile, including clone3 ENOSYS and
  // mount/privileged operation restrictions. Only Chromium's namespace calls
  // are added; kernel capabilities and AppArmor remain unchanged.
  profile.syscalls.push({ names: ['clone', 'unshare', 'setns'], action: 'SCMP_ACT_ALLOW' });
  await writeFile(output, `${JSON.stringify(profile, null, 2)}\n`);
}

if (process.argv.includes('--security')) {
  const index = process.argv.indexOf('--security');
  const directory = process.argv[index + 1];
  const base = process.argv[index + 2];
  const kind = packageKind(process.argv[index + 3]);
  const toolingSha = process.argv[index + 4];
  assert(directory && base && toolingSha && /^[a-f0-9]{40}$/.test(toolingSha));
  const defaultProfile = await readFile(path.join(directory, 'docker-default.json'));
  const profile = await readFile(path.join(directory, 'chromium-namespaces.json'));
  await writeFile(
    path.join(directory, 'security.json'),
    JSON.stringify(
      {
        kind,
        base,
        toolingSha,
        imageId: (await readFile(path.join(directory, 'image.id'), 'utf8')).trim(),
        seccompSource: 'moby/profiles@2ceae35d351c156cb5a8efc0fdc4a08cf94569d8',
        defaultProfileSha256: digest(defaultProfile),
        profileSha256: digest(profile),
        addedSyscalls: ['clone', 'unshare', 'setns'],
        extraCapabilities: [],
        privileged: false,
        network: 'none',
        apparmor: 'Docker default',
      },
      null,
      2
    )
  );
}
