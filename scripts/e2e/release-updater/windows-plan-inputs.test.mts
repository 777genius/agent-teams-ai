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
import { planWindowsInputs } from './windows-plan-inputs.mts';

import type { Original, Release, Snapshot, StagePlan } from '../../ci/release/contract.ts';
import type { WindowsProofPin } from './windows-plan-inputs.mts';

// Byte-backed bundle contract only: no GitHub, installer, app, or native proof.
// These tests reject substitutions of release identity, asset identity, bytes,
// or the prepared Windows feed, independently of the eventual native E2E.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-contract-'));
  const source: Release = {
    id: 398386033,
    tag_name: 'v2.17.1',
    target_commitish: '395572f9ff2a261cb28224754883a39d2c3c8827',
    created_at: '2026-09-28T15:27:10Z',
    draft: false,
    prerelease: false,
    name: 'TEST source',
    body: 'TEST notes',
    assets: [],
  };
  const target: Release = {
    id: 499999999,
    tag_name: 'v2.17.6',
    target_commitish: '1'.repeat(40),
    created_at: '2026-10-05T15:27:10Z',
    draft: true,
    prerelease: false,
    name: 'TEST target',
    body: 'TEST notes',
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
  const t = platformNames('2.17.6');
  const mac = [
    ...platformNames('2.17.1').mac,
    ...Object.keys(macAliases('2.17.1')),
    'latest-mac.yml',
  ];
  const originals: Original[] = [];
  const pins: Omit<WindowsProofPin, 'sha512'>[] = [];
  async function add(release: Release, name: string) {
    const bytes = Buffer.from(`synthetic byte fixture: ${name}`);
    const proof = textProof(name, bytes);
    const id = 100 + source.assets.length + target.assets.length;
    release.assets.push({ id, name, size: proof.size, digest: `sha256:${proof.sha256}` });
    await writeFile(path.join(root, name), bytes);
    return { ...proof, assetId: id, releaseId: release.id, tag: release.tag_name };
  }
  for (const [index, installer] of platformNames('2.17.1').windows.entries()) {
    for (const name of [installer, `${installer}.blockmap`]) {
      const proof = await add(source, name);
      pins.push({
        tag: source.tag_name,
        arch: index === 0 ? 'x64' : 'arm64',
        name,
        size: proof.size,
        sha256: proof.sha256,
      });
    }
  }
  for (const name of [...t.windows, ...t.linux, ...t.windows.map((n) => `${n}.blockmap`)])
    originals.push(await add(target, name));
  for (const name of mac) originals.push(await add(source, name));
  const plan: StagePlan = {
    schemaVersion: 1,
    input: {
      repository: '777genius/agent-teams-ai',
      mode: 'carry-mac',
      toolingSha: '2'.repeat(40),
      target: snapshot(target),
      latest: { id: source.id, tag: source.tag_name },
      originals,
      macSource: { release: snapshot(source), productMinimum: '12.0' },
      build: { runId: 10, attempt: 1, jobIds: [11, 12, 13] },
      macProductMinimum: '12.0',
    },
    feeds: {
      'latest.yml': renderFeed(
        '2.17.6',
        originals.filter((entry) => t.windows.includes(entry.name)),
        target.created_at
      ),
    },
    aliases: {},
    outputs: [],
  };
  const preparedFeed = plan.feeds['latest.yml'];
  assert(typeof preparedFeed === 'string');
  for (const [name, bytes] of [
    ['latest.yml', preparedFeed],
    ['release-platform-manifest.json', `${canonical(manifestFor(plan))}\n`],
  ]) {
    assert(name && bytes);
    const proof = textProof(name, bytes);
    target.assets.push({
      id: 100 + source.assets.length + target.assets.length,
      name,
      size: proof.size,
      digest: `sha256:${proof.sha256}`,
    });
    await writeFile(path.join(root, name), bytes);
  }
  const planFile = path.join(root, 'plan.json');
  async function persist() {
    await writeFile(planFile, `${canonical(plan)}\n`);
    await writeFile(path.join(root, 'source-api.json'), JSON.stringify(source));
    await writeFile(path.join(root, 'draft-api.json'), JSON.stringify(target));
  }
  await persist();
  return {
    root,
    planFile,
    plan,
    source,
    target,
    pins,
    persist,
    verify: () => planWindowsInputs(root, planFile, pins),
  };
}

void test('bundle accepts matching actual byte proofs and preserves the prepared feed verbatim', async () => {
  const input = await fixture();
  try {
    const result = await input.verify();
    assert.equal(result.targetVersion, '2.17.6');
    assert.equal(result.legacyFixture, false);
    assert.equal(result.verified.length, 8);
    assert.equal(result.feed, input.plan.feeds['latest.yml']);
    assert.equal(result.inputDigest, digest(canonical(input.plan.input)));
    assert.equal(result.plan?.sha256, digest(`${canonical(input.plan)}\n`));
    assert.equal(result.stagedMetadata?.assets.length, 2);
  } finally {
    await rm(input.root, { recursive: true, force: true });
  }
});

for (const variant of [
  'target-sha',
  'asset-id',
  'asset-bytes',
  'feed-version',
  'source-id',
  'skip-updater',
  'missing-staged-feed',
  'staged-manifest-bytes',
] as const) {
  void test(`bundle rejects ${variant} substitution`, async () => {
    const input = await fixture();
    try {
      const installer = input.target.assets[0];
      assert(installer);
      if (variant === 'target-sha') input.target.target_commitish = '3'.repeat(40);
      if (variant === 'asset-id') installer.id++;
      if (variant === 'asset-bytes')
        await writeFile(path.join(input.root, installer.name), 'changed actual bytes');
      if (variant === 'feed-version') {
        const feed = input.plan.feeds['latest.yml'];
        assert(typeof feed === 'string');
        input.plan.feeds['latest.yml'] = feed.replace('version: 2.17.6', 'version: 2.17.1');
      }
      if (variant === 'source-id') input.source.id++;
      if (variant === 'skip-updater') {
        input.target.body = '[skip-updater]';
        input.plan.input.target.body = input.target.body;
      }
      if (variant === 'missing-staged-feed')
        input.target.assets = input.target.assets.filter((asset) => asset.name !== 'latest.yml');
      if (variant === 'staged-manifest-bytes')
        await writeFile(path.join(input.root, 'release-platform-manifest.json'), '{}');
      await input.persist();
      await assert.rejects(input.verify());
    } finally {
      await rm(input.root, { recursive: true, force: true });
    }
  });
}
