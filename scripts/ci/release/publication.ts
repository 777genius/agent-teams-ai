import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { checkPlan, validateOrigins, verifyDraftBytes } from './assembly.js';
import {
  MAC_EVIDENCE,
  MANIFEST,
  assetByName,
  canonical,
  checkMetadata,
  digest,
  manifestFor,
  platformNames,
  requireThat,
  textProof,
  version,
} from './contract.js';
import type { NativeEvidence, Release, ReleasePort, StagePlan } from './contract.js';
import { ReleaseHttpError } from './github.js';
import { verifyNativeReadiness } from './nativeReadiness.js';
import type { NativeReadinessPort, NativeReadinessReceipt } from './nativeReadiness.js';
import { validateNativeEvidence, verifyPublished } from './validation.js';

export interface PublicationPort extends ReleasePort {
  releaseById(repository: string, id: number): Promise<Release>;
  setVisibility(
    repository: string,
    target: StagePlan['input']['target'],
    draft: boolean
  ): Promise<void>;
}
export interface PublicationReadiness {
  schemaVersion: 1;
  phase: 'ready';
  planSha256: string;
  inputDigest: string;
  toolingSha: string;
  target: StagePlan['input']['target'];
  assetInventoryDigest: string;
  nativeReceiptDigest: string;
}
function inventory(release: Release): string {
  return digest(
    canonical(
      release.assets
        .map(({ id, name, size, digest: sha256 }) => ({ id, name, size, digest: sha256 }))
        .sort((a, b) => a.id - b.id)
    )
  );
}
function exactIdentity(release: Release, plan: StagePlan): void {
  const expected = plan.input.target;
  requireThat(
    release.id === expected.id &&
      release.tag_name === expected.tag &&
      release.target_commitish === expected.applicationSha &&
      release.created_at === expected.createdAt &&
      release.prerelease === false,
    'Numeric publication target identity changed'
  );
}
async function downloadedJson(
  port: ReleasePort,
  plan: StagePlan,
  release: Release,
  name: string
): Promise<unknown> {
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-release-readiness-'));
  try {
    const asset = assetByName(release, name);
    const destination = path.join(directory, name);
    await port.download(plan.input.repository, asset, destination);
    const bytes = await readFile(destination);
    checkMetadata(asset, textProof(name, bytes), asset.id);
    return JSON.parse(bytes.toString()) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Readiness authenticates native outcomes and bytes before permitting any write.
async function verifyReadiness(
  port: PublicationPort,
  nativePort: NativeReadinessPort,
  plan: StagePlan,
  planSha256: string,
  nativeReceipt: NativeReadinessReceipt
): Promise<PublicationReadiness> {
  checkPlan(plan);
  const carried = plan.input.mode === 'carry-mac';
  requireThat(carried || plan.input.mode === 'full', 'Unsupported publication plan');
  requireThat(/^[a-f0-9]{64}$/.test(planSha256), 'Immutable raw plan SHA-256 required');
  await verifyNativeReadiness(nativePort, plan, planSha256, nativeReceipt);
  await verifyDraftBytes(port, plan);
  const target = await validateOrigins(port, plan, true);
  const manifest = manifestFor(plan);
  if (carried) {
    const source = plan.input.macSource;
    requireThat(source, 'Missing signed carried Mac source');
    const sidecar = (await downloadedJson(port, plan, target, MAC_EVIDENCE)) as NativeEvidence;
    validateNativeEvidence(sidecar, manifest);
    const produced = await port.verifyNative(sidecar.reference);
    requireThat(
      produced.schemaVersion === 1 &&
        produced.inputDigest === manifest.inputDigest &&
        produced.toolingSha === plan.input.toolingSha &&
        produced.sourceTag === source.release.tag &&
        produced.sourceApplicationSha === source.release.applicationSha &&
        canonical(produced.assets) === canonical(sidecar.assets),
      'Carried Mac signature sidecar differs from authenticated producer'
    );
  }
  const provenanceName = `build-provenance-${plan.input.build.runId}-${plan.input.build.attempt}.json`;
  const provenance = (await downloadedJson(port, plan, target, provenanceName)) as {
    schemaVersion?: number;
    applicationSha?: string;
    tag?: string;
    runId?: number;
    attempt?: number;
    jobs?: { id: number; conclusion: string; run_id: number }[];
  };
  requireThat(
    provenance.schemaVersion === 1 &&
      provenance.applicationSha === plan.input.target.applicationSha &&
      provenance.tag === plan.input.target.tag &&
      provenance.runId === plan.input.build.runId &&
      provenance.attempt === plan.input.build.attempt &&
      Array.isArray(provenance.jobs) &&
      provenance.jobs.length === plan.input.build.jobIds.length &&
      canonical(provenance.jobs.map((job) => job.id).sort((a, b) => a - b)) ===
        canonical([...plan.input.build.jobIds].sort((a, b) => a - b)) &&
      provenance.jobs.every(
        (job) => job.conclusion === 'success' && job.run_id === provenance.runId
      ),
    'Draft build provenance does not describe pinned successful producers'
  );
  const names = [
    ...plan.outputs.map((proof) => proof.name),
    MANIFEST,
    ...(carried ? [MAC_EVIDENCE] : []),
    provenanceName,
  ];
  requireThat(new Set(names).size === names.length, 'Ambiguous planned release inventory');
  requireThat(
    target.assets.length === names.length &&
      target.assets.every((asset) => names.includes(asset.name)),
    'Unexpected or incomplete publication asset inventory'
  );
  checkMetadata(assetByName(target, MANIFEST), textProof(MANIFEST, `${canonical(manifest)}\n`));
  await port.verifyBuild(
    plan.input.repository,
    plan.input.target.applicationSha,
    plan.input.build,
    plan.input.mode
  );
  // Re-read after every native/artifact await so proofs cannot authorize a changed graph.
  const final = await validateOrigins(port, plan, true);
  requireThat(inventory(final) === inventory(target), 'Asset inventory changed during readiness');
  exactIdentity(await port.releaseById(plan.input.repository, plan.input.target.id), plan);
  return {
    schemaVersion: 1,
    phase: 'ready',
    planSha256,
    inputDigest: digest(canonical(plan.input)),
    toolingSha: plan.input.toolingSha,
    target: plan.input.target,
    assetInventoryDigest: inventory(final),
    nativeReceiptDigest: digest(canonical(nativeReceipt)),
  };
}

async function reconcileVisibility(port: PublicationPort, plan: StagePlan): Promise<Release> {
  let cause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await pause(2_000 * attempt);
    try {
      const release = await port.releaseById(plan.input.repository, plan.input.target.id);
      exactIdentity(release, plan);
      return release;
    } catch (error) {
      cause = error;
    }
  }
  throw new Error('Release visibility uncertain after bounded numeric reads', { cause });
}

async function retryPublicRead<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ReleaseHttpError) || error.httpStatus !== 408 || attempt >= 6)
        throw error;
      await pause(5_000 * attempt);
    }
  }
}

