import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Release } from '../../ci/release/contract.ts';
import {
  published219Pair,
  verifyPublished219Pair,
  verifyPublishedAssetBytes,
} from './published-release-pair.mts';

function release(
  identity: { id: number; tag: string; applicationSha: string },
  pins: readonly { id: number; name: string; size: number; sha256: string }[],
  overrides: Partial<Release> = {}
): Release {
  return {
    id: identity.id,
    tag_name: identity.tag,
    target_commitish: identity.applicationSha,
    created_at: '2026-11-25T11:54:51Z',
    draft: false,
    prerelease: false,
    name: identity.tag,
    body: 'Published release fixture',
    assets: pins.map((pin) => ({
      id: pin.id,
      name: pin.name,
      size: pin.size,
      digest: 'sha256:' + pin.sha256,
    })),
    ...overrides,
  };
}

function validPair() {
  const predecessor = release(published219Pair.predecessor, published219Pair.predecessorAssets);
  const target = release(published219Pair.target, published219Pair.targetAssets);
  return { predecessor, target, latest: target };
}

test('authenticates the exact public v2.18.7 to v2.19.0 pair and all installer, blockmap, and feed assets', () => {
  const { predecessor, target, latest } = validPair();
  const evidence = verifyPublished219Pair(
    predecessor,
    target,
    latest,
    published219Pair.predecessor.applicationSha,
    published219Pair.target.applicationSha
  );
  assert.equal(evidence.predecessorAssetCount, 19);
  assert.equal(evidence.targetAssetCount, 19);
  assert.equal(evidence.predecessor.tag, 'v2.18.7');
  assert.equal(evidence.target.tag, 'v2.19.0');
});

test('rejects a different predecessor, target, or tag commit', () => {
  const valid = validPair();
  assert.throws(() =>
    verifyPublished219Pair(
      { ...valid.predecessor, id: valid.predecessor.id + 1 },
      valid.target,
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      { ...valid.target, target_commitish: 'a'.repeat(40) },
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      valid.target,
      valid.latest,
      'b'.repeat(40),
      published219Pair.target.applicationSha
    )
  );
});

test('rejects drafts, prereleases, a stale latest release, and altered asset metadata', () => {
  const valid = validPair();
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      { ...valid.target, draft: true },
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      { ...valid.target, prerelease: true },
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      { ...valid.target, assets: valid.target.assets.map((asset, index) => index === 0 ? { ...asset, id: asset.id + 1 } : asset) },
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      { ...valid.target, assets: valid.target.assets.map((asset, index) => index === 0 ? { ...asset, size: asset.size + 1 } : asset) },
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      valid.target,
      { ...valid.predecessor },
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      valid.target,
      { ...valid.latest, target_commitish: 'c'.repeat(40) },
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
  const changed = {
    ...valid.target,
    assets: valid.target.assets.map((asset, index) =>
      index === 0 ? { ...asset, digest: 'sha256:' + '0'.repeat(64) } : asset
    ),
  };
  assert.throws(() =>
    verifyPublished219Pair(
      valid.predecessor,
      changed,
      valid.latest,
      published219Pair.predecessor.applicationSha,
      published219Pair.target.applicationSha
    )
  );
});

test('rejects byte changes even when the requested filename is unchanged', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TEST-published-release-pair-'));
  const file = path.join(directory, 'fixture.bin');
  const bytes = Buffer.from('official installer bytes');
  const pin = {
    id: 1,
    name: 'fixture.bin',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    await writeFile(file, bytes);
    const proof = await verifyPublishedAssetBytes(file, pin);
    assert.equal(proof.sha256, pin.sha256);
    await writeFile(file, Buffer.concat([bytes, Buffer.from('changed')]));
    await assert.rejects(verifyPublishedAssetBytes(file, pin));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
