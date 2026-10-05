import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assetByName,
  canonical,
  checkInput,
  checkMetadata,
  checkRelease,
  digest,
  manifestFor,
  platformNames,
  sameProof,
  textProof,
  validateFeed,
  version,
} from '../../ci/release/contract.ts';
import { hashFile } from './inputs.mts';

import type { Release, StageInput, StagePlan } from '../../ci/release/contract.ts';

// Exact original 2.17.1 bytes independently downloaded and hashed on 2026-10-04.
export const windowsPredecessorPins = [
  {
    tag: 'v2.17.1',
    arch: 'x64',
    name: 'Agent.Teams.AI.Setup.2.17.1.exe',
    size: 206705165,
    sha256: 'd6cc899235bfcab17c9bb30b3f0959ea8ea2549c6416161bc6f5a96f35b5a463',
  },
  {
    tag: 'v2.17.1',
    arch: 'x64',
    name: 'Agent.Teams.AI.Setup.2.17.1.exe.blockmap',
    size: 215243,
    sha256: '9ba29ce8df953d3b253ea5284384f422cf21e62dfb365e1a3e517dfe9d1cc69a',
  },
  {
    tag: 'v2.17.1',
    arch: 'arm64',
    name: 'Agent.Teams.AI.Setup.2.17.1-arm64.exe',
    size: 196906862,
    sha256: 'd7bbfe282cba0467f389b24ca3f0cc0404efbbd21c0ce0d09a0e0080c9abfc43',
  },
  {
    tag: 'v2.17.1',
    arch: 'arm64',
    name: 'Agent.Teams.AI.Setup.2.17.1-arm64.exe.blockmap',
    size: 205207,
    sha256: '75b498d86b77fcceea7a2825d3282758d00cd1a654cb4ffa0cd44b27ae1ef218',
  },
] as const;

export interface WindowsProofPin {
  tag: string;
  arch: 'x64' | 'arm64';
  name: string;
  size: number;
  sha256: string;
  sha512: string;
  assetId?: number;
  releaseId?: number;
}
export interface WindowsInputSet {
  source: Release;
  target: Release;
  verified: WindowsProofPin[];
  feed: string;
  inputDigest: string;
  targetVersion: string;
  legacyFixture: boolean;
  stagedMetadata?: {
    releaseId: number;
    assets: { name: string; assetId: number; sha256: string; sha512: string; size: number }[];
  };
  plan?: {
    input: StageInput;
    sha256: string;
    filename: string;
  };
}

export async function readWindowsStagePlan(planFile: string): Promise<StagePlan> {
  const plan = JSON.parse(await readFile(planFile, 'utf8')) as StagePlan;
  assert.equal(plan.schemaVersion, 1);
  checkInput(plan.input);
  assert.equal(plan.input.repository, '777genius/agent-teams-ai');
  assert.equal(plan.input.mode, 'carry-mac');
  assert.equal(
    plan.input.target.tag,
    'v2.17.3',
    'Only the owner-selected new target is final-release evidence'
  );
  assert.equal(plan.input.latest.tag, 'v2.17.1');
  assert.equal(plan.input.latest.id, 398386033);
  assert.equal(plan.input.macSource?.release.id, 398386033);
  assert.equal(plan.input.macSource?.release.tag, 'v2.17.1');
  assert.equal(
    plan.input.macSource?.release.applicationSha,
    '395572f9ff2a261cb28224754883a39d2c3c8827'
  );
  return plan;
}

export async function planWindowsInputs(
  directory: string,
  planFile: string,
  predecessorPins: readonly Omit<WindowsProofPin, 'sha512'>[] = windowsPredecessorPins
): Promise<WindowsInputSet> {
  const plan = await readWindowsStagePlan(planFile);
  const source = JSON.parse(
    await readFile(path.join(directory, 'source-api.json'), 'utf8')
  ) as Release;
  const target = JSON.parse(
    await readFile(path.join(directory, 'draft-api.json'), 'utf8')
  ) as Release;
  assert(plan.input.macSource);
  checkRelease(source, plan.input.macSource.release, false);
  checkRelease(target, plan.input.target, true);
  assert.equal(source.id, 398386033);
  const verified: WindowsProofPin[] = [];
  for (const pin of predecessorPins) {
    assert.equal(pin.tag, 'v2.17.1');
    const actual = await hashFile(path.join(directory, pin.name));
    assert.equal(actual.size, pin.size);
    assert.equal(actual.sha256, pin.sha256);
    checkMetadata(assetByName(source, pin.name), { name: pin.name, ...actual });
    verified.push({ ...pin, sha512: actual.sha512 });
  }
  const targetVersion = version(plan.input.target.tag);
  for (const [index, name] of platformNames(targetVersion).windows.entries()) {
    for (const assetName of [name, `${name}.blockmap`]) {
      const original = plan.input.originals.find((entry) => entry.name === assetName);
      assert(original?.tag === target.tag_name && original.releaseId === target.id);
      const asset = assetByName(target, assetName);
      checkMetadata(asset, original, original.assetId);
      const actual = await hashFile(path.join(directory, assetName));
      assert.equal(actual.size, original.size);
      assert.equal(actual.sha256, original.sha256);
      assert.equal(actual.sha512, original.sha512);
      verified.push({
        tag: target.tag_name,
        arch: index === 0 ? 'x64' : 'arm64',
        name: assetName,
        ...actual,
        assetId: asset.id,
        releaseId: target.id,
      });
    }
  }
  const preparedFeed = plan.feeds['latest.yml'];
  assert(typeof preparedFeed === 'string');
  const feed = await readFile(path.join(directory, 'latest.yml'), 'utf8');
  assert.equal(feed, preparedFeed, 'Actual staged Windows feed differs from the prepared plan');
  const installerProofs = verified.filter(
    (pin) => pin.tag === target.tag_name && pin.name.endsWith('.exe')
  );
  validateFeed(feed, targetVersion, installerProofs);
  const stagedMetadata = [];
  for (const expected of [
    textProof('latest.yml', feed),
    textProof('release-platform-manifest.json', `${canonical(manifestFor(plan))}\n`),
  ]) {
    const asset = assetByName(target, expected.name);
    checkMetadata(asset, expected);
    const actual = {
      name: expected.name,
      ...(await hashFile(path.join(directory, expected.name))),
    };
    sameProof(actual, expected);
    stagedMetadata.push({ ...actual, assetId: asset.id });
  }
  return {
    source,
    target,
    verified,
    feed,
    targetVersion,
    inputDigest: digest(canonical(plan.input)),
    legacyFixture: false,
    stagedMetadata: { releaseId: target.id, assets: stagedMetadata },
    plan: {
      input: plan.input,
      sha256: (await hashFile(planFile)).sha256,
      filename: path.resolve(planFile),
    },
  };
}
