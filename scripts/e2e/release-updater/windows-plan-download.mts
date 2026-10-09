import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assetByName,
  canonical,
  checkInput,
  checkMetadata,
  checkRelease,
  digest,
  manifestFor,
  platformNames,
  textProof,
} from '../../ci/release/contract.ts';
import { authenticateWindowsExecutor } from './windows-execution-provenance.mts';
import { hashFile } from './inputs.mts';
import { checkNativePredecessor, nativeReleaseScenario } from './native-release-scenario.mts';
import { downloadPreparedStageArtifact } from './prepared-stage-download.mts';
import { artifactDownloadTimeout, planCommand as command } from './windows-plan-command.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';
import {
  planWindowsInputs,
  readWindowsStagePlan,
  windowsPredecessorPins,
} from './windows-plan-inputs.mts';

import type { Release, StagePlan } from '../../ci/release/contract.ts';
import type { WindowsProducerJob } from './windows-plan-producer.mts';

const repository = '777genius/agent-teams-ai';
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  assert(index >= 0 && value && !value.startsWith('--'), `Required ${name}`);
  return value;
}
function positive(name: string) {
  const raw = option(name);
  assert(/^[1-9]\d*$/u.test(raw));
  const value = Number(raw);
  assert(Number.isSafeInteger(value));
  return value;
}
async function api<T>(endpoint: string, destination: string): Promise<T> {
  await command('gh', ['api', `repos/${repository}/${endpoint}`], destination);
  return JSON.parse(await readFile(destination, 'utf8')) as T;
}

interface ProducerReceipt {
  repository: string;
  workflow: string;
  runId: number;
  attempt: number;
  jobId: number;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
  toolingSha: string;
  executionSha?: string;
  planDigest: string;
  inputDigest: string;
}
async function downloadTrustedArtifact(
  output: string,
  kind: 'prepared' | 'native'
): Promise<ProducerReceipt> {
  const runId = positive('--run-id'),
    attempt = positive('--run-attempt'),
    artifactId = positive('--artifact-id');
  const artifactSha256 = option('--artifact-sha256'),
    toolingSha = option('--tooling-sha'),
    planDigest = option('--plan-digest');
  assert(
    /^[a-f\d]{64}$/u.test(artifactSha256) &&
      /^[a-f\d]{64}$/u.test(planDigest) &&
      /^[a-f\d]{40}$/u.test(toolingSha)
  );
  const executionIndex = args.indexOf('--execution-sha');
  const execution = authenticateWindowsExecutor(
    toolingSha,
    executionIndex < 0 ? toolingSha : option('--execution-sha')
  );
  if (kind === 'prepared') {
    const prepared = await downloadPreparedStageArtifact(output, {
      runId,
      attempt,
      artifactId,
      artifactSha256,
      toolingSha,
      planDigest,
    });
    return { ...prepared.receipt, executionSha: execution.executionSha };
  }
  const workflow = '.github/workflows/prepare-updater-native-inputs.yml';
  const artifactName = 'TEST-windows-native-inputs';
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
  const jobName = 'prepare-windows-inputs';
  const stepName = 'Upload immutable Windows native inputs';
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
    size_in_bytes: number;
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
  await command(
    'gh',
    ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
    zip,
    artifactDownloadTimeout(artifact.size_in_bytes)
  );
  assert.equal((await hashFile(zip)).sha256, artifactSha256);
  await command('unzip', ['-p', zip, 'plan.json'], path.join(output, 'plan.json'));
  const plan = JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8')) as StagePlan;
  assert.equal(plan.schemaVersion, 1);
  checkInput(plan.input);
  assert.equal((await hashFile(path.join(output, 'plan.json'))).sha256, planDigest);
  assert.equal(plan.input.toolingSha, toolingSha);
  const { targetVersion } = nativeReleaseScenario(plan);
  const names = [
    ...windowsPredecessorPins.map((pin) => pin.name),
    ...platformNames(targetVersion).windows.flatMap((name) => [name, `${name}.blockmap`]),
    'source-api.json',
    'draft-api.json',
    'latest.yml',
    'release-platform-manifest.json',
    'prepared-receipt.json',
  ];
  for (const name of names) await command('unzip', ['-p', zip, name], path.join(output, name));
  const prepared = JSON.parse(
    await readFile(path.join(output, 'prepared-receipt.json'), 'utf8')
  ) as ProducerReceipt;
  assert.equal(prepared.repository, repository);
  assert.equal(prepared.workflow, '.github/workflows/stage-existing-partial-draft.yml');
  assert.equal(prepared.toolingSha, toolingSha);
  assert.equal(prepared.planDigest, planDigest);
  assert.equal(prepared.inputDigest, digest(canonical(plan.input)));
  await unlink(zip);
  return {
    repository,
    workflow,
    runId,
    attempt,
    jobId: job.id,
    artifactId,
    artifactName,
    artifactSha256,
    toolingSha,
    executionSha: execution.executionSha,
    planDigest,
    inputDigest: digest(canonical(plan.input)),
  };
}

