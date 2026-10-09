import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  authenticateWindowsExecutor,
  windowsOriginalToolingSha,
} from './windows-execution-provenance.mts';
import { downloadGithubFile } from './github-download.mts';
import { hashFile } from './inputs.mts';
import { planCommand } from './windows-plan-command.mts';
import { planWindowsInputs, windowsPredecessorPins } from './windows-plan-inputs.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';
import { selectedWindowsPowerShell } from './windows-powershell.mts';

import type { WindowsProducerJob } from './windows-plan-producer.mts';

const repository = '777genius/agent-teams-ai';
const workflow = '.github/workflows/updater-windows-ota.yml';
const e13 = '261f0ad57ffdc7a3176f7053c140521808bb37e1';
export const windowsResumeP10 = {
  planSha256: 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678',
  inputDigest: 'f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa',
} as const;
export const windowsResumeSources = {
  inputs: {
    runId: 37909332806,
    attempt: 1,
    jobId: 113750414719,
    head: e13,
    artifactId: 11606421802,
    sha256: 'a34186947c35349aaca7c4598311efd18ca75de0bea5bcfa7705aab5416ca615',
    name: 'TEST-windows-ota-inputs-37909332806-1',
    job: 'verified-windows-inputs',
    upload: 'Run actions/upload-artifact@v7',
    proof: 'Verify immutable native producer and extract exact plan-bound inputs',
  },
  x64: {
    runId: 37909332806,
    attempt: 1,
    jobId: 113756559988,
    head: e13,
    artifactId: 11606568836,
    sha256: 'db9a5f07b5eba78124964b675d7ebdc014d5e3c157b49d5eabaa372f49422453',
    name: 'TEST-windows-fresh-x64-37909332806-1',
    job: 'fresh-windows (windows-2025, x64)',
    upload: 'Preserve independently installed target reference and native proof',
    proof: 'Fresh official target installation on a separate native VM',
  },
  arm64: {
    runId: 37834555508,
    attempt: 2,
    jobId: 113736222882,
    head: windowsOriginalToolingSha,
    artifactId: 11604902032,
    sha256: '848d86259a7b878340c0c6d02748e2bb1142ff9bcf384d900ed3df28f3ab0892',
    name: 'TEST-windows-fresh-arm64-37834555508-2',
    job: 'fresh-windows (windows-11-arm, arm64)',
    upload: 'Preserve independently installed target reference and native proof',
    proof: 'Fresh official target installation on a separate native VM',
  },
} as const;
export type ResumeSource = keyof typeof windowsResumeSources;
export const windowsResumeFreshRaw = {
  x64: {
    summary: 'dc8eaa30f66c1a4d3a3be39109afed4d7e57c0126b383a66ef50720c51a7e255',
    reference: 'a611800b49135a927a346f96f510e8e979349b319a6c0d9d4431306b2e28563f',
  },
  arm64: {
    summary: '046252ceb0193eeebb8237b5c5a7d40a7a2ef1d500fa4bbe67b6d8ab0084c576',
    reference: 'fcc5490ccebb13095e51744f559e3a73b9d7933e35886a201571644087a55c89',
  },
} as const;
export interface ResumeAuthority {
  run: {
    id: number;
    run_attempt: number;
    head_sha: string;
    path: string;
    event: string;
    status: string;
    head_repository: { full_name: string };
  };
  jobs: WindowsProducerJob[];
  artifact: {
    id: number;
    name: string;
    digest: string;
    expired: boolean;
    created_at: string;
    size_in_bytes: number;
    workflow_run: { id: number; head_sha: string };
  };
}
export function checkWindowsResumeArchiveMembers(entries: { name: string; attributes: number }[]) {
  assert(entries.length > 0 && entries.length < 5000);
  const seen = new Set<string>();
  for (const entry of entries) {
    assert(Number.isInteger(entry.attributes));
    assert(
      entry.name &&
        !entry.name.includes('\\') &&
        !entry.name.startsWith('/') &&
        !/^[A-Za-z]:/u.test(entry.name)
    );
    assert(
      [...entry.name].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
      'Archive member contains a control character'
    );
    const name = entry.name.replace(/\/$/u, '');
    assert(
      name.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':'))
    );
    assert(!seen.has(name.toLowerCase()), 'Case-insensitive duplicate archive member');
    seen.add(name.toLowerCase());
    assert(
      ((entry.attributes >>> 16) & 0xf000) !== 0xa000 && !(entry.attributes & 0x400),
      'Archive symlink or reparse point'
    );
  }
}
export function checkWindowsResumeAuthority(
  key: ResumeSource,
  value: ResumeAuthority,
  archiveSha256?: string
) {
  const expected = windowsResumeSources[key];
  assert.equal(value.run.id, expected.runId);
  assert.equal(value.run.run_attempt, expected.attempt);
  assert.equal(value.run.head_sha, expected.head);
  assert.equal(value.run.path.split('@')[0], workflow);
  assert.equal(value.run.event, 'workflow_dispatch');
  assert.equal(value.run.status, 'completed');
  assert.equal(value.run.head_repository.full_name, repository);
  const matches = value.jobs.filter((job) => job.id === expected.jobId);
  assert.equal(matches.length, 1);
  const job = matches[0];
  assert(job);
  assert.equal(job.name, expected.job);
  const required: string[] = [expected.proof];
  if (key !== 'inputs')
    required.push('Clean exact owned native processes and physical profile links');
  for (const name of required) {
    const steps: WindowsProducerJob['steps'] = job.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1);
    const step = steps[0];
    assert(step);
    assert.equal(step.status, 'completed');
    assert.equal(step.conclusion, 'success');
  }
  assert.equal(value.artifact.id, expected.artifactId);
  assert.equal(value.artifact.name, expected.name);
  assert.equal(value.artifact.digest, `sha256:${expected.sha256}`);
  assert.equal(value.artifact.expired, false);
  assert.equal(value.artifact.workflow_run.id, expected.runId);
  assert.equal(value.artifact.workflow_run.head_sha, expected.head);
  assert(Number.isSafeInteger(value.artifact.size_in_bytes) && value.artifact.size_in_bytes > 0);
  validateWindowsProducerUpload(job, expected.runId, expected.upload, value.artifact.created_at);
  if (archiveSha256 !== undefined) assert.equal(archiveSha256, expected.sha256);
  return expected;
}
interface InstalledReference {
  executable: Awaited<ReturnType<typeof hashFile>>;
  asar: Awaited<ReturnType<typeof hashFile>>;
  packageVersion: string;
  architecture: string;
  signature: { status: string; productVersion: string };
}
export interface ResumeFreshReference {
  passed: boolean;
  arch: string;
  inputDigest: string;
  installerSha256: string;
  installed: InstalledReference;
}
export interface ResumeFreshSummary {
  passed: boolean;
  mode: string;
  arch: string;
  inputDigest: string;
  freshInstallProved: boolean;
  finalReleaseProved: boolean;
  cleanup: { passed: boolean };
  targetBinding: {
    targetVersion: string;
    legacyFixture: boolean;
    plan: { sha256: string; input: { toolingSha: string } };
  };
  installedBefore: InstalledReference;
  nativeWindow: { ready: boolean; pid: number };
  initialLaunch: { owner: { pid: number } };
}
export interface ResumeInputBinding {
  inputDigest: string;
  plan?: { sha256: string; input: { toolingSha: string } };
  verified: { arch: 'x64' | 'arm64'; tag: string; name: string; sha256: string }[];
}
export function checkWindowsResumeFresh(
  key: 'x64' | 'arm64',
  summary: ResumeFreshSummary,
  reference: ResumeFreshReference,
  inputs: ResumeInputBinding
) {
  assert(inputs.plan);
  assert.equal(inputs.plan.sha256, windowsResumeP10.planSha256);
  assert.equal(inputs.inputDigest, windowsResumeP10.inputDigest);
  assert.equal(inputs.plan.input.toolingSha, windowsOriginalToolingSha);
  assert.equal(summary.passed, true);
  assert.equal(summary.cleanup.passed, true);
  assert.equal(summary.freshInstallProved, true);
  assert.equal(summary.finalReleaseProved, true);
  assert.equal(summary.mode, 'fresh');
  assert.equal(summary.arch, key);
  assert.equal(summary.inputDigest, inputs.inputDigest);
  assert.equal(summary.targetBinding.targetVersion, '2.17.10');
  assert.equal(summary.targetBinding.legacyFixture, false);
  assert.equal(summary.targetBinding.plan.sha256, inputs.plan.sha256);
  assert.equal(summary.targetBinding.plan.input.toolingSha, windowsOriginalToolingSha);
  assert.equal(summary.nativeWindow.ready, true);
  assert.equal(summary.nativeWindow.pid, summary.initialLaunch.owner.pid);
  assert.equal(reference.passed, true);
  assert.equal(reference.arch, key);
  assert.equal(reference.inputDigest, inputs.inputDigest);
  const target = inputs.verified.find(
    (pin) => pin.arch === key && pin.tag === 'v2.17.10' && pin.name.endsWith('.exe')
  );
  assert(target);
  assert.equal(reference.installerSha256, target.sha256);
  assert.equal(reference.installed.packageVersion, '2.17.10');
  assert.equal(reference.installed.architecture, key);
  assert.deepEqual(reference.installed, summary.installedBefore);
  for (const file of [reference.installed.executable, reference.installed.asar]) {
    assert(/^[a-f0-9]{64}$/u.test(file.sha256) && /^[A-Za-z0-9+/]{86}==$/u.test(file.sha512));
    assert(Number.isSafeInteger(file.size) && file.size > 0);
  }
  assert(['Valid', 'NotSigned'].includes(reference.installed.signature.status));
  assert(reference.installed.signature.productVersion.includes('2.17.10'));
}
async function authenticateSource(key: ResumeSource, output: string) {
  const source = windowsResumeSources[key];
  async function api<T>(endpoint: string, suffix: string) {
    const file = path.join(output, `${key}-${suffix}.json`);
    await planCommand('gh', ['api', `repos/${repository}/${endpoint}`], file);
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }
  const run = await api<ResumeAuthority['run']>(
    `actions/runs/${source.runId}/attempts/${source.attempt}`,
    'run'
  );
  const page = await api<{ jobs: WindowsProducerJob[]; total_count: number }>(
    `actions/runs/${source.runId}/attempts/${source.attempt}/jobs?per_page=100`,
    'jobs'
  );
  const jobs = page.jobs;
  assert(Array.isArray(jobs));
  assert.equal(page.total_count, jobs.length, 'Every source-attempt job must be present');
  const artifact = await api<ResumeAuthority['artifact']>(
    `actions/artifacts/${source.artifactId}`,
    'artifact'
  );
  const authority = { run, jobs, artifact };
  checkWindowsResumeAuthority(key, authority);
  return authority;
}
async function retrieveArchive(
  key: ResumeSource,
  authority: ResumeAuthority,
  root: string,
  directory: string,
  names: string[],
  output: string
) {
  const source = windowsResumeSources[key];
  const archive = path.join(root, `${key}.zip`);
  const transfer = await downloadGithubFile(
    'gh',
    `repos/${repository}/actions/artifacts/${source.artifactId}/zip`,
    archive,
    { timeoutMs: 1_200_000 }
  );
  assert.equal(transfer.exitCode, 0, transfer.stderr);
  assert.equal(transfer.error, '');
  const archiveProof = await hashFile(archive);
  checkWindowsResumeAuthority(key, authority, archiveProof.sha256);
  assert.equal(archiveProof.size, authority.artifact.size_in_bytes);
  const shell = await selectedWindowsPowerShell();
  const input = path.join(root, `${key}-extract.json`),
    script = path.join(root, 'extract.ps1');
  await writeFile(input, JSON.stringify({ archive, directory, names, inventoryOnly: true }));
  await writeFile(
    script,
    String.raw`
param([string]$InputFile)
$ErrorActionPreference='Stop'
$data=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($InputFile))
[IO.Directory]::CreateDirectory($data.directory) | Out-Null
if ((Split-Path -Leaf $data.directory) -notin @('TEST-windows-inputs','TEST-windows-reference')) { throw 'Extraction requires exact TEST directory' }
$ancestor=[IO.DirectoryInfo]::new($data.directory)
while ($null -ne $ancestor) {
  if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Extraction directory ancestor is a reparse point' }
  $ancestor=$ancestor.Parent
}
$zip=[IO.Compression.ZipFile]::OpenRead($data.archive)
try {
  if ($data.inventoryOnly) {
    ConvertTo-Json -InputObject @($zip.Entries | ForEach-Object { @{name=$_.FullName;attributes=$_.ExternalAttributes} }) -Depth 4 -Compress
    exit
  }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    $name=$entry.FullName
    if ([string]::IsNullOrEmpty($name) -or $name -match '[\x00-\x1f\x7f]' -or $name -match '^[\\/]|^[A-Za-z]:' -or $name.Contains('\')) { throw 'Unsafe archive member path' }
    $normalized=$name.TrimEnd('/')
    if (-not $seen.Add($normalized)) { throw 'Case-insensitive duplicate archive member' }
    foreach ($part in $normalized.Split('/')) {
      if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part.Contains(':')) { throw 'Archive traversal or stream path' }
    }
    if ((($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000 -or ($entry.ExternalAttributes -band 0x400)) { throw 'Archive symlink or reparse point' }
  }
  foreach ($name in $data.names) {
    if ($name -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Only exact flat payload names authorized' }
    $matches=@($zip.Entries | Where-Object { $_.FullName -ceq $name })
    if ($matches.Count -ne 1) { throw "Missing or duplicate authorized entry: $name" }
    $entry=$matches[0];$source=$entry.Open();$destination=$null
    try {
      $destination=[IO.File]::Open([IO.Path]::Combine($data.directory,$name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $source.CopyTo($destination)
    } finally { if ($destination) { $destination.Dispose() };$source.Dispose() }
  }
} finally { $zip.Dispose() }
'verified named-entry extraction'
`
  );
  const arguments_ = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-InputFile',
    input,
  ];
  const inventory = path.join(output, `${key}-archive-members.json`);
  await planCommand(shell.executable, arguments_, inventory);
  checkWindowsResumeArchiveMembers(
    JSON.parse(await readFile(inventory, 'utf8')) as { name: string; attributes: number }[]
  );
  await writeFile(input, JSON.stringify({ archive, directory, names, inventoryOnly: false }));
  await planCommand(shell.executable, arguments_, path.join(output, `${key}-extraction.txt`));
  return { source, authority, archive: archiveProof };
}
async function run() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_WORKFLOW_REF?.split('@')[0], `${repository}/${workflow}`);
  assert(['resume-ota', 'resume-remaining'].includes(process.env.SCENARIO_FILTER ?? ''));
  assert.equal(process.env.TOOLING_SHA, windowsOriginalToolingSha);
  assert.equal(process.env.PLAN_DIGEST, windowsResumeP10.planSha256);
  authenticateWindowsExecutor(windowsOriginalToolingSha, process.env.EXECUTION_SHA);
  const output = path.resolve('.artifacts/TEST-windows-resume-custody');
  await mkdir(output, { recursive: true });
  if (process.argv.includes('--prepare')) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.GITHUB_JOB, 'verified-windows-inputs');
    const authorities: Partial<Record<ResumeSource, ResumeAuthority>> = {};
    for (const key of ['inputs', 'x64', 'arm64'] as const)
      authorities[key] = await authenticateSource(key, output);
    await writeFile(path.join(output, 'sources.json'), JSON.stringify(authorities, null, 2), {
      flag: 'wx',
    });
    assert(process.env.GITHUB_OUTPUT);
    const source = windowsResumeSources.inputs;
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `source_run_id=${source.runId}\nsource_attempt=${source.attempt}\nsource_artifact_id=${source.artifactId}\nsource_artifact_name=${source.name}\nsource_sha256=${source.sha256}\nsource_head=${source.head}\n`
    );
    return;
  }
  assert(process.argv.includes('--retrieve'));
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_JOB, 'windows-ota');
  assert(process.arch === 'x64' || process.arch === 'arm64');
  const key = process.arch;
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-resume-'));
  const input = path.resolve('.artifacts/TEST-windows-inputs');
  const referenceDirectory = path.resolve('.artifacts/TEST-windows-reference');
  const names = [
    'plan.json',
    'source-api.json',
    'draft-api.json',
    'latest.yml',
    'release-platform-manifest.json',
    'prepared-receipt.json',
    'native-receipt.json',
    ...windowsPredecessorPins.map((pin) => pin.name),
    ...['Agent.Teams.AI.Setup.2.17.10.exe', 'Agent.Teams.AI.Setup.2.17.10-arm64.exe'].flatMap(
      (name) => [name, `${name}.blockmap`]
    ),
  ];
  const inputProof = await retrieveArchive(
    'inputs',
    await authenticateSource('inputs', output),
    root,
    input,
    names,
    output
  );
  const inputs = await planWindowsInputs(input, path.join(input, 'plan.json'));
  assert.equal(inputs.plan?.sha256, process.env.PLAN_DIGEST);
  assert.equal(inputs.inputDigest, windowsResumeP10.inputDigest);
  assert.equal(inputs.plan?.input.toolingSha, windowsOriginalToolingSha);
  assert.equal(inputs.targetVersion, '2.17.10');
  const freshProof = await retrieveArchive(
    key,
    await authenticateSource(key, output),
    root,
    referenceDirectory,
    ['summary.json', 'fresh-reference.json'],
    output
  );
  const summaryFile = path.join(referenceDirectory, 'summary.json'),
    referenceFile = path.join(referenceDirectory, 'fresh-reference.json');
  const summaryHash = await hashFile(summaryFile),
    referenceHash = await hashFile(referenceFile);
  assert.equal(summaryHash.sha256, windowsResumeFreshRaw[key].summary);
  assert.equal(referenceHash.sha256, windowsResumeFreshRaw[key].reference);
  const summary = JSON.parse(await readFile(summaryFile, 'utf8')) as ResumeFreshSummary;
  const reference = JSON.parse(await readFile(referenceFile, 'utf8')) as ResumeFreshReference;
  checkWindowsResumeFresh(key, summary, reference, inputs);
  const receipt = {
    inputProof,
    freshProof,
    planSha256: inputs.plan?.sha256,
    inputDigest: inputs.inputDigest,
    payloads: inputs.verified,
    summary: summaryHash,
    reference: referenceHash,
  };
  await writeFile(
    path.join(referenceDirectory, 'validated-fresh-reference.json'),
    JSON.stringify(receipt, null, 2),
    { flag: 'wx' }
  );
  await writeFile(
    path.resolve('.artifacts/TEST-windows-ota/resume-source-provenance.json'),
    JSON.stringify(receipt, null, 2),
    { flag: 'wx' }
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await run();
