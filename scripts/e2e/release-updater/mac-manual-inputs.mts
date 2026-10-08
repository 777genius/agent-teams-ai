import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  canonical,
  assetByName,
  checkMetadata,
  checkRelease,
  digest,
  fileProof,
  platformNames,
  sameProof,
  releaseSnapshot,
} from '../../ci/release/contract.ts';
import { GitHubReleasePort } from '../../ci/release/github.ts';
import { downloadGithubFile } from './github-download.mts';
import { macInputCommand } from './mac-input-artifact.mts';
import { checkMacAssetSnapshot } from './mac-inputs.mts';
import { nativePredecessor, nativeReleaseScenario } from './native-release-scenario.mts';
import { downloadPreparedStageArtifact } from './prepared-stage-download.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';

import type { Asset, FileProof, Release, StagePlan } from '../../ci/release/contract.ts';
import type { MacArtifactAuthority } from './mac-input-artifact.mts';
import type { PreparedStageAuthority, PreparedStageReceipt } from './prepared-stage-download.mts';

export const manualWorkflow = '.github/workflows/updater-mac-manual-migration.yml';
export const manualProducer = 'prepare-mac-manual-inputs';
export const manualUpload = 'Upload authenticated manual migration inputs';
const repository = '777genius/agent-teams-ai';
export const oldManualDmg = {
  arm64: {
    id: 595801616,
    size: 249856838,
    sha256: 'ef028b523ace7635abdbd050687b816de78bd887eea4d87a79919b8ea401756e',
  },
  x64: {
    id: 595811076,
    size: 259656716,
    sha256: '7a6f2700813940bdc379bd01db568999099c19bda40383ac3e01241ee305de6d',
  },
} as const;
export interface ManualBundle {
  schemaVersion: 1;
  toolingSha: string;
  planDigest: string;
  inputDigest: string;
  sourceSha: string;
  runId: number;
  attempt: number;
  prepared: PreparedStageReceipt;
  downloads: {
    architecture: 'arm64' | 'x64';
    releaseId: number;
    assetId: number;
    proof: FileProof;
  }[];
}
export function manualNames(architecture: 'arm64' | 'x64') {
  const names = platformNames('2.17.10').mac.filter((name) => name.includes(`-${architecture}`));
  const dmg = names.find((name) => name.endsWith('.dmg'));
  const zip = names.find((name) => name.endsWith('.zip'));
  assert(dmg && zip);
  return { dmg, zip, old: `Agent.Teams.AI-2.17.1-${architecture}.dmg` };
}
export function checkManualContext(env: NodeJS.ProcessEnv, toolingSha: string) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF?.split('@')[0], `${repository}/${manualWorkflow}`);
  assert(/^[a-f0-9]{40}$/.test(toolingSha));
  assert.equal(env.GITHUB_SHA, toolingSha);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    assert(Number.isSafeInteger(Number(env[name])) && Number(env[name]) > 0);
}
export function checkManualBundle(
  bundle: ManualBundle,
  plan: StagePlan,
  expected: {
    toolingSha: string;
    planDigest: string;
    inputDigest: string;
    runId: number;
    attempt: number;
  }
) {
  assert.equal(nativeReleaseScenario(plan).targetVersion, '2.17.10');
  assert.equal(bundle.schemaVersion, 1);
  for (const key of ['toolingSha', 'planDigest', 'inputDigest', 'runId', 'attempt'] as const)
    assert.equal(bundle[key], expected[key]);
  assert.equal(bundle.toolingSha, plan.input.toolingSha);
  assert.equal(bundle.inputDigest, digest(canonical(plan.input)));
  assert.equal(bundle.sourceSha, plan.input.target.applicationSha);
  assert.equal(bundle.prepared.planDigest, expected.planDigest);
  assert.equal(bundle.prepared.inputDigest, expected.inputDigest);
  assert.equal(bundle.prepared.toolingSha, expected.toolingSha);
  assert.equal(bundle.downloads.length, 6);
  for (const architecture of ['arm64', 'x64'] as const) {
    const names = manualNames(architecture);
    for (const name of [names.dmg, names.zip, names.old]) {
      const matches = bundle.downloads.filter(
        (item) => item.architecture === architecture && item.proof.name === name
      );
      assert.equal(matches.length, 1);
      const item = matches[0];
      assert(item);
      if (name === names.old) {
        const pin = oldManualDmg[architecture];
        assert.equal(item.releaseId, nativePredecessor.id);
        assert.equal(item.assetId, pin.id);
        assert.equal(item.proof.sha256, pin.sha256);
        assert.equal(item.proof.size, pin.size);
      } else {
        const original = plan.input.originals.find(
          (item) => item.name === name && item.tag === plan.input.target.tag
        );
        assert(original);
        assert.equal(item.releaseId, plan.input.target.id);
        assert.equal(item.assetId, original.assetId);
        sameProof(item.proof, original);
      }
    }
  }
}
export function checkManualArtifact(
  authority: MacArtifactAuthority,
  expected: {
    toolingSha: string;
    runId: number;
    attempt: number;
    artifactId: number;
    artifactSha256: string;
  }
) {
  const { run, job, artifact } = authority;
  for (const id of [expected.runId, expected.attempt, expected.artifactId])
    assert(Number.isSafeInteger(id) && id > 0);
  assert(/^[a-f0-9]{64}$/.test(expected.artifactSha256));
  assert.equal(run.id, expected.runId);
  assert.equal(run.run_attempt, expected.attempt);
  assert.equal(run.head_sha, expected.toolingSha);
  assert.equal(run.path.split('@')[0], manualWorkflow);
  assert.equal(run.event, 'workflow_dispatch');
  assert(['queued', 'in_progress', 'completed'].includes(run.status));
  assert.equal(artifact.id, expected.artifactId);
  assert.equal(artifact.name, `TEST-mac-manual-inputs-${expected.runId}-${expected.attempt}`);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, `sha256:${expected.artifactSha256}`);
  assert.equal(authority.archiveSha256, expected.artifactSha256);
  assert.equal(artifact.workflow_run.id, run.id);
  assert.equal(artifact.workflow_run.head_sha, expected.toolingSha);
  assert(authority.attemptJobIds.includes(job.id));
  assert.equal(job.name, manualProducer);
  validateWindowsProducerUpload(job, run.id, manualUpload, artifact.created_at);
}
export function checkManualEntries(entries: string[]) {
  const allowed = [
    'plan.json',
    'stage-plan.sha256',
    'producer-run.json',
    'producer-jobs.json',
    'producer-artifact.json',
    'manual-bundle.json',
  ];
  for (const architecture of ['arm64', 'x64'] as const)
    allowed.push(
      `${architecture}/`,
      ...Object.values(manualNames(architecture)).map((name) => `${architecture}/${name}`)
    );
  assert.equal(new Set(entries).size, entries.length);
  for (const entry of entries)
    assert(allowed.includes(entry), `Unexpected manual input entry: ${entry}`);
  for (const entry of allowed.filter((entry) => !entry.endsWith('/')))
    assert(entries.includes(entry), `Missing manual input: ${entry}`);
}
export function checkManualReleaseReread(before: Release, after: Release, names: string[]) {
  checkRelease(after, releaseSnapshot(before, before.target_commitish), before.draft);
  for (const name of names)
    checkMacAssetSnapshot(assetByName(after, name), assetByName(before, name));
}
function checkSelectedAsset(
  plan: StagePlan,
  asset: Asset,
  architecture: 'arm64' | 'x64',
  releaseId: number
) {
  if (releaseId === nativePredecessor.id) {
    const pin = oldManualDmg[architecture];
    assert.equal(asset.id, pin.id);
    assert.equal(asset.size, pin.size);
    assert.equal(asset.digest, `sha256:${pin.sha256}`);
  } else {
    const original = plan.input.originals.find(
      (item) => item.name === asset.name && item.tag === plan.input.target.tag
    );
    assert(original);
    checkMetadata(asset, original, original.assetId);
  }
}
export async function prepareManualInputs(
  output: string,
  authority: PreparedStageAuthority,
  inputDigest: string
) {
  await mkdir(output);
  const { plan, receipt } = await downloadPreparedStageArtifact(output, authority);
  assert.equal(nativeReleaseScenario(plan).targetVersion, '2.17.10');
  assert.equal(receipt.inputDigest, inputDigest);
  const port = new GitHubReleasePort();
  const source = await port.releaseById(repository, nativePredecessor.id);
  assert.equal(source.tag_name, nativePredecessor.tag);
  assert.equal(source.target_commitish, nativePredecessor.applicationSha);
  checkRelease(source, undefined, false);
  assert.equal(await port.tagSha(repository, source.tag_name), nativePredecessor.applicationSha);
  const target = await port.releaseById(repository, plan.input.target.id);
  checkRelease(target, plan.input.target, true);
  await port.verifyBuild(repository, plan.input.target.applicationSha, plan.input.build, 'full');
  const downloads: ManualBundle['downloads'] = [];
  for (const architecture of ['arm64', 'x64'] as const) {
    await mkdir(path.join(output, architecture));
    const names = manualNames(architecture);
    for (const name of [names.dmg, names.zip, names.old]) {
      const release = name === names.old ? source : target;
      const asset = assetByName(release, name);
      checkSelectedAsset(plan, asset, architecture, release.id);
      const file = path.join(output, architecture, name);
      await port.download(repository, asset, file);
      const proof = await fileProof(file, name);
      downloads.push({
        architecture,
        releaseId: release.id,
        assetId: asset.id,
        proof,
      });
    }
  }
  const bundle: ManualBundle = {
    schemaVersion: 1,
    toolingSha: authority.toolingSha,
    planDigest: authority.planDigest,
    inputDigest,
    sourceSha: plan.input.target.applicationSha,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    prepared: receipt,
    downloads,
  };
  checkManualBundle(bundle, plan, bundle);
  const targetAfter = await port.releaseById(repository, target.id);
  checkRelease(targetAfter, plan.input.target, true);
  const sourceAfter = await port.releaseById(repository, source.id);
  checkRelease(sourceAfter, releaseSnapshot(source, nativePredecessor.applicationSha), false);
  assert.equal(
    await port.tagSha(repository, sourceAfter.tag_name),
    nativePredecessor.applicationSha
  );
  for (const [before, after] of [
    [source, sourceAfter],
    [target, targetAfter],
  ]) {
    assert(before && after);
    checkManualReleaseReread(
      before,
      after,
      downloads.filter((item) => item.releaseId === before.id).map((item) => item.proof.name)
    );
  }
  await writeFile(path.join(output, 'manual-bundle.json'), `${canonical(bundle)}\n`, {
    flag: 'wx',
  });
}
async function api<T>(endpoint: string) {
  return JSON.parse(await macInputCommand(['api', endpoint])) as T;
}
export function checkManualTransfer(transfer: Awaited<ReturnType<typeof downloadGithubFile>>) {
  assert.equal(transfer.exitCode, 0, transfer.stderr);
  assert.equal(transfer.error, '');
}
export async function retrieveManualInputs(
  output: string,
  expected: Parameters<typeof checkManualArtifact>[1]
) {
  const prefix = `repos/${repository}/actions`;
  const run = await api<MacArtifactAuthority['run']>(`${prefix}/runs/${expected.runId}`);
  const pages = JSON.parse(
    await macInputCommand([
      'api',
      `${prefix}/runs/${expected.runId}/attempts/${expected.attempt}/jobs?per_page=100`,
      '--paginate',
      '--slurp',
    ])
  ) as { jobs: MacArtifactAuthority['job'][] }[];
  const jobs = pages.flatMap((page) => page.jobs);
  const selected = jobs.filter((job) => job.name === manualProducer);
  assert.equal(selected.length, 1);
  const job = selected[0];
  assert(job);
  const artifact = await api<MacArtifactAuthority['artifact']>(
    `${prefix}/artifacts/${expected.artifactId}`
  );
  const authority = {
    run,
    job,
    artifact,
    attemptJobIds: jobs.map((job) => job.id),
    archiveSha256: expected.artifactSha256,
  };
  checkManualArtifact(authority, expected);
  await mkdir(output);
  const archive = `${output}.zip`;
  const transfer = await downloadGithubFile(
    'gh',
    `${prefix}/artifacts/${expected.artifactId}/zip`,
    archive,
    // Original combined ARM/Intel ZIP is about 1.9 GiB; allow a bounded 20-minute transfer.
    { timeoutMs: 1_200_000 }
  );
  checkManualTransfer(transfer);
  authority.archiveSha256 = (await fileProof(archive, 'inputs.zip')).sha256;
  checkManualArtifact(authority, expected);
  const entries = (await macInputCommand(['-Z1', archive], 'unzip')).trim().split(/\r?\n/);
  checkManualEntries(entries);
  for (const entry of entries.filter((entry) => !entry.endsWith('/'))) {
    const destination = path.join(output, entry);
    await mkdir(path.dirname(destination), { recursive: true });
    // Only approved content streams into wx files; ZIP symlink metadata is never applied.
    const child = spawn('/usr/bin/unzip', ['-p', archive, entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(300_000),
    });
    child.stderr.resume();
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Input extraction failed: ${entry} (${code})`))
      );
    });
    await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
      exit,
    ]);
  }
  await writeFile(path.join(output, 'validated-input-artifact.json'), `${canonical(authority)}\n`, {
    flag: 'wx',
  });
  await rm(archive);
}
export async function readManualInputs(
  output: string,
  expected: Parameters<typeof checkManualArtifact>[1] & {
    planDigest: string;
    inputDigest: string;
  }
) {
  assert.equal(await realpath(output), output);
  const authority = JSON.parse(
    await readFile(path.join(output, 'validated-input-artifact.json'), 'utf8')
  ) as MacArtifactAuthority;
  checkManualArtifact(authority, expected);
  const bytes = await readFile(path.join(output, 'plan.json'));
  assert.equal(digest(bytes), expected.planDigest);
  const plan = JSON.parse(bytes.toString()) as StagePlan;
  const bundle = JSON.parse(
    await readFile(path.join(output, 'manual-bundle.json'), 'utf8')
  ) as ManualBundle;
  checkManualBundle(bundle, plan, expected);
  for (const item of bundle.downloads)
    sameProof(
      await fileProof(path.join(output, item.architecture, item.proof.name), item.proof.name),
      item.proof
    );
  return { plan, bundle, authority };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { operation: { type: 'string' }, output: { type: 'string' } },
    strict: true,
  });
  const toolingSha = process.env.TOOLING_SHA ?? '';
  checkManualContext(process.env, toolingSha);
  assert.equal((await macInputCommand(['rev-parse', 'HEAD'], 'git')).trim(), toolingSha);
  const root = await realpath(process.env.RUNNER_TEMP ?? '');
  const output = path.resolve(values.output ?? '');
  assert.equal(path.dirname(output), root);
  assert.equal(path.basename(output), 'TEST-mac-manual-inputs');
  if (values.operation === 'prepare') {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.GITHUB_JOB, manualProducer);
    await prepareManualInputs(
      output,
      {
        runId: Number(process.env.PREPARED_RUN_ID),
        attempt: Number(process.env.PREPARED_RUN_ATTEMPT),
        artifactId: Number(process.env.PREPARED_ARTIFACT_ID),
        artifactSha256: process.env.PREPARED_ARTIFACT_SHA256 ?? '',
        toolingSha,
        planDigest: process.env.PLAN_SHA256 ?? '',
      },
      process.env.INPUT_DIGEST ?? ''
    );
  } else {
    assert.equal(values.operation, 'retrieve');
    assert.equal(process.platform, 'darwin');
    assert.equal(process.env.GITHUB_JOB, 'mac-manual');
    await retrieveManualInputs(output, {
      toolingSha,
      runId: Number(process.env.GITHUB_RUN_ID),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      artifactId: Number(process.env.INPUT_ARTIFACT_ID),
      artifactSha256: process.env.INPUT_ARTIFACT_SHA256 ?? '',
    });
  }
}
