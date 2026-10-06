import { spawn } from 'node:child_process';
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
  tag: 'v2.17.5',
  releaseId: 404985707,
  applicationSha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
  runId: 37498376671,
  attempt: 1,
  workflowPath: '.github/workflows/build-linux-windows-draft.yml',
  producers: [
    {
      jobId: 112388693906,
      jobName: 'release-win x64',
      artifactId: 11430140734,
      name: 'draft-win32-x64-1',
      sha256: 'eea6e28347c43fb41db3f744021d619d166d979d8a77ea875e50c679d3d3dea7',
    },
    {
      jobId: 112388693295,
      jobName: 'release-linux x64',
      artifactId: 11429846886,
      name: 'draft-linux-x64-1',
      sha256: '9d8ecea50fb80e4850ba742900cd60d8c1271b0e28471da4af6e5884665b86f6',
    },
    {
      jobId: 112388693609,
      jobName: 'release-win arm64',
      artifactId: 11428504853,
      name: 'draft-win32-arm64-1',
      sha256: 'e7f6e8997e559bd409b2e33479bdc68ea9035c729efb1cd5898b385126ee68a0',
    },
  ],
} as const;
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
function payloadNames(index: number): string[] {
  const names = platformNames('2.17.5');
  if (index === 1) return names.linux;
  const name = names.windows[index === 0 ? 0 : 1];
  requireThat(name, 'Windows payload name missing');
  return [name, `${name}.blockmap`];
}
export async function validateProducer(port: RecoveryPort, index: number): Promise<void> {
  const pin = RECOVERY.producers[index];
  requireThat(pin, 'Unknown producer');
  const prefix = `repos/${RECOVERY.repository}`;
  const job = await port.json<ProducerJob>(`${prefix}/actions/jobs/${pin.jobId}`);
  const artifact = await port.json<ProducerArtifact>(
    `${prefix}/actions/artifacts/${pin.artifactId}`
  );
  requireThat(
    job.id === pin.jobId &&
      job.run_id === RECOVERY.runId &&
      job.run_attempt === 1 &&
      job.head_sha === RECOVERY.applicationSha &&
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
      artifact.workflow_run.id === RECOVERY.runId &&
      artifact.workflow_run.head_sha === RECOVERY.applicationSha &&
      artifact.workflow_run.repository_id === 1163183284 &&
      artifact.workflow_run.head_repository_id === 1163183284,
    'Original producer artifact identity mismatch'
  );
}
async function boundDraft(port: RecoveryPort): Promise<StoredAsset[]> {
  const prefix = `repos/${RECOVERY.repository}`;
  const release = await port.json<Release>(`${prefix}/releases/${RECOVERY.releaseId}`);
  requireThat(
    release.id === RECOVERY.releaseId &&
      release.tag_name === RECOVERY.tag &&
      release.target_commitish === RECOVERY.applicationSha &&
      release.draft === true &&
      release.prerelease === false,
    'Bound draft identity changed'
  );
  const refs = await port.json<{ ref: string }[]>(
    `${prefix}/git/matching-refs/tags/${RECOVERY.tag}`
  );
  if (refs.some((ref) => ref.ref === `refs/tags/${RECOVERY.tag}`)) {
    const tag = await port.json<{ sha: string }>(`${prefix}/commits/${RECOVERY.tag}`);
    requireThat(tag.sha === RECOVERY.applicationSha, 'Existing target tag application SHA changed');
  }
  const assets: StoredAsset[] = [];
  for (let page = 1; ; page++) {
    const batch = await port.json<StoredAsset[]>(
      `${prefix}/releases/${RECOVERY.releaseId}/assets?per_page=100&page=${page}`
    );
    requireThat(Array.isArray(batch), 'Invalid asset list');
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}
function snapshot(assets: StoredAsset[]): string {
  return canonical(
    assets
      .map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state }))
      .sort((a, b) => a.id - b.id)
  );
}
export async function recoverDraftPayloads(port: RecoveryPort, directory: string): Promise<void> {
  const proof = {
    runId: RECOVERY.runId,
    attempt: RECOVERY.attempt,
    jobIds: RECOVERY.producers.map((pin) => pin.jobId),
  };
  await port.verifyBuild(RECOVERY.repository, RECOVERY.applicationSha, proof, 'carry-mac');
  const run = await port.json<GitHubBuildRun & { id: number; status: string }>(
    `repos/${RECOVERY.repository}/actions/runs/${RECOVERY.runId}`
  );
  requireThat(
    run.id === RECOVERY.runId &&
      run.path === RECOVERY.workflowPath &&
      run.event === 'workflow_dispatch' &&
      run.head_sha === RECOVERY.applicationSha &&
      run.run_attempt === 1 &&
      run.status === 'completed',
    'Original build run identity mismatch'
  );
  const baseline = await boundDraft(port);
  const payloads = path.join(directory, 'payloads');
  await mkdir(payloads, { recursive: true });
  for (const [index, pin] of RECOVERY.producers.entries()) {
    await validateProducer(port, index);
    const archive = path.join(directory, `${pin.artifactId}.zip`);
    await port.archive(pin.artifactId, archive);
    await verifyArtifactArchive(archive, pin.sha256);
    await port.extract(archive, payloads, payloadNames(index));
  }
  await port.verifyBuild(RECOVERY.repository, RECOVERY.applicationSha, proof, 'carry-mac');
  await appendDraftPayloads(port, directory, baseline);
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
  baseline: StoredAsset[]
): Promise<void> {
  requireThat(
    snapshot(await boundDraft(port)) === snapshot(baseline),
    'Draft assets changed while recovering archives'
  );
  const payloads = path.join(directory, 'payloads');
  const names = RECOVERY.producers
    .flatMap((_, index) => payloadNames(index))
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
    applicationSha: RECOVERY.applicationSha,
    tag: RECOVERY.tag,
    runId: RECOVERY.runId,
    attempt: RECOVERY.attempt,
    jobs: RECOVERY.producers.map((pin) => ({
      id: pin.jobId,
      name: pin.jobName,
      conclusion: 'success',
      run_id: RECOVERY.runId,
    })),
    workflowPath: RECOVERY.workflowPath,
    payloads: proofs.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  const evidence = path.join(directory, `build-provenance-${RECOVERY.runId}-1.json`);
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
    const before = await boundDraft(port);
    requireThat(snapshot(before) === snapshot(expected), 'Draft asset snapshot changed');
    if (before.some((asset) => asset.name === item.name)) continue;
    let uploadError: unknown;
    try {
      await port.upload(RECOVERY.repository, RECOVERY.releaseId, file);
    } catch (error) {
      uploadError = error;
    }
    const after = await boundDraft(port),
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
    snapshot(await boundDraft(port)) === snapshot(expected),
    'Final draft snapshot changed'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  requireThat(
    process.env.GITHUB_REPOSITORY === RECOVERY.repository &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.GITHUB_REF === 'refs/tags/release-tooling-v2.17.5-recovery' &&
      /^[a-f0-9]{40}$/.test(process.env.EXPECTED_TOOLING_SHA ?? '') &&
      process.env.GITHUB_SHA === process.env.EXPECTED_TOOLING_SHA,
    'Canonical recovery workflow/tooling SHA required'
  );
  requireThat(process.argv[2], 'Recovery directory required');
  await recoverDraftPayloads(recoveryPort(), process.argv[2]);
}
