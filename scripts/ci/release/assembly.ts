import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MANIFEST,
  aliases,
  assetByName,
  basename,
  canonical,
  checkInput,
  checkMetadata,
  checkRelease,
  compareNames,
  digest,
  fileProof,
  macAliases,
  manifestFor,
  older,
  platformNames,
  releaseSnapshot,
  renderFeed,
  requireThat,
  sameProof,
  targetMacNames,
  textProof,
  validateFeed,
  version,
} from './contract.js';
import type {
  BuildProof,
  FileProof,
  Mode,
  Original,
  Release,
  ReleasePort,
  StageInput,
  StagePlan,
} from './contract.js';

export interface PrepareOptions {
  repository: string;
  tag: string;
  applicationSha: string;
  toolingSha: string;
  mode: Mode;
  macSourceTag?: string;
  build: BuildProof;
  output: string;
}

function proofFor(input: StageInput, name: string): Original {
  const proof = input.originals.find((p) => p.name === name);
  requireThat(proof, `Missing byte input: ${name}`);
  return proof;
}
function feedFiles(input: StageInput, names: string[]): FileProof[] {
  return names.map((name) => proofFor(input, name));
}
export function requiredFeed(feeds: Record<string, string>, name: string): string {
  const raw = feeds[name];
  requireThat(typeof raw === 'string', `Missing updater feed: ${name}`);
  return raw;
}
export function checkPlan(plan: StagePlan): void {
  requireThat(plan.schemaVersion === 1, 'Unknown stage plan schema');
  checkInput(plan.input);
  const input = plan.input;
  const targetVersion = version(input.target.tag);
  const releaseNotes = input.includeReleaseNotes ? input.target.body : undefined;
  const macVersion = version(input.macSource?.release.tag ?? input.target.tag);
  requireThat(
    canonical(plan.aliases) === canonical(aliases(targetVersion, macVersion)),
    'Alias mapping differs from release policy'
  );
  const targetNames = platformNames(targetVersion);
  const macNames = platformNames(macVersion).mac;
  requireThat(
    Object.keys(plan.feeds).sort(compareNames).join(',') ===
      'latest-linux.yml,latest-mac.yml,latest.yml',
    'Exactly three updater feeds required'
  );
  const mac = requiredFeed(plan.feeds, 'latest-mac.yml');
  validateFeed(mac, macVersion, feedFiles(input, macNames));
  if (input.mode === 'carry-mac')
    sameProof(textProof('latest-mac.yml', mac), proofFor(input, 'latest-mac.yml'));
  else
    requireThat(
      mac ===
        renderFeed(
          targetVersion,
          feedFiles(input, macNames),
          input.target.createdAt,
          input.macProductMinimum === '12.0' ? '21.0.0' : '22.0.0',
          releaseNotes
        ),
      'Full Mac feed differs from release policy'
    );
  requireThat(
    plan.feeds['latest.yml'] ===
      renderFeed(
        targetVersion,
        feedFiles(input, targetNames.windows),
        input.target.createdAt,
        undefined,
        releaseNotes
      ),
    'Windows feed differs from release policy'
  );
  requireThat(
    plan.feeds['latest-linux.yml'] ===
      renderFeed(
        targetVersion,
        feedFiles(input, targetNames.linux),
        input.target.createdAt,
        undefined,
        releaseNotes
      ),
    'Linux feed differs from release policy'
  );
  const expected = expectedOutputs(plan);
  requireThat(
    canonical(expected) === canonical(plan.outputs),
    'Output proofs differ from immutable inputs'
  );
}
function expectedOutputs(plan: Pick<StagePlan, 'input' | 'feeds' | 'aliases'>): FileProof[] {
  const byName = new Map<string, FileProof>();
  for (const original of plan.input.originals) {
    const { name, size, sha256, sha512 } = original;
    byName.set(name, { name, size, sha256, sha512 });
  }
  for (const [name, source] of Object.entries(plan.aliases)) {
    const proof = proofFor(plan.input, source);
    byName.set(name, { name, size: proof.size, sha256: proof.sha256, sha512: proof.sha512 });
  }
  for (const [name, raw] of Object.entries(plan.feeds)) byName.set(name, textProof(name, raw));
  return [...byName.values()].sort((a, b) => compareNames(a.name, b.name));
}
async function capture(
  port: ReleasePort,
  repository: string,
  release: Release,
  names: string[],
  directory: string
): Promise<Original[]> {
  const originals: Original[] = [];
  for (const name of names) {
    basename(name);
    const asset = assetByName(release, name);
    const destination = path.join(directory, name);
    await port.download(repository, asset, destination);
    const proof = await fileProof(destination, name);
    checkMetadata(asset, proof);
    originals.push({ ...proof, assetId: asset.id, releaseId: release.id, tag: release.tag_name });
  }
  return originals;
}
export async function prepareDraft(
  port: ReleasePort,
  options: PrepareOptions
): Promise<{ plan: StagePlan; planDigest: string }> {
  requireThat(
    /^[a-f0-9]{40}$/.test(options.toolingSha) && /^[a-f0-9]{40}$/.test(options.applicationSha),
    'Exact tooling/application SHA required'
  );
  requireThat(options.mode === 'full' || options.mode === 'carry-mac', 'Unknown release mode');
  requireThat(
    options.mode === 'carry-mac' ? !!options.macSourceTag : !options.macSourceTag,
    'Mac source tag must be explicit and only used in carry-mac mode'
  );
  const target = await port.release(options.repository, options.tag);
  checkRelease(target, undefined, true);
  requireThat(target.tag_name === options.tag, 'Target release tag mismatch');
  const targetSha = await port.tagSha(options.repository, options.tag);
  requireThat(
    targetSha === options.applicationSha && target.target_commitish === targetSha,
    'Target tag/application/draft SHA mismatch'
  );
  await port.verifyBuild(options.repository, targetSha, options.build, options.mode);
  const latest = await port.latest(options.repository);
  checkRelease(latest, undefined, false);
  let source: Release | undefined;
  let sourceSha = targetSha;
  if (options.mode === 'carry-mac') {
    requireThat(
      options.repository === '777genius/agent-teams-ai' &&
        older(options.macSourceTag!, options.tag),
      'Canonical pinned older Mac source required'
    );
    source = await port.release(options.repository, options.macSourceTag!);
    checkRelease(source, undefined, false);
    requireThat(source.tag_name === options.macSourceTag, 'Mac source release tag mismatch');
    sourceSha = await port.tagSha(options.repository, source.tag_name);
    requireThat(source.target_commitish === sourceSha, 'Mac source target/tag SHA mismatch');
    requireThat(
      !target.assets.some((a) => targetMacNames(version(options.tag)).includes(a.name)),
      'Competing target-version Mac payloads exist'
    );
  }
  const minimum = await port.minimum(options.repository, sourceSha);
  requireThat(minimum === '12.0' || minimum === '13.0', 'Unsupported macOS product minimum');
  if (source) requireThat(minimum === '12.0', 'Pinned carry source requires macOS 12.0 metadata');
  await mkdir(options.output, { recursive: true });
  requireThat(
    (await readdir(options.output)).length === 0,
    'Prepare output must be an empty disposable TEST directory'
  );
  const targetNames = platformNames(version(options.tag));
  const targetAssets = [
    ...targetNames.windows,
    ...targetNames.linux,
    ...targetNames.windows.map((n) => `${n}.blockmap`),
    ...(source ? [] : targetNames.mac),
  ];
  const originals = await capture(port, options.repository, target, targetAssets, options.output);
  if (source)
    originals.push(
      ...(await capture(
        port,
        options.repository,
        source,
        [
          ...platformNames(version(source.tag_name)).mac,
          ...Object.keys(macAliases(version(source.tag_name))),
          'latest-mac.yml',
        ],
        options.output
      ))
    );
  const sortedOriginals = originals.toSorted((a, b) => compareNames(a.name, b.name));
  const input: StageInput = {
    repository: options.repository,
    mode: options.mode,
    toolingSha: options.toolingSha,
    target: releaseSnapshot(target, targetSha),
    latest: { id: latest.id, tag: latest.tag_name },
    originals: sortedOriginals,
    macSource: source
      ? { release: releaseSnapshot(source, sourceSha), productMinimum: minimum }
      : null,
    build: options.build,
    macProductMinimum: minimum,
    includeReleaseNotes: true,
  };
  checkInput(input);
  if (source)
    for (const [name, payload] of Object.entries(macAliases(version(source.tag_name)))) {
      const alias = proofFor(input, name);
      const original = proofFor(input, payload);
      sameProof({ ...alias, name: original.name }, original);
    }
  const darwinMinimum = minimum === '12.0' ? '21.0.0' : '22.0.0';
  const feeds = {
    'latest.yml': renderFeed(
      version(options.tag),
      feedFiles(input, targetNames.windows),
      target.created_at,
      undefined,
      target.body
    ),
    'latest-linux.yml': renderFeed(
      version(options.tag),
      feedFiles(input, targetNames.linux),
      target.created_at,
      undefined,
      target.body
    ),
    'latest-mac.yml': source
      ? await readFile(path.join(options.output, 'latest-mac.yml'), 'utf8')
      : renderFeed(
          version(options.tag),
          feedFiles(input, targetNames.mac),
          target.created_at,
          darwinMinimum,
          target.body
        ),
  };
  const mapping = aliases(version(options.tag), version(source?.tag_name ?? options.tag));
  const plan: StagePlan = {
    schemaVersion: 1,
    input,
    feeds,
    aliases: mapping,
    outputs: expectedOutputs({ input, feeds, aliases: mapping }),
  };
  checkPlan(plan);
  await materializeGenerated(plan, options.output);
  const bytes = `${canonical(plan)}\n`;
  const planDigest = digest(bytes);
  await writeFile(path.join(options.output, 'stage-plan.json'), bytes, { flag: 'wx' });
  await writeFile(path.join(options.output, 'stage-plan.sha256'), `${planDigest}\n`, {
    flag: 'wx',
  });
  // Re-read captured origins after the complete download audit, before accepting the plan.
  await validateOrigins(port, plan, true);
  if (input.macSource) await port.publicRelease(input.repository, input.macSource.release.tag);
  return { plan, planDigest };
}
export async function loadPlan(file: string, expectedDigest: string): Promise<StagePlan> {
  requireThat(/^[a-f0-9]{64}$/.test(expectedDigest), 'External immutable plan SHA-256 required');
  const bytes = await readFile(file);
  requireThat(digest(bytes) === expectedDigest, 'Prepared plan digest mismatch');
  const plan = JSON.parse(bytes.toString()) as StagePlan;
  checkPlan(plan);
  return plan;
}
export async function validateOrigins(
  port: ReleasePort,
  plan: StagePlan,
  draft: boolean
): Promise<Release> {
  const input = plan.input;
  const target = await port.release(input.repository, input.target.tag);
  checkRelease(target, input.target, draft);
  requireThat(
    (await port.tagSha(input.repository, input.target.tag)) === input.target.applicationSha,
    'Target tag moved'
  );
  if (input.mode === 'carry-mac')
    requireThat(
      !target.assets.some((a) => targetMacNames(version(input.target.tag)).includes(a.name)),
      'Competing target-version Mac payloads exist'
    );
  let source: Release | undefined;
  if (input.macSource) {
    source = await port.release(input.repository, input.macSource.release.tag);
    checkRelease(source, input.macSource.release, false);
    requireThat(
      (await port.tagSha(input.repository, source.tag_name)) ===
        input.macSource.release.applicationSha,
      'Mac source tag moved'
    );
  }
  requireThat(
    (await port.minimum(
      input.repository,
      input.macSource?.release.applicationSha ?? input.target.applicationSha
    )) === input.macProductMinimum,
    'Source macOS metadata changed'
  );
  for (const original of input.originals)
    checkMetadata(
      assetByName(original.tag === input.target.tag ? target : source!, original.name),
      original,
      original.assetId
    );
  if (draft) {
    const latest = await port.latest(input.repository);
    requireThat(
      latest.id === input.latest.id &&
        latest.tag_name === input.latest.tag &&
        !latest.draft &&
        !latest.prerelease,
      'Public latest changed during draft staging'
    );
  }
  return target;
}
async function materializeGenerated(plan: StagePlan, directory: string): Promise<void> {
  for (const [name, source] of Object.entries(plan.aliases)) {
    // Carried source aliases already exist locally; they were independently downloaded and verified.
    if (!plan.input.originals.some((f) => f.name === name)) {
      try {
        await link(path.join(directory, source), path.join(directory, name));
      } catch (error) {
        requireThat(
          error instanceof Error &&
            'code' in error &&
            (error.code === 'EXDEV' || error.code === 'EPERM'),
          `Cannot create local alias: ${name}`
        );
        await copyFile(path.join(directory, source), path.join(directory, name));
      }
    }
  }
  for (const [name, raw] of Object.entries(plan.feeds))
    await writeFile(path.join(directory, name), raw);
  await writeFile(path.join(directory, MANIFEST), `${canonical(manifestFor(plan))}\n`, {
    flag: 'wx',
  });
}
export async function stageDraft(
  port: ReleasePort,
  plan: StagePlan
): Promise<{ uploaded: number; unchanged: number; phase: 'assembled' }> {
  checkPlan(plan);
  const initial = await validateOrigins(port, plan, true);
  if (plan.input.macSource)
    await port.publicRelease(plan.input.repository, plan.input.macSource.release.tag);
  // Reject every known collision before the first upload, including a foreign manifest.
  for (const proof of [...plan.outputs, textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`)]) {
    const existing = initial.assets.find((a) => a.name === proof.name);
    if (existing) checkMetadata(existing, proof);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-release-stage-'));
  let uploaded = 0;
  let unchanged = 0;
  try {
    for (const original of plan.input.originals) {
      const release = await port.release(plan.input.repository, original.tag);
      await port.download(
        plan.input.repository,
        assetByName(release, original.name),
        path.join(directory, original.name)
      );
      sameProof(await fileProof(path.join(directory, original.name), original.name), original);
    }
    await materializeGenerated(plan, directory);
    const manifestProof = await fileProof(path.join(directory, MANIFEST), MANIFEST);
    for (const proof of [...plan.outputs, manifestProof]) {
      if (await reconcileOutput(port, plan, directory, proof)) uploaded++;
      else unchanged++;
    }
    const final = await validateOrigins(port, plan, true);
    if (plan.input.macSource)
      await port.publicRelease(plan.input.repository, plan.input.macSource.release.tag);
    for (const proof of [...plan.outputs, manifestProof])
      checkMetadata(assetByName(final, proof.name), proof);
    return { uploaded, unchanged, phase: 'assembled' };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function reconcileOutput(
  port: ReleasePort,
  plan: StagePlan,
  directory: string,
  proof: FileProof
): Promise<boolean> {
  sameProof(await fileProof(path.join(directory, proof.name), proof.name), proof);
  const release = await validateOrigins(port, plan, true);
  const existing = release.assets.find((a) => a.name === proof.name);
  if (existing) {
    checkMetadata(existing, proof);
    const captured = plan.input.originals.find(
      (o) => o.name === proof.name && o.tag === plan.input.target.tag && o.assetId === existing.id
    );
    if (!captured) await verifyDestination(port, plan, existing, proof);
    return false;
  }
  let uploadError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A lost upload response is reconciled by reading actual bytes before any retry.
    await validateOrigins(port, plan, true);
    try {
      await port.upload(
        plan.input.repository,
        plan.input.target.id,
        path.join(directory, proof.name)
      );
    } catch (error) {
      uploadError = error instanceof Error ? error : new Error(String(error));
    }
    const current = await validateOrigins(port, plan, true);
    const added = current.assets.find((a) => a.name === proof.name);
    if (added) {
      checkMetadata(added, proof);
      await verifyDestination(port, plan, added, proof);
      return true;
    }
    uploadError ??= new Error(`Upload not visible: ${proof.name}`);
  }
  throw uploadError ?? new Error(`Upload could not be verified: ${proof.name}`);
}
async function verifyDestination(
  port: ReleasePort,
  plan: StagePlan,
  asset: import('./contract.js').Asset,
  proof: FileProof
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-release-audit-'));
  try {
    const file = path.join(directory, proof.name);
    await port.download(plan.input.repository, asset, file);
    sameProof(await fileProof(file, proof.name), proof);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function verifyDraftBytes(port: ReleasePort, plan: StagePlan): Promise<void> {
  checkPlan(plan);
  const target = await validateOrigins(port, plan, true);
  for (const proof of [...plan.outputs, textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`)]) {
    const asset = assetByName(target, proof.name);
    checkMetadata(asset, proof);
    await verifyDestination(port, plan, asset, proof);
  }
  await validateOrigins(port, plan, true);
  if (plan.input.macSource)
    await port.publicRelease(plan.input.repository, plan.input.macSource.release.tag);
}
