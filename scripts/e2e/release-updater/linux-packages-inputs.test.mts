import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  canonical,
  digest,
  macAliases,
  manifestFor,
  platformNames,
  renderFeed,
  textProof,
} from '../../ci/release/contract.ts';
import { boundLinuxInputs, readLinuxPlan, verifyLinuxFile } from './inputs.mts';
import { packageName } from './linux-packages-inputs.mts';
import { nativeReleaseScenario } from './native-release-scenario.mts';

import type { Original, Release, Snapshot, StagePlan } from '../../ci/release/contract.ts';

async function fixture(targetVersion: '2.17.6' | '2.17.7') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TEST-linux-plan-contract-'));
  const source: Release = {
    id: 398386033,
    tag_name: 'v2.17.1',
    target_commitish: '395572f9ff2a261cb28224754883a39d2c3c8827',
    created_at: '2026-09-28T15:27:10Z',
    draft: false,
    prerelease: false,
    name: 'TEST predecessor',
    body: 'TEST notes',
    assets: [],
  };
  const target: Release = {
    ...source,
    id: 499999999,
    tag_name: `v${targetVersion}`,
    target_commitish: '1'.repeat(40),
    draft: true,
    name: 'TEST target',
    assets: [],
  };
  const snapshot = (release: Release): Snapshot => ({
    id: release.id,
    tag: release.tag_name,
    applicationSha: release.target_commitish,
    createdAt: release.created_at,
    name: release.name,
    body: release.body,
  });
  const full = targetVersion === '2.17.7';
  const names = platformNames(targetVersion);
  const originals: Original[] = [];
  async function add(release: Release, name: string) {
    const proof = textProof(name, Buffer.from(`independent Linux byte fixture ${name}`));
    const id = 100 + originals.length;
    release.assets.push({ id, name, size: proof.size, digest: `sha256:${proof.sha256}` });
    await writeFile(path.join(directory, name), `independent Linux byte fixture ${name}`);
    originals.push({ ...proof, assetId: id, releaseId: release.id, tag: release.tag_name });
  }
  for (const name of [
    ...names.windows,
    ...names.linux,
    ...names.windows.map((n) => `${n}.blockmap`),
  ])
    await add(target, name);
  const oldMac = [
    ...platformNames('2.17.1').mac,
    ...Object.keys(macAliases('2.17.1')),
    'latest-mac.yml',
  ];
  for (const name of full ? names.mac : oldMac) await add(full ? target : source, name);
  const plan: StagePlan = {
    schemaVersion: 1,
    input: {
      repository: '777genius/agent-teams-ai',
      mode: full ? 'full' : 'carry-mac',
      toolingSha: '2'.repeat(40),
      target: snapshot(target),
      latest: full ? { id: 488888888, tag: 'v2.17.6' } : { id: source.id, tag: source.tag_name },
      originals,
      macSource: full ? null : { release: snapshot(source), productMinimum: '12.0' },
      macProductMinimum: full ? '13.0' : '12.0',
      build: { runId: 10, attempt: 1, jobIds: [11, 12, 13, 14, 15] },
    },
    feeds: {
      'latest-linux.yml': renderFeed(
        targetVersion,
        originals.filter((p) => names.linux.includes(p.name)),
        target.created_at
      ),
    },
    aliases: {},
    outputs: originals.map((p) => ({
      name: p.name,
      size: p.size,
      sha256: p.sha256,
      sha512: p.sha512,
    })),
  };
  for (const [name, bytes] of [
    ['latest-linux.yml', plan.feeds['latest-linux.yml']],
    ['release-platform-manifest.json', `${canonical(manifestFor(plan))}\n`],
  ]) {
    assert(name && bytes);
    const proof = textProof(name, bytes);
    target.assets.push({
      id: 300 + target.assets.length,
      name,
      size: proof.size,
      digest: `sha256:${proof.sha256}`,
    });
    await writeFile(path.join(directory, name), bytes);
  }
  async function persist() {
    const bytes = `${canonical(plan)}\n`;
    await writeFile(path.join(directory, 'stage-plan.json'), bytes);
    await writeFile(path.join(directory, 'source-api.json'), JSON.stringify(source));
    await writeFile(path.join(directory, 'draft-api.json'), JSON.stringify(target));
    return { directory, planSha256: digest(bytes) };
  }
  return { directory, plan, source, target, persist, stage: await persist() };
}

