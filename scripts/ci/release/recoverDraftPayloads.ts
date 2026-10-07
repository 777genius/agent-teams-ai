import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { canonical, fileProof, platformNames, requireThat } from './contract.js';
import type { Asset, BuildProof, Release } from './contract.js';
import { GitHubReleasePort } from './github.js';
import type { GitHubBuildRun } from './github.js';

export const RECOVERY = {
  repository: '777genius/agent-teams-ai',
  tag: 'v2.17.3',
  releaseId: 404009045,
  applicationSha: 'acda6e3a0990aec3cd37b9bd696f36e78aaa4322',
  runId: 37342668377,
  attempt: 1,
  workflowPath: '.github/workflows/build-linux-windows-draft.yml',
  producers: [
    {
      jobId: 111873384897,
      jobName: 'release-win x64',
      artifactId: 11361141479,
      name: 'draft-win32-x64-1',
      sha256: '78cace5bde762015fd293cfbfdd5e405773f66c1126177b22faaf699108553f0',
    },
    {
      jobId: 111873385262,
      jobName: 'release-linux x64',
      artifactId: 11363200282,
      name: 'draft-linux-x64-1',
      sha256: '36c85673a1907225d6ea2078716b5544f0172cc93b903807e453bf2ab837cfb0',
    },
    {
      jobId: 111873385293,
      jobName: 'release-win arm64',
      artifactId: 11360727266,
      name: 'draft-win32-arm64-1',
      sha256: '98e46e6b9e215d418ed71dbe4464d3228c6408fa93cd060f5fa285e1d4122130',
    },
  ],
} as const;

