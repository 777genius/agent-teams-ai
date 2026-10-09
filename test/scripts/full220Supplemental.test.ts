// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as assembly from '../../scripts/ci/release/assembly.js';
import {
  canonical,
  digest,
  MANIFEST,
  manifestFor,
  textProof,
} from '../../scripts/ci/release/contract.js';
import * as supplemental from '../../scripts/ci/release/full220Supplemental.js';
import * as native from '../../scripts/ci/release/nativeReadiness.js';
import { verifyFullReadiness } from '../../scripts/ci/release/publication.js';

import type { Asset, Release, ReleasePort, StagePlan } from '../../scripts/ci/release/contract.js';
import type {
  NativeReadinessPort,
  NativeReadinessReceipt,
} from '../../scripts/ci/release/nativeReadiness.js';
import type { PublicationPort } from '../../scripts/ci/release/publication.js';

const raw = await readFile(new URL('../fixtures/release220-original-P10.json', import.meta.url));
const plan = JSON.parse(raw.toString()) as StagePlan;
const rawHash = 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678';
const pins = supplemental.originalFull220Supplemental(plan, rawHash)!;
const draft = (): Release => ({
  id: plan.input.target.id,
  tag_name: plan.input.target.tag,
  target_commitish: plan.input.target.applicationSha,
  created_at: plan.input.target.createdAt,
  draft: true,
  prerelease: false,
  name: plan.input.target.name,
  body: plan.input.target.body,
  assets: [
    ...plan.outputs.map((p, index) => ({
      id: index + 1,
      name: p.name,
      size: p.size,
      digest: `sha256:${p.sha256}`,
    })),
    (() => {
      const p = textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`);
      return { id: 40, name: p.name, size: p.size, digest: `sha256:${p.sha256}` };
    })(),
    ...pins.map((p) => ({ ...p })),
  ],
});

function readinessFixture() {
  const target = draft();
  vi.spyOn(assembly, 'verifyDraftBytes').mockResolvedValue(undefined);
  vi.spyOn(assembly, 'validateOrigins').mockResolvedValue(target);
  vi.spyOn(native, 'verifyNativeReadiness').mockResolvedValue(undefined);
  const verifyBuild = vi.fn().mockResolvedValue(undefined);
  const download = vi.fn().mockRejectedValue(new Error('Missing build provenance'));
  const port = {
    verifyBuild,
    download,
    releaseById: vi.fn().mockResolvedValue(target),
  } as unknown as PublicationPort;
  const ready = (p = plan, hash = rawHash) =>
    verifyFullReadiness(port, {} as NativeReadinessPort, p, hash, {} as NativeReadinessReceipt);
  return { target, ready, verifyBuild, download };
}

afterEach(() => vi.restoreAllMocks());
describe('original full220 publication contract', () => {
  it('recognizes only authentic P10 including its source, body, outputs and original build', () => {
    expect(digest(raw)).toBe(rawHash);
    expect(pins).toHaveLength(4);
    expect(pins.map((p) => p.id)).toEqual([621569943, 621569988, 621562790, 621562827]);
    expect(supplemental.originalFull220Supplemental(plan, 'a'.repeat(64))).toBeNull();
    for (const mutate of [
      (p: StagePlan) => {
        p.input.target.body += 'changed';
      },
      (p: StagePlan) => {
        p.input.build.attempt = 2;
      },
      (p: StagePlan) => {
        p.input.build.jobIds[0] = 999;
      },
      (p: StagePlan) => {
        p.input.toolingSha = 'a'.repeat(40);
      },
      (p: StagePlan) => {
        p.outputs[0]!.sha256 = 'b'.repeat(64);
      },
    ]) {
      const changed = structuredClone(plan);
      mutate(changed);
      expect(supplemental.originalFull220Supplemental(changed, rawHash)).toBeNull();
    }
  });
  it.each(['id', 'digest', 'size', 'name'] as const)(
    'rejects replacement original blockmap %s before downloading',
    async (field) => {
      const target = draft();
      const asset = target.assets.find((a) => a.id === 621569943)!;
      if (field === 'id') asset.id++;
      else if (field === 'size') asset.size++;
      else if (field === 'digest') asset.digest = `sha256:${'a'.repeat(64)}`;
      else asset.name += '.replacement';
      const download = vi.fn();
      await expect(
        supplemental.verifyOriginalFull220Supplemental(
          { download } as unknown as ReleasePort,
          plan,
          target,
          pins
        )
      ).rejects.toThrow();
      expect(download).not.toHaveBeenCalled();
    }
  );
  it('rejects downloaded corruption even when API identity and digest match the pin', async () => {
    const download = vi.fn(async (_repo: string, _asset: Asset, destination: string) => {
      await writeFile(destination, Buffer.alloc(329616));
    });
    await expect(
      supplemental.verifyOriginalFull220Supplemental(
        { download } as unknown as ReleasePort,
        plan,
        draft(),
        pins
      )
    ).rejects.toThrow('bytes changed');
    expect(download).toHaveBeenCalledOnce();
  });
  it('accepts 41 assets only after supplemental proof and original five producer jobs', async () => {
    const f = readinessFixture();
    vi.spyOn(supplemental, 'verifyOriginalFull220Supplemental').mockResolvedValue('c'.repeat(64));
    const result = await f.ready();
    expect(f.target.assets).toHaveLength(41);
    expect(result.supplementalProofDigest).toBe('c'.repeat(64));
    expect(f.verifyBuild).toHaveBeenCalledWith(
      '777genius/agent-teams-ai',
      'dc1ec2d927b8c27c20d18c976ee615b27a2bd6f3',
      {
        runId: 37762252311,
        attempt: 1,
        jobIds: [113266257625, 113266257752, 113266257777, 113266257766, 113266257785],
      },
      'full'
    );
    expect(f.download).not.toHaveBeenCalled();
  });
  it('rejects arbitrary extra assets rather than filtering the inventory', async () => {
    const f = readinessFixture();
    vi.spyOn(supplemental, 'verifyOriginalFull220Supplemental').mockResolvedValue('c'.repeat(64));
    f.target.assets.push({
      id: 99,
      name: 'foreign.bin',
      size: 1,
      digest: `sha256:${'a'.repeat(64)}`,
    });
    await expect(f.ready()).rejects.toThrow('inventory');
  });
  it('keeps the ordinary full provenance requirement when raw P10 does not match', async () => {
    const f = readinessFixture();
    const proof = vi.spyOn(supplemental, 'verifyOriginalFull220Supplemental');
    await expect(f.ready(plan, 'a'.repeat(64))).rejects.toThrow(
      'Missing asset: v2.17.10/build-provenance-37762252311-1.json'
    );
    expect(proof).not.toHaveBeenCalled();
  });
  it('propagates failed producer authentication even with complete blockmap proofs', async () => {
    const f = readinessFixture();
    vi.spyOn(supplemental, 'verifyOriginalFull220Supplemental').mockResolvedValue('c'.repeat(64));
    f.verifyBuild.mockRejectedValueOnce(new Error('Build attempt changed'));
    await expect(f.ready()).rejects.toThrow('Build attempt changed');
  });
});
