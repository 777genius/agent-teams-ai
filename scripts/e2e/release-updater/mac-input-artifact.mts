import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { canonical, fileProof, MANIFEST, platformNames } from '../../ci/release/contract.ts';

import type { Release } from '../../ci/release/contract.ts';
import type { MacPreparedInputProof } from './mac-inputs.mts';

export const macInputProducerJob = 'prepare-mac-inputs';
export const macInputUploadStep = 'Upload authenticated immutable Mac inputs';
const repository = '777genius/agent-teams-ai';
export const macInputWorkflows = [
  '.github/workflows/updater-mac-updater.yml',
  '.github/workflows/updater-mac-old-updater.yml',
];
export function macInputArtifactName(runId: number, attempt: number) {
  return `TEST-mac-authenticated-inputs-${runId}-${attempt}`;
}
export interface MacInputBundle {
  schemaVersion: 1;
  repository: string;
  mode: 'preview' | 'staged';
  toolingSha: string;
  planSha256: string;
  inputDigest: string;
  runId: number;
  attempt: number;
  platforms: Record<'arm64' | 'x64', { source: Release; inputProof: MacPreparedInputProof }>;
}
export interface MacInputJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  steps: {
    name: string;
    status: string;
    conclusion: string;
    started_at: string;
    completed_at: string;
  }[];
}
export interface MacArtifactAuthority {
  run: {
    id: number;
    head_sha: string;
    run_attempt: number;
    path: string;
    event: string;
    status: string;
  };
  job: MacInputJob;
  attemptJobIds: number[];
  artifact: {
    id: number;
    name: string;
    digest: string;
    expired: boolean;
    created_at: string;
    workflow_run: { id: number; head_sha: string };
  };
  archiveSha256: string;
}
export interface MacArtifactExpected {
  artifactId: number;
  artifactSha256: string;
  toolingSha: string;
  runId: number;
  attempt: number;
  workflowPath: string;
}
export function checkMacArtifactAuthority(
  value: MacArtifactAuthority,
  expected: MacArtifactExpected
) {
  assert(macInputWorkflows.includes(expected.workflowPath));
  for (const id of [expected.artifactId, expected.runId, expected.attempt])
    assert(Number.isSafeInteger(id) && id > 0);
  assert(/^[a-f0-9]{40}$/.test(expected.toolingSha));
  assert(/^[a-f0-9]{64}$/.test(expected.artifactSha256));
  assert.equal(value.run.id, expected.runId);
  assert.equal(value.run.run_attempt, expected.attempt);
  assert.equal(value.run.head_sha, expected.toolingSha);
  assert.equal(value.run.path, expected.workflowPath);
  assert.equal(value.run.event, 'workflow_dispatch');
  // The producer completes before the dependent native matrix. The overall run can remain active.
  assert(['in_progress', 'completed'].includes(value.run.status));
  assert.equal(value.artifact.id, expected.artifactId);
  assert.equal(value.artifact.name, macInputArtifactName(expected.runId, expected.attempt));
  assert.equal(value.artifact.digest, `sha256:${expected.artifactSha256}`);
  assert.equal(value.archiveSha256, expected.artifactSha256);
  assert.equal(value.artifact.expired, false);
  assert.equal(value.artifact.workflow_run.id, expected.runId);
  assert.equal(value.artifact.workflow_run.head_sha, expected.toolingSha);
  assert(value.attemptJobIds.includes(value.job.id));
  assert.equal(value.job.run_id, expected.runId);
  assert.equal(value.job.name, macInputProducerJob);
  assert.equal(value.job.status, 'completed');
  assert.equal(value.job.conclusion, 'success');
  const uploads = value.job.steps.filter((step) => step.name === macInputUploadStep);
  assert.equal(uploads.length, 1);
  const upload = uploads[0];
  assert(upload);
  assert.equal(upload.status, 'completed');
  assert.equal(upload.conclusion, 'success');
  const jobStart = Date.parse(value.job.started_at);
  const jobEnd = Date.parse(value.job.completed_at);
  const start = Date.parse(upload.started_at);
  const end = Date.parse(upload.completed_at);
  const created = Date.parse(value.artifact.created_at);
  assert([jobStart, jobEnd, start, end, created].every(Number.isFinite));
  assert(
    jobStart <= start && start <= end && end <= jobEnd && created >= start && created < end + 1000
  );
}
const execute = promisify(execFile);
export async function macInputCommand(args: string[], executable = 'gh') {
  return (
    await execute(executable, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_777_216 })
  ).stdout;
}
async function api<T>(endpoint: string) {
  return JSON.parse(await macInputCommand(['api', endpoint])) as T;
}
async function streamCommand(executable: string, args: string[], destination: string) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${executable} transfer failed (${code})`))
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
    completion,
  ]);
}
export async function retrieveMacInputArtifact(expected: MacArtifactExpected, directory: string) {
  const run = await api<MacArtifactAuthority['run']>(
    `repos/${repository}/actions/runs/${expected.runId}`
  );
  const pages = JSON.parse(
    await macInputCommand([
      'api',
      `repos/${repository}/actions/runs/${expected.runId}/attempts/${expected.attempt}/jobs?per_page=100`,
      '--paginate',
      '--slurp',
    ])
  ) as { jobs: MacInputJob[] }[];
  const jobs = pages.flatMap((page) => page.jobs);
  const producers = jobs.filter((job) => job.name === macInputProducerJob);
  assert.equal(producers.length, 1);
  const job = producers[0];
  assert(job);
  const artifact = await api<MacArtifactAuthority['artifact']>(
    `repos/${repository}/actions/artifacts/${expected.artifactId}`
  );
  const authority = {
    run,
    job,
    artifact,
    attemptJobIds: jobs.map((job) => job.id),
    archiveSha256: expected.artifactSha256,
  };
  checkMacArtifactAuthority(authority, expected);
  await mkdir(directory);
  const archive = `${directory}.zip`;
  await streamCommand(
    'gh',
    ['api', `repos/${repository}/actions/artifacts/${expected.artifactId}/zip`],
    archive
  );
  authority.archiveSha256 = (await fileProof(archive, 'input-artifact.zip')).sha256;
  checkMacArtifactAuthority(authority, expected);
  const allowed = [
    'stage-plan.json',
    'mac-input-bundle.json',
    'prepared-run.json',
    'prepared-artifact.json',
  ];
  for (const architecture of ['arm64', 'x64']) {
    allowed.push(
      `${architecture}/source-latest-mac.yml`,
      `${architecture}/draft-latest-mac.yml`,
      `${architecture}/${MANIFEST}`
    );
    for (const name of platformNames('2.17.1').mac.filter((name) =>
      name.includes(`-${architecture}`)
    ))
      allowed.push(`${architecture}/${name}`);
  }
  const entries = (await macInputCommand(['-Z1', archive], 'unzip')).trim().split(/\r?\n/);
  assert.equal(new Set(entries).size, entries.length);
  for (const entry of entries)
    assert(allowed.includes(entry) || ['arm64/', 'x64/'].includes(entry));
  for (const entry of entries.filter((entry) => !entry.endsWith('/'))) {
    const destination = path.join(directory, entry);
    await mkdir(path.dirname(destination), { recursive: true });
    await streamCommand('unzip', ['-p', archive, entry], destination);
  }
  await writeFile(
    path.join(directory, 'validated-input-artifact.json'),
    `${canonical(authority)}\n`,
    { flag: 'wx' }
  );
  return authority;
}