export interface RecoveryBinding {
  repository: string;
  tag: string;
  releaseId: number;
  applicationSha: string;
  runId: number;
  attempt: number;
  workflowPath: string;
  producers: readonly {
    jobId: number;
    jobName: string;
    artifactId: number;
    name: string;
    sha256: string;
  }[];
  bodySha256?: string;
}
export const RECOVERY_TOOLING_TAG = 'release-tooling-v2.17.6-recovery-payloads';
export const RECOVERY_216 = {
  repository: RECOVERY.repository,
  tag: 'v2.17.6',
  applicationSha: 'b54020c17cc2624668fed77d5c8e98698866da59',
  runId: 37577692624,
  attempt: 1,
  workflowPath: RECOVERY.workflowPath,
  producers: [
    {
      jobId: 112650170287,
      jobName: 'release-win x64',
      artifactId: 11462824999,
      name: 'draft-win32-x64-1',
      sha256: '92a6b30ec214240df1f2742060cfe993d858526b11c42f0ef51b0ac6b3a2ea91',
    },
    {
      jobId: 112650170504,
      jobName: 'release-linux x64',
      artifactId: 11463970958,
      name: 'draft-linux-x64-1',
      sha256: '8333136e6a2302635d3d115f1e1b0f91d4258e8c0af08c0c138ca505aab550be',
    },
    {
      jobId: 112650170568,
      jobName: 'release-win arm64',
      artifactId: 11464495471,
      name: 'draft-win32-arm64-1',
      sha256: '25fa49f05f668bcc2ac38e0960391c9c811c2ec3186bdf506768a04d0c8714c8',
    },
  ],
} as const;
export function recovery216Binding(
  draftId: string | undefined,
  bodySha256: string | undefined
): RecoveryBinding {
  requireThat(
    /^[1-9]\d*$/.test(draftId ?? '') && Number.isSafeInteger(Number(draftId)),
    'Reviewed positive numeric draft ID required'
  );
  requireThat(/^[a-f0-9]{64}$/.test(bodySha256 ?? ''), 'Reviewed draft body SHA256 required');
  requireThat(
    draftId === '405470107' &&
      bodySha256 === '766d954f403784e210bd868875487511a70b2851b9c3b6aa01b5882ebf119926',
    'Authorized draft ID/body pins required'
  );
  return { ...RECOVERY_216, releaseId: Number(draftId), bodySha256 };
}
export async function validateRecoveryTooling(
  port: RecoveryPort,
  env: NodeJS.ProcessEnv
): Promise<void> {
  requireThat(
    env.GITHUB_REPOSITORY === RECOVERY.repository &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REF === `refs/tags/${RECOVERY_TOOLING_TAG}` &&
      /^[a-f0-9]{40}$/.test(env.EXPECTED_TOOLING_SHA ?? '') &&
      env.GITHUB_SHA === env.EXPECTED_TOOLING_SHA,
    'Canonical recovery workflow/tooling SHA required'
  );
  const tooling = await port.json<{ sha: string }>(
    `repos/${RECOVERY.repository}/commits/${RECOVERY_TOOLING_TAG}`
  );
  requireThat(tooling.sha === env.EXPECTED_TOOLING_SHA, 'Recovery tooling tag changed');
}
type StoredAsset = Asset & { state: string };
interface ProducerJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string;
  steps: {
    name: string;
    status: string;
    conclusion: string;
    started_at: string;
    completed_at: string;
  }[];
}
interface ProducerArtifact {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
  created_at: string;
  workflow_run: { id: number; head_sha: string; repository_id: number; head_repository_id: number };
}
export interface RecoveryPort {
  json<T>(endpoint: string): Promise<T>;
  archive(id: number, destination: string): Promise<void>;
  extract(archive: string, directory: string, expected: string[]): Promise<void>;
  verifyBuild(repository: string, sha: string, proof: BuildProof, mode: 'carry-mac'): Promise<void>;
  upload(repository: string, releaseId: number, file: string): Promise<void>;
}
async function command(executable: string, args: string[], destination?: string): Promise<string> {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [],
    errors: Buffer[] = [];
  const timer = setTimeout(() => child.kill(), destination ? 600_000 : 30_000);
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${executable} failed (${code}): ${Buffer.concat(errors).toString()}`))
    );
  }).finally(() => clearTimeout(timer));
  if (destination)
    await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
      done,
    ]);
  else {
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    await done;
  }
  return Buffer.concat(output).toString();
}
export function recoveryPort(): RecoveryPort {
  const release = new GitHubReleasePort();
  return {
    async json<T>(endpoint: string): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return JSON.parse(await command('gh', ['api', endpoint])) as T;
        } catch (error) {
          if (
            attempt >= 2 ||
            !(error instanceof Error) ||
            !/\(HTTP (?:408|429|5\d\d)\)/.test(error.message)
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    },
    async archive(id, destination) {
      await command(
        'gh',
        ['api', `repos/${RECOVERY.repository}/actions/artifacts/${id}/zip`],
        destination
      );
    },
    async extract(archive, directory, expected) {
      const names = (await command('unzip', ['-Z1', archive])).trim().split('\n');
      requireThat(
        canonical([...names].sort((a, b) => a.localeCompare(b, 'en'))) ===
          canonical([...expected].sort((a, b) => a.localeCompare(b, 'en'))),
        'Artifact archive payload names mismatch'
      );
      await command('unzip', ['-q', '-n', archive, '-d', directory]);
    },
    verifyBuild: (repository, sha, proof, mode) =>
      release.verifyBuild(repository, sha, proof, mode),
    upload: (repository, id, file) => release.upload(repository, id, file),
  };
}
function payloadNames(index: number, binding: RecoveryBinding): string[] {
  const names = platformNames(binding.tag.slice(1));
  if (index === 1) return names.linux;
  const name = names.windows[index === 0 ? 0 : 1];
  requireThat(name, 'Windows payload name missing');
  return [name, `${name}.blockmap`];
}
export async function validateProducer(
  port: RecoveryPort,
  index: number,
  binding: RecoveryBinding = RECOVERY
): Promise<void> {
  const pin = binding.producers[index];
  requireThat(pin, 'Unknown producer');
  const prefix = `repos/${binding.repository}`;
  const job = await port.json<ProducerJob>(`${prefix}/actions/jobs/${pin.jobId}`);
  const artifact = await port.json<ProducerArtifact>(
    `${prefix}/actions/artifacts/${pin.artifactId}`
  );
  requireThat(
    job.id === pin.jobId &&
      job.run_id === binding.runId &&
      job.run_attempt === binding.attempt &&
      job.head_sha === binding.applicationSha &&
      job.name === pin.jobName &&
      job.status === 'completed' &&
      job.conclusion === 'success',
    'Original producer job identity mismatch'
  );
  const uploads = job.steps.filter((step) => step.name === 'Upload immutable producer payloads');
  const upload = uploads[0];
  requireThat(
    uploads.length === 1 && upload?.status === 'completed' && upload.conclusion === 'success',
    'Original producer upload did not succeed'
  );
  const created = Date.parse(artifact.created_at),
    start = Date.parse(upload.started_at),
    end = Date.parse(upload.completed_at);
  requireThat(
    [created, start, end].every(Number.isFinite) &&
      start <= end &&
      created >= start &&
      created < end + 1000,
    'Artifact upload lineage mismatch'
  );
  requireThat(
    artifact.id === pin.artifactId &&
      artifact.name === pin.name &&
      artifact.digest === `sha256:${pin.sha256}` &&
      !artifact.expired &&
      artifact.workflow_run.id === binding.runId &&
      artifact.workflow_run.head_sha === binding.applicationSha &&
      artifact.workflow_run.repository_id === 1163183284 &&
      artifact.workflow_run.head_repository_id === 1163183284,
    'Original producer artifact identity mismatch'
  );
}
async function boundDraft(port: RecoveryPort, binding: RecoveryBinding): Promise<StoredAsset[]> {
  const prefix = `repos/${binding.repository}`;
  const release = await port.json<Release>(`${prefix}/releases/${binding.releaseId}`);
  requireThat(
    release.id === binding.releaseId &&
      release.tag_name === binding.tag &&
      release.target_commitish === binding.applicationSha &&
      release.draft === true &&
      release.prerelease === false &&
      (!binding.bodySha256 ||
        (release.name === binding.tag &&
          typeof release.body === 'string' &&
          createHash('sha256').update(release.body).digest('hex') === binding.bodySha256)),
    'Bound draft identity changed'
  );
  const refs = await port.json<{ ref: string }[]>(
    `${prefix}/git/matching-refs/tags/${binding.tag}`
  );
  const tagExists = refs.some((ref) => ref.ref === `refs/tags/${binding.tag}`);
  requireThat(!binding.bodySha256 || tagExists, 'Existing target application tag required');
  if (tagExists) {
    const tag = await port.json<{ sha: string }>(`${prefix}/commits/${binding.tag}`);
    requireThat(tag.sha === binding.applicationSha, 'Existing target tag application SHA changed');
  }
  const assets: StoredAsset[] = [];
  for (let page = 1; ; page++) {
    const batch = await port.json<StoredAsset[]>(
      `${prefix}/releases/${binding.releaseId}/assets?per_page=100&page=${page}`
    );
    requireThat(Array.isArray(batch), 'Invalid asset list');
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  requireThat(
    assets.every(
      (asset) =>
        Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        Number.isSafeInteger(asset.size) &&
        asset.size >= 0 &&
        typeof asset.name === 'string' &&
        asset.name.length > 0 &&
        /^sha256:[a-f0-9]{64}$/.test(asset.digest) &&
        asset.state === 'uploaded'
    ) &&
      new Set(assets.map((asset) => asset.id)).size === assets.length &&
      new Set(assets.map((asset) => asset.name)).size === assets.length,
    'Draft contains incomplete or ambiguous asset metadata'
  );
  return assets;
}
function snapshot(assets: StoredAsset[]): string {
  return canonical(
    assets
      .map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state }))
      .sort((a, b) => a.id - b.id)
  );
}
export async function recoverDraftPayloads(
  port: RecoveryPort,
  directory: string,
  binding: RecoveryBinding = RECOVERY
): Promise<void> {
  const proof = {
    runId: binding.runId,
    attempt: binding.attempt,
    jobIds: binding.producers.map((pin) => pin.jobId),
  };
  await port.verifyBuild(binding.repository, binding.applicationSha, proof, 'carry-mac');
  const run = await port.json<GitHubBuildRun & { id: number; status: string; conclusion: string }>(
    `repos/${binding.repository}/actions/runs/${binding.runId}`
  );
  requireThat(
    run.id === binding.runId &&
      run.path === binding.workflowPath &&
      run.event === 'workflow_dispatch' &&
      run.head_sha === binding.applicationSha &&
      run.run_attempt === binding.attempt &&
      run.status === 'completed' &&
      (!binding.bodySha256 || run.conclusion === 'success'),
    'Original build run identity mismatch'
  );
  const baseline = await boundDraft(port, binding);
  const payloads = path.join(directory, 'payloads');
  await mkdir(payloads, { recursive: true });
  for (const [index, pin] of binding.producers.entries()) {
    await validateProducer(port, index, binding);
    const archive = path.join(directory, `${pin.artifactId}.zip`);
    await port.archive(pin.artifactId, archive);
    await verifyArtifactArchive(archive, pin.sha256);
    await port.extract(archive, payloads, payloadNames(index, binding));
  }
  await port.verifyBuild(binding.repository, binding.applicationSha, proof, 'carry-mac');
  await appendDraftPayloads(port, directory, baseline, binding);
}
export async function verifyArtifactArchive(archive: string, sha256: string): Promise<void> {
  requireThat(
    (await fileProof(archive, path.basename(archive))).sha256 === sha256,
    'Downloaded artifact ZIP digest mismatch'
  );
}
export async function appendDraftPayloads(
  port: RecoveryPort,
  directory: string,
  baseline: StoredAsset[],
  binding: RecoveryBinding = RECOVERY
): Promise<void> {
  requireThat(
    snapshot(await boundDraft(port, binding)) === snapshot(baseline),
    'Draft assets changed while recovering archives'
  );
  const payloads = path.join(directory, 'payloads');
  const names = binding.producers
    .flatMap((_, index) => payloadNames(index, binding))
    .sort((a, b) => a.localeCompare(b, 'en'));
  requireThat(
    canonical((await readdir(payloads)).sort((a, b) => a.localeCompare(b, 'en'))) ===
      canonical(names),
    'Unexpected or missing recovered payload'
  );
  const proofs = [];
  for (const name of names) {
    requireThat(
      (await lstat(path.join(payloads, name))).isFile(),
      'Recovered payload is not a regular file'
    );
    proofs.push(await fileProof(path.join(payloads, name), name));
  }
  const provenance = {
    schemaVersion: 1,
    applicationSha: binding.applicationSha,
    tag: binding.tag,
    runId: binding.runId,
    attempt: binding.attempt,
    jobs: binding.producers.map((pin) => ({
      id: pin.jobId,
      name: pin.jobName,
      conclusion: 'success',
      run_id: binding.runId,
    })),
    workflowPath: binding.workflowPath,
    payloads: proofs.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  const evidence = path.join(directory, `build-provenance-${binding.runId}-1.json`);
  await writeFile(evidence, `${canonical(provenance)}\n`, { flag: 'wx' });
  const files = [
    ...proofs.map((item) => ({ proof: item, file: path.join(payloads, item.name) })),
    { proof: await fileProof(evidence, path.basename(evidence)), file: evidence },
  ];
  for (const { proof: item } of files) {
    const matches = baseline.filter((asset) => asset.name === item.name);
    requireThat(
      matches.length <= 1 &&
        matches.every(
          (asset) =>
            asset.digest === `sha256:${item.sha256}` &&
            asset.size === item.size &&
            asset.state === 'uploaded'
        ),
      `Asset collision: ${item.name}`
    );
  }
  let expected = baseline;
  for (const { proof: item, file } of files) {
    const before = await boundDraft(port, binding);
    requireThat(snapshot(before) === snapshot(expected), 'Draft asset snapshot changed');
    if (before.some((asset) => asset.name === item.name)) continue;
    let uploadError: unknown;
    try {
      await port.upload(binding.repository, binding.releaseId, file);
    } catch (error) {
      uploadError = error;
    }
    const after = await boundDraft(port, binding),
      added = after.filter((asset) => !before.some((old) => old.id === asset.id));
    const asset = added[0];
    requireThat(
      added.length === 1 &&
        asset?.name === item.name &&
        asset.size === item.size &&
        asset.digest === `sha256:${item.sha256}` &&
        asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.id) &&
        asset.id > 0,
      uploadError instanceof Error ? uploadError.message : 'Uploaded asset proof mismatch'
    );
    expected = [...before, asset];
    requireThat(
      snapshot(after) === snapshot(expected),
      'Draft asset snapshot changed during upload'
    );
  }
  requireThat(
    snapshot(await boundDraft(port, binding)) === snapshot(expected),
    'Final draft snapshot changed'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const binding = recovery216Binding(
    process.env.EXPECTED_DRAFT_ID,
    process.env.EXPECTED_BODY_SHA256
  );
  const port = recoveryPort();
  await validateRecoveryTooling(port, process.env);
  requireThat(process.argv[2], 'Recovery directory required');
  await recoverDraftPayloads(port, process.argv[2], binding);
}
