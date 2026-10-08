import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './inputs.mts';
import { planCommand } from './windows-plan-command.mts';
import { validateW11DiagnosticUpload } from './windows-diagnostic-upload.mts';
import type { WindowsProducerJob } from './windows-plan-producer.mts';

const repository = '777genius/agent-teams-ai';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(process.env.GITHUB_JOB, 'windows-ota');
const output = path.resolve('.artifacts/TEST-windows-inputs');
await mkdir(output, { recursive: true });
async function api<T>(endpoint: string, name: string): Promise<T> {
  const file = path.join(output, name);
  await planCommand('gh', ['api', `repos/${repository}/${endpoint}`], file);
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
const run = await api<{
  id: number;
  run_attempt: number;
  head_sha: string;
  path: string;
  head_repository: { full_name: string };
  status: string;
}>('actions/runs/37704738528', 'reuse-run.json');
assert.equal(run.id, 37704738528);
assert.equal(run.run_attempt, 1);
assert.equal(run.head_sha, '87c576272e8366e733381a56ad7607d08114fb70');
assert.equal(run.path, '.github/workflows/updater-windows-ota.yml');
assert.equal(run.head_repository.full_name, repository);
assert.equal(run.status, 'completed'); // OTA failed; only the verified input upload is reusable.
const jobs = await api<{ jobs: WindowsProducerJob[] }>(
  'actions/runs/37704738528/attempts/1/jobs?per_page=100',
  'reuse-jobs.json'
);
const upload = jobs.jobs.filter(
  (job) =>
    job.name === 'verified-windows-inputs' &&
    job.status === 'completed' &&
    job.conclusion === 'success'
);
assert.equal(upload.length, 1);
const artifact = await api<{
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  digest: string;
  created_at: string;
  workflow_run: { id: number; head_sha: string };
}>('actions/artifacts/11519836033', 'reuse-artifact.json');
assert.equal(artifact.id, 11519836033);
assert.equal(artifact.name, 'TEST-windows-ota-inputs-37704738528-1');
assert.equal(artifact.expired, false);
assert.equal(artifact.size_in_bytes, 874799445);
assert.equal(
  artifact.digest,
  'sha256:f527dc188ebd821b243b84c4531d719bc700474df977111f0a6958dc25ff20f1'
);
assert.equal(artifact.workflow_run.id, run.id);
assert.equal(artifact.workflow_run.head_sha, run.head_sha);
assert(upload[0]);
const uploadLog = path.join(output, 'reuse-upload.log');
await planCommand(
  'gh',
  ['api', '--allow-escape-sequences', `repos/${repository}/actions/jobs/${upload[0].id}/logs`],
  uploadLog
);
validateW11DiagnosticUpload(upload[0], artifact.created_at, await readFile(uploadLog, 'utf8'));
const zip = path.join(output, 'reuse.zip');
await planCommand(
  'gh',
  ['api', '--allow-escape-sequences', `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
  zip,
  900_000
);
assert.equal((await hashFile(zip)).sha256, artifact.digest.slice(7));
const listing = path.join(output, 'reuse-entries.txt');
await planCommand('tar', ['-tf', zip], listing);
const entries = (await readFile(listing, 'utf8')).trim().split(/\r?\n/u);
assert(
  entries.length > 0 &&
    entries.every(
      (name) =>
        !path.posix.isAbsolute(name) && !/[\\:]/u.test(name) && !name.split('/').includes('..')
    )
);
await planCommand('tar', ['-xf', zip, '-C', output], path.join(output, 'reuse-extract.log'));
assert.equal(
  (await hashFile(path.join(output, 'plan.json'))).sha256,
  '87207cedd0bf2a8a7fcee0ea44c876a04acea0873c30553b9da26bafa62f4c91'
);
