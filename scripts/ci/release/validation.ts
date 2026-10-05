import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';

import { checkPlan, requiredFeed, validateOrigins } from './assembly.js';
import {
  MAC_EVIDENCE,
  MANIFEST,
  assetByName,
  canonical,
  checkMetadata,
  checkRelease,
  digest,
  fileProof,
  manifestFor,
  older,
  platformNames,
  releaseSnapshot,
  requireThat,
  sameProof,
  textProof,
  validateFeed,
  version,
} from './contract.js';
import type {
  FileProof,
  NativeEvidence,
  PlatformManifest,
  Release,
  ReleasePort,
  StagePlan,
} from './contract.js';

async function downloadedProof(
  port: ReleasePort,
  repository: string,
  release: Release,
  name: string
): Promise<{ raw: Buffer; proof: FileProof }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-publication-audit-'));
  try {
    const asset = assetByName(release, name);
    const file = path.join(directory, name);
    await port.download(repository, asset, file);
    const proof = await fileProof(file, name);
    checkMetadata(asset, proof);
    // Binaries are audited by streaming hashes; only metadata is retained in memory.
    const raw = /\.(json|yml)$/.test(name) ? await readFile(file) : Buffer.alloc(0);
    return { raw, proof };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function validateNativeEvidence(evidence: NativeEvidence, manifest: PlatformManifest): void {
  requireThat(
    evidence.schemaVersion === 1 &&
      evidence.reference.inputDigest === manifest.inputDigest &&
      evidence.reference.repository === manifest.input.repository &&
      evidence.reference.toolingSha === manifest.input.toolingSha,
    'Native source evidence input/tooling mismatch'
  );
  const source = manifest.input.macSource;
  requireThat(source, 'Source native evidence only applies to carry-mac');
  const names = platformNames(version(source.release.tag)).mac;
  requireThat(
    evidence.assets.length === names.length &&
      new Set(evidence.assets.map((a) => a.assetId)).size === names.length,
    'Four source ZIP/DMG native probes required'
  );
  for (const name of names) {
    const original = manifest.input.originals.find((o) => o.name === name);
    requireThat(original, 'Missing native source input');
    const probe = evidence.assets.find((p) => p.assetId === original.assetId);
    requireThat(
      probe?.sha256 === original.sha256 &&
        probe.version === version(source.release.tag) &&
        probe.architecture === (name.includes('-arm64') ? 'arm64' : 'x64') &&
        probe.teamIdentifier === '6C84CW694S' &&
        probe.productMinimum === '12.0',
      `Native artifact identity mismatch: ${name}`
    );
    requireThat(
      Array.isArray(probe.commands) &&
        probe.commands.length >= 6 &&
        probe.commands.every((c) => c.exitCode === 0 && /^[a-f0-9]{64}$/.test(c.outputSha256)),
      'Native signature probe command failure'
    );
    const requiredCommands = [
      'codesign --verify --deep --strict',
      'spctl --assess',
      'xcrun stapler validate',
      'lipo -archs',
      'CFBundleShortVersionString',
      'LSMinimumSystemVersion',
    ];
    requireThat(
      requiredCommands.every((marker) => probe.commands.some((c) => c.command.includes(marker))),
      'Native signature/stapling/version/architecture assessment missing'
    );
  }
}
async function verifyCarriedSource(
  port: ReleasePort,
  manifest: PlatformManifest,
  feeds: Record<string, string>,
  sidecar: NativeEvidence
): Promise<void> {
  const repository = manifest.input.repository;
  const tag = manifest.input.target.tag;
  const snapshot = manifest.input.macSource?.release;
  requireThat(snapshot, 'Missing carried source snapshot');
  const source = await port.release(repository, snapshot.tag);
  await port.publicRelease(repository, snapshot.tag);
  const raw = (await downloadedProof(port, repository, source, 'latest-mac.yml')).raw;
  sameProof(
    textProof('latest-mac.yml', raw),
    textProof('latest-mac.yml', requiredFeed(feeds, 'latest-mac.yml'))
  );
  for (const name of [
    ...platformNames(manifest.versions.mac).mac,
    ...Object.keys(manifest.aliases).filter((n) => /\.dmg$|-mac\.zip$/.test(n)),
    'latest-mac.yml',
  ]) {
    await port.publicAsset(repository, tag, name);
    await port.publicAsset(repository, source.tag_name, name);
  }
  validateNativeEvidence(sidecar, manifest);
  const produced = await port.verifyNative(sidecar.reference);
  requireThat(
    produced.schemaVersion === 1 &&
      produced.inputDigest === manifest.inputDigest &&
      produced.toolingSha === manifest.input.toolingSha &&
      produced.sourceTag === source.tag_name &&
      produced.sourceApplicationSha === snapshot.applicationSha &&
      canonical(produced.assets) === canonical(sidecar.assets),
    'Published native evidence differs from producing artifact'
  );
}
async function verifyLegacyFull(
  target: Release,
  feeds: Record<string, string>,
  audit: (name: string) => Promise<{ raw: Buffer; proof: FileProof }>,
  productMinimum: string | undefined
): Promise<void> {
  const tag = target.tag_name;
  const names = platformNames(version(tag));
  for (const [feed, expectedNames] of [
    ['latest.yml', names.windows],
    ['latest-linux.yml', names.linux],
    ['latest-mac.yml', names.mac],
  ] as const) {
    const proofs: FileProof[] = [];
    for (const name of expectedNames) proofs.push((await audit(name)).proof);
    const raw = requiredFeed(feeds, feed);
    // Historical complete releases had all four Linux assets but exposed only
    // AppImage in the updater feed. New plans/releases use the four-format contract.
    const parsed = parse(raw) as { files?: unknown } | null;
    const historicalAppImage =
      feed === 'latest-linux.yml' &&
      older(tag, 'v2.17.2') &&
      Array.isArray(parsed?.files) &&
      parsed.files.length === 1;
    validateFeed(raw, version(tag), historicalAppImage ? proofs.slice(0, 1) : proofs);
  }
  if (!older(tag, 'v2.17.2')) {
    requireThat(
      productMinimum === '12.0' || productMinimum === '13.0',
      'Unsupported application macOS minimum for manifestless full release'
    );
    const mac = parse(requiredFeed(feeds, 'latest-mac.yml')) as {
      minimumSystemVersion?: unknown;
    } | null;
    const darwinMinimum = productMinimum === '12.0' ? '21.0.0' : '22.0.0';
    requireThat(
      mac?.minimumSystemVersion === darwinMinimum,
      'Manifestless full release macOS minimum differs from application commit'
    );
  }
  for (const name of names.windows.map((n) => `${n}.blockmap`)) assetByName(target, name);
}
export async function verifyPublished(
  port: ReleasePort,
  repository: string,
  tag: string,
  releaseId?: number
): Promise<{ mode: string; tag: string }> {
  const target = await port.release(repository, tag);
  checkRelease(target, undefined, false);
  const applicationSha = await port.tagSha(repository, tag);
  requireThat(target.target_commitish === applicationSha, 'Published tag/application SHA mismatch');
  const audited = new Map<string, FileProof>();
  const audit = async (name: string) => {
    const result = await downloadedProof(port, repository, target, name);
    audited.set(name, result.proof);
    return result;
  };
  const finish = async () => {
    const final = await port.release(repository, tag);
    checkRelease(final, releaseSnapshot(target, applicationSha), false);
    requireThat(
      (await port.tagSha(repository, tag)) === applicationSha,
      'Published tag changed during audit'
    );
    for (const proof of audited.values()) checkMetadata(assetByName(final, proof.name), proof);
    const latest = await port.latest(repository);
    requireThat(
      latest.id === target.id && latest.tag_name === tag,
      'Latest changed during publication audit'
    );
    await port.publicLatest(repository, tag);
  };
  requireThat(!releaseId || target.id === releaseId, 'Release ID/tag mismatch');
  const latest = await port.latest(repository);
  requireThat(
    latest.id === target.id && latest.tag_name === tag && !latest.draft && !latest.prerelease,
    'Published release is not GitHub latest'
  );
  await port.publicRelease(repository, tag);
  await port.publicLatest(repository, tag);
  const found = target.assets.some((a) => a.name === MANIFEST);
  const feeds: Record<string, string> = {};
  for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']) {
    feeds[name] = (await audit(name)).raw.toString();
    await port.publicAsset(repository, tag, name);
    await port.publicLatestAsset(repository, name);
  }
  if (!found) {
    const productMinimum = older(tag, 'v2.17.2')
      ? undefined
      : await port.minimum(repository, applicationSha);
    await verifyLegacyFull(target, feeds, audit, productMinimum);
    await finish();
    return { mode: 'full', tag };
  }
  const manifest = JSON.parse((await audit(MANIFEST)).raw.toString()) as PlatformManifest;
  requireThat(
    manifest.schemaVersion === 1 &&
      manifest.phase === 'assembled' &&
      manifest.input.repository === repository &&
      manifest.input.target.tag === tag &&
      manifest.inputDigest === digest(canonical(manifest.input)),
    'Invalid platform manifest/provenance'
  );
  const plan: StagePlan = {
    schemaVersion: 1,
    input: manifest.input,
    feeds,
    aliases: manifest.aliases,
    outputs: manifest.outputs,
  };
  checkPlan(plan);
  requireThat(
    canonical(manifestFor(plan)) === canonical(manifest),
    'Manifest does not describe the independently checked release contract'
  );
  await validateOrigins(port, plan, false);
  await port.verifyBuild(
    repository,
    manifest.input.target.applicationSha,
    manifest.input.build,
    manifest.input.mode
  );
  for (const proof of manifest.outputs) checkMetadata(assetByName(target, proof.name), proof);
  const canonicalNames = [
    ...platformNames(manifest.versions.windows).windows,
    ...platformNames(manifest.versions.linux).linux,
    ...platformNames(manifest.versions.mac).mac,
  ];
  for (const name of canonicalNames) {
    const actual = (await audit(name)).proof;
    const expected = manifest.outputs.find((f) => f.name === name);
    requireThat(expected, `Manifest missing canonical payload: ${name}`);
    sameProof(actual, expected);
  }
  if (manifest.input.mode === 'carry-mac') {
    const sidecar = JSON.parse((await audit(MAC_EVIDENCE)).raw.toString()) as NativeEvidence;
    await verifyCarriedSource(port, manifest, feeds, sidecar);
  }
  // Changes during the audit invalidate the evidence; never silently accept a mixed snapshot.
  const final = await validateOrigins(port, plan, false);
  for (const proof of manifest.outputs) checkMetadata(assetByName(final, proof.name), proof);
  await finish();
  return { mode: manifest.input.mode, tag };
}
