import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { canonical, checkInput, digest, fileProof } from '../../ci/release/contract.ts';
import { nativeReleaseScenario } from './native-release-scenario.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';

import type { StagePlan } from '../../ci/release/contract.ts';
import type { WindowsProducerJob } from './windows-plan-producer.mts';

const repository = '777genius/agent-teams-ai';
async function command(executable: 'gh' | 'unzip', arguments_: string[], destination: string) {
  const child = spawn(executable, arguments_, {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(300_000),
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32_768);
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}: ${stderr}`))
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
    exit,
  ]);
}
async function api<T>(endpoint: string, destination: string): Promise<T> {
  await command('gh', ['api', `repos/${repository}/${endpoint}`], destination);
  return JSON.parse(await readFile(destination, 'utf8')) as T;
}

export interface PreparedStageReceipt {
  repository: string;
  workflow: string;
  runId: number;
  attempt: number;
  jobId: number;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
  toolingSha: string;
  planDigest: string;
  inputDigest: string;
}

export interface PreparedStageAuthority {
  runId: number;
  attempt: number;
  artifactId: number;
  artifactSha256: string;
  toolingSha: string;
  planDigest: string;
}

// Both native consumers use the exact prepared producer, never a moving release/latest.
export async function downloadPreparedStageArtifact(
  output: string,
  options: PreparedStageAuthority
): Promise<{ plan: StagePlan; planFile: string; receipt: PreparedStageReceipt }> {
  const { runId, attempt, artifactId, artifactSha256, toolingSha, planDigest } = options;
  assert([runId, attempt, artifactId].every((value) => Number.isSafeInteger(value) && value > 0));
  assert(
    /^[a-f\d]{64}$/u.test(artifactSha256) &&
      /^[a-f\d]{64}$/u.test(planDigest) &&
      /^[a-f\d]{40}$/u.test(toolingSha)
  );
  const workflow = '.github/workflows/stage-existing-partial-draft.yml';
  const artifactName = 'existing-draft-stage-plan';
  const run = await api<{
    id: number;
    run_attempt: number;
    path: string;
    head_sha: string;
    status: string;
    conclusion: string;
    head_repository: { full_name: string };
  }>(`actions/runs/${runId}/attempts/${attempt}`, path.join(output, 'producer-run.json'));
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.path, workflow);
  assert.equal(run.head_sha, toolingSha);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  const jobs = await api<{
    jobs: WindowsProducerJob[];
  }>(
    `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    path.join(output, 'producer-jobs.json')
  );
  const jobName = 'assemble-draft';
  const stepName = 'Persist immutable metadata plan';
  const successful = jobs.jobs.filter(
    (job) => job.name === jobName && job.status === 'completed' && job.conclusion === 'success'
  );
  assert.equal(successful.length, 1);
  const job = successful[0];
  assert(job);
  const artifact = await api<{
    id: number;
    name: string;
    expired: boolean;
    digest: string;
    created_at: string;
    workflow_run: { id: number; head_sha: string };
  }>(`actions/artifacts/${artifactId}`, path.join(output, 'producer-artifact.json'));
  assert.equal(artifact.id, artifactId);
  assert.equal(artifact.name, artifactName);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, `sha256:${artifactSha256}`);
  assert.equal(artifact.workflow_run.id, runId);
  assert.equal(artifact.workflow_run.head_sha, toolingSha);
  validateWindowsProducerUpload(job, runId, stepName, artifact.created_at);
  const zip = path.join(output, 'producer.zip');
  await command('gh', ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`], zip);
  assert.equal((await fileProof(zip, 'producer.zip')).sha256, artifactSha256);
  await command('unzip', ['-p', zip, 'stage-plan.json'], path.join(output, 'plan.json'));
  const plan = JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8')) as StagePlan;
  assert.equal(plan.schemaVersion, 1);
  checkInput(plan.input);
  assert.equal((await fileProof(path.join(output, 'plan.json'), 'plan.json')).sha256, planDigest);
  assert.equal(plan.input.toolingSha, toolingSha);
  nativeReleaseScenario(plan);
  await command('unzip', ['-p', zip, 'stage-plan.sha256'], path.join(output, 'stage-plan.sha256'));
  assert.equal((await readFile(path.join(output, 'stage-plan.sha256'), 'utf8')).trim(), planDigest);
  await unlink(zip);
  const receipt: PreparedStageReceipt = {
    repository,
    workflow,
    runId,
    attempt,
    jobId: job.id,
    artifactId,
    artifactName,
    artifactSha256,
    toolingSha,
    planDigest,
    inputDigest: digest(canonical(plan.input)),
  };
  return { plan, planFile: path.join(output, 'plan.json'), receipt };
}
