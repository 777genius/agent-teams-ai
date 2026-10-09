import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assetByName, canonical, digest, requireThat } from './contract.js';
import type { Asset, Release, ReleasePort, StagePlan } from './contract.js';

// The original full220 producer predates the build-provenance sidecar.
// Authenticate that immutable plan and its four original Mac blockmaps only.
export function originalFull220Supplemental(plan: StagePlan, planSha256: string): Asset[] | null {
  if (
    planSha256 !== 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678' ||
    digest(canonical(plan)) !==
      '74ceaaf7b0a2face17b5984c3600fe1cef54d1f9c09785aa252763df889ee5fd' ||
    digest(canonical(plan.input)) !==
      'f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa' ||
    plan.input.repository !== '777genius/agent-teams-ai' ||
    plan.input.mode !== 'full' ||
    plan.input.target.id !== 406694223 ||
    plan.input.target.tag !== 'v2.17.10' ||
    plan.input.target.applicationSha !== 'dc1ec2d927b8c27c20d18c976ee615b27a2bd6f3' ||
    plan.input.build.runId !== 37762252311 ||
    plan.input.build.attempt !== 1 ||
    canonical(plan.input.build.jobIds) !==
      canonical([113266257625, 113266257752, 113266257777, 113266257766, 113266257785])
  )
    return null;
  return [
    {
      id: 621569943,
      name: 'Agent.Teams.AI-2.17.10-arm64-mac.zip.blockmap',
      size: 329616,
      digest: 'sha256:82ddb1602622ec4de08b15866a11448fc0328b420b3deab172be4f67eacb2aab',
    },
    {
      id: 621569988,
      name: 'Agent.Teams.AI-2.17.10-arm64.dmg.blockmap',
      size: 360368,
      digest: 'sha256:0988ed16c123e25bce8919873445ebfe38396e0635aaf26c1c7b8e8cc675adcd',
    },
    {
      id: 621562790,
      name: 'Agent.Teams.AI-2.17.10-x64-mac.zip.blockmap',
      size: 337933,
      digest: 'sha256:a4e2c9a26e4467c2e3501f9648a6a0407c57e09202be686a7d427754de7c3dac',
    },
    {
      id: 621562827,
      name: 'Agent.Teams.AI-2.17.10-x64.dmg.blockmap',
      size: 370238,
      digest: 'sha256:3d9045f186245eb25e6f35ef3405e1b3f54f43c9c5f2d25d1245d99f773653b2',
    },
  ];
}

export async function verifyOriginalFull220Supplemental(
  port: ReleasePort,
  plan: StagePlan,
  release: Release,
  expected: Asset[]
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-full220-blockmaps-'));
  try {
    for (const pin of expected) {
      const asset = assetByName(release, pin.name);
      requireThat(
        asset.id === pin.id &&
          asset.name === pin.name &&
          asset.size === pin.size &&
          asset.digest === pin.digest,
        `Original Mac blockmap identity changed: ${pin.name}`
      );
      const destination = path.join(directory, pin.name);
      await port.download(plan.input.repository, asset, destination);
      const bytes = await readFile(destination);
      requireThat(
        bytes.length === pin.size && `sha256:${digest(bytes)}` === pin.digest,
        `Original Mac blockmap bytes changed: ${pin.name}`
      );
    }
    return digest(
      canonical({
        planSha256: 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678',
        assets: expected,
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