async function downloadAsset(release: Release, name: string, output: string) {
  const asset = assetByName(release, name);
  assert(Number.isSafeInteger(asset.id) && asset.id > 0, 'Exact numeric release asset ID required');
  await command(
    'gh',
    [
      'api',
      `repos/${repository}/releases/assets/${asset.id}`,
      '-H',
      'Accept: application/octet-stream',
    ],
    path.join(output, name)
  );
}

async function prepare() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const output = path.resolve(option('--output'));
  assert(path.basename(output).startsWith('TEST-windows-'));
  await mkdir(output, { recursive: true });
  const kind = option('--kind');
  assert(kind === 'prepared' || kind === 'native');
  const receipt = await downloadTrustedArtifact(output, kind);
  const planFile = path.join(output, 'plan.json');
  const plan = await readWindowsStagePlan(planFile);
  const { targetVersion, predecessor } = nativeReleaseScenario(plan);
  if (kind === 'prepared') {
    const source = await api<Release>(
      `releases/${predecessor.id}`,
      path.join(output, 'source-api.json')
    );
    const target = await api<Release>(
      `releases/${plan.input.target.id}`,
      path.join(output, 'draft-api.json')
    );
    checkNativePredecessor(plan, source);
    checkRelease(target, plan.input.target, true);
    const feed = plan.feeds['latest.yml'];
    assert(typeof feed === 'string');
    for (const expected of [
      textProof('latest.yml', feed),
      textProof('release-platform-manifest.json', `${canonical(manifestFor(plan))}\n`),
    ]) {
      const asset = target.assets.find((item) => item.name === expected.name);
      assert(
        asset,
        `Draft has not staged actual ${expected.name}; preview feeds are not native acceptance`
      );
      checkMetadata(asset, expected);
      await downloadAsset(target, expected.name, output);
    }
    const sourceNames: string[] = windowsPredecessorPins.map((pin) => pin.name);
    const targetNames = platformNames(targetVersion).windows.flatMap((name) => [
      name,
      `${name}.blockmap`,
    ]);
    for (const name of [...sourceNames, ...targetNames]) {
      const release = sourceNames.includes(name) ? source : target;
      await downloadAsset(release, name, output);
    }
  }
  const inputs = await planWindowsInputs(output, planFile);
  assert.equal(await readFile(path.join(output, 'latest.yml'), 'utf8'), inputs.feed);
  await writeFile(
    path.join(output, kind === 'prepared' ? 'prepared-receipt.json' : 'native-receipt.json'),
    JSON.stringify(receipt, null, 2),
    { flag: 'wx' }
  );
  await writeFile(
    path.join(output, 'windows-input-verification.json'),
    JSON.stringify({ ...inputs, passed: true }, null, 2)
  );
  process.stdout.write(
    `${JSON.stringify({ inputDigest: inputs.inputDigest, planDigest: receipt.planDigest, targetVersion: inputs.targetVersion, receipt })}\n`
  );
}
await prepare();