async function publishPreparedRelease(
  port: PublicationPort,
  nativePort: NativeReadinessPort,
  plan: StagePlan,
  planSha256: string,
  nativeReceipt: NativeReadinessReceipt
): Promise<{ phase: 'published'; readiness: PublicationReadiness }> {
  const readiness = await verifyReadiness(port, nativePort, plan, planSha256, nativeReceipt);
  const before = await port.releaseById(plan.input.repository, plan.input.target.id);
  exactIdentity(before, plan);
  requireThat(
    before.draft === true && inventory(before) === readiness.assetInventoryDigest,
    'Reviewed draft changed before publication'
  );
  // Latest and source checks are repeated immediately before the single visibility write.
  await validateOrigins(port, plan, true);
  const finalDraft = await port.releaseById(plan.input.repository, plan.input.target.id);
  exactIdentity(finalDraft, plan);
  requireThat(
    finalDraft.draft === true && inventory(finalDraft) === readiness.assetInventoryDigest,
    'Reviewed draft changed during final origin checks'
  );
  try {
    await port.setVisibility(plan.input.repository, plan.input.target, false);
  } catch {
    /* A lost write response is reconciled through reads, never repeated. */
  }
  const visible = await reconcileVisibility(port, plan);
  requireThat(visible.draft === false, 'Visibility write did not publish; no retry was attempted');
  try {
    requireThat(
      inventory(visible) === readiness.assetInventoryDigest,
      'Published inventory changed'
    );
    await retryPublicRead(() =>
      verifyPublished(port, plan.input.repository, plan.input.target.tag, plan.input.target.id)
    );
    const versions = manifestFor(plan).versions;
    const aliases = Object.keys(plan.aliases);
    for (const name of [
      ...platformNames(version(plan.input.target.tag)).windows,
      ...platformNames(versions.linux).linux,
      ...platformNames(versions.mac).mac,
      ...aliases,
    ]) {
      await retryPublicRead(() =>
        port.publicAsset(plan.input.repository, plan.input.target.tag, name)
      );
      await retryPublicRead(() => port.publicLatestAsset(plan.input.repository, name));
    }
    const final = await reconcileVisibility(port, plan);
    requireThat(
      !final.draft && inventory(final) === readiness.assetInventoryDigest,
      'Published inventory changed during anonymous verification'
    );
    return { phase: 'published', readiness };
  } catch (cause) {
    // Corrupt assets are a rollback reason, not a reason to skip same-ID containment.
    const failed = await reconcileVisibility(port, plan);
    if (!failed.draft) {
      try {
        await port.setVisibility(plan.input.repository, plan.input.target, true);
      } catch {
        /* Reconcile the compensation; never issue another PATCH. */
      }
    }
    const contained = await reconcileVisibility(port, plan);
    requireThat(contained.draft, 'Publication verification failed and redraft is unconfirmed');
    throw new Error('Publication verification failed; same release returned to draft', { cause });
  }
}

export async function verifyCarryReadiness(...args: Parameters<typeof verifyReadiness>) {
  requireThat(args[2].input.mode === 'carry-mac', 'Carried publisher requires carry-mac plan');
  return verifyReadiness(...args);
}
export async function verifyFullReadiness(...args: Parameters<typeof verifyReadiness>) {
  requireThat(
    args[2].input.mode === 'full' && args[2].input.target.tag === 'v2.17.8',
    'Prepared full publisher requires full218'
  );
  return verifyReadiness(...args);
}
export async function publishCarriedRelease(...args: Parameters<typeof publishPreparedRelease>) {
  requireThat(args[2].input.mode === 'carry-mac', 'Carried publisher requires carry-mac plan');
  return publishPreparedRelease(...args);
}
export async function publishFullRelease(...args: Parameters<typeof publishPreparedRelease>) {
  requireThat(
    args[2].input.mode === 'full' && args[2].input.target.tag === 'v2.17.8',
    'Prepared full publisher requires full218'
  );
  return publishPreparedRelease(...args);
}