for (const targetVersion of ['2.17.6', '2.17.7'] as const) {
  void test(`Linux native ${targetVersion} binds raw metadata, actual bytes and independent 211`, async () => {
    const input = await fixture(targetVersion);
    try {
      const result = await boundLinuxInputs(input.directory, input.stage);
      assert.equal(result.targetVersion, targetVersion);
      assert.equal(result.source.tag_name, 'v2.17.1');
      assert.equal(result.assets.length, 4);
      for (const [index, suffix] of [
        '.AppImage',
        '_amd64.deb',
        '.x86_64.rpm',
        '.pacman',
      ].entries()) {
        const asset = result.assets[index];
        assert(asset);
        assert(asset.name.includes(targetVersion) && asset.name.endsWith(suffix));
        assert.equal(
          (await verifyLinuxFile(input.directory, asset.name, asset, result.target, asset.assetId))
            .tag,
          `v${targetVersion}`
        );
      }
      assert.equal(result.binding.planSha256, input.stage.planSha256);
      assert.equal(result.feed, input.plan.feeds['latest-linux.yml']);
      assert.equal(packageName('deb', targetVersion), `agent-teams-ai_${targetVersion}_amd64.deb`);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  });
}

for (const variant of [
  'external-hash',
  'raw-manifest',
  'raw-feed',
  'asset-id',
  'asset-bytes',
  'source-sha',
  'original-output',
] as const) {
  void test(`full217 Linux rejects ${variant} substitution`, async () => {
    const input = await fixture('2.17.7');
    try {
      const asset = input.target.assets.find((p) => p.name.endsWith('.AppImage'));
      assert(asset);
      if (variant === 'external-hash') input.stage.planSha256 = '0'.repeat(64);
      if (variant === 'raw-manifest')
        await writeFile(path.join(input.directory, 'release-platform-manifest.json'), '{}');
      if (variant === 'raw-feed')
        await writeFile(path.join(input.directory, 'latest-linux.yml'), 'version: 2.17.6\n');
      if (variant === 'asset-id') asset.id++;
      if (variant === 'asset-bytes')
        await writeFile(path.join(input.directory, asset.name), 'changed installed input');
      if (variant === 'source-sha') input.source.target_commitish = '3'.repeat(40);
      if (variant === 'original-output') {
        const output = input.plan.outputs.find((p) => p.name === asset.name);
        assert(output);
        output.sha256 = '0'.repeat(64);
      }
      const stage = await input.persist();
      await assert.rejects(async () => {
        const result = await boundLinuxInputs(
          input.directory,
          variant === 'external-hash' ? input.stage : stage
        );
        const original = result.assets[0];
        assert(original);
        await verifyLinuxFile(
          input.directory,
          original.name,
          original,
          result.target,
          original.assetId
        );
      });
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  });
}

for (const variant of [
  'carry217',
  'full216',
  'floor12',
  'missing-mac',
  'wrong-latest',
  'unreviewed-version',
] as const) {
  void test(`shared native scenario rejects ${variant}`, async () => {
    const input = await fixture('2.17.7');
    try {
      if (variant === 'carry217') input.plan.input.mode = 'carry-mac';
      if (variant === 'full216' || variant === 'unreviewed-version') {
        const targetTag = variant === 'full216' ? 'v2.17.6' : 'v2.17.8';
        input.plan.input.target.tag = targetTag;
        for (const original of input.plan.input.originals) {
          original.tag = targetTag;
          original.name = original.name.replace('2.17.7', targetTag.slice(1));
        }
      }
      if (variant === 'floor12') input.plan.input.macProductMinimum = '12.0';
      if (variant === 'missing-mac')
        input.plan.input.originals = input.plan.input.originals.filter(
          (p) => !p.name.endsWith('.dmg')
        );
      if (variant === 'wrong-latest') input.plan.input.latest.tag = 'v2.17.1';
      assert.throws(() => nativeReleaseScenario(input.plan));
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  });
}

void test('external plan hash rejects changed target version before downloading assets', async () => {
  const input = await fixture('2.17.7');
  try {
    input.plan.input.target.tag = 'v2.17.6';
    await input.persist();
    await assert.rejects(readLinuxPlan(input.stage), /Immutable staged plan digest/);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
