import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertQualifiedPayload } from './new-dashboard-install.mts';

const source = 'b54020c17cc2624668fed77d5c8e98698866da59';
const runId = 37577692624, jobId = 112650170287, artifactId = 11462824999;
const archiveSha = '92a6b30ec214240df1f2742060cfe993d858526b11c42f0ef51b0ac6b3a2ea91';
const proofId = 11464231298, proofSha = '0203363009c942e16fd8e701f004d99227605bf9e6e087add9cf965ab9c7a932';
const apiRoot = 'repos/777genius/agent-teams-ai';
const ghEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, GH_DEBUG: undefined });
interface Run { id: number; run_attempt: number; head_sha: string; status: string; conclusion: string; path: string }
interface Job { id: number; run_id: number; name: string; conclusion: string; head_sha: string }
interface BuildArtifact {
  id: number; name: string; size_in_bytes: number; expired: boolean; digest: string;
  workflow_run: { id: number; head_sha: string };
}
function ghExecutable(): string {
  assert(process.env.ProgramFiles && path.win32.isAbsolute(process.env.ProgramFiles));
  return path.win32.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe');
}
function api<T>(endpoint: string): T {
  return JSON.parse(execFileSync(ghExecutable(), ['api', `${apiRoot}/${endpoint}`], {
    encoding: 'utf8', env: ghEnvironment(), timeout: 60000, maxBuffer: 1024 * 1024,
  })) as T;
}
export function assertProducer(run: Run, job: Job, artifact: BuildArtifact): void {
  assert.equal(run.id, runId); assert.equal(run.run_attempt, 1); assert.equal(run.head_sha, source);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.path, '.github/workflows/build-linux-windows-draft.yml');
  assert.equal(job.id, jobId); assert.equal(job.run_id, runId); assert.equal(job.head_sha, source);
  assert.equal(job.name, 'release-win x64'); assert.equal(job.conclusion, 'success');
  assertArtifact(artifact, artifactId, 'draft-win32-x64-1', 239262824, archiveSha);
}
function assertArtifact(artifact: BuildArtifact, id: number, name: string, size: number, digest: string): void {
  assert.equal(artifact.id, id); assert.equal(artifact.name, name); assert.equal(artifact.size_in_bytes, size);
  assert.equal(artifact.expired, false); assert.equal(artifact.digest, `sha256:${digest}`);
  assert.equal(artifact.workflow_run.id, runId); assert.equal(artifact.workflow_run.head_sha, source);
}
async function fingerprint(file: string): Promise<{ path: string; sha256: string }> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return { path: path.resolve(file), sha256: digest.digest('hex') };
}
async function download(id: number, file: string, expectedSize: number, expectedHash: string): Promise<void> {
  const output = await open(file, 'wx');
  try {
    const child = spawn(ghExecutable(), ['api', `${apiRoot}/actions/artifacts/${id}/zip`], {
      env: ghEnvironment(), stdio: ['ignore', output.fd, 'pipe'], windowsHide: true,
    });
    let diagnostics = '';
    assert(child.stderr);
    child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-2048); });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Artifact download failed: ${diagnostics}`)));
    });
  } finally { await output.close(); }
  assert.equal((await stat(file)).size, expectedSize, 'Official full ZIP size differs');
  assert.equal((await fingerprint(file)).sha256, expectedHash, 'Official full ZIP digest differs');
}
function powershell(script: string, paths: Record<string, string>): void {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
    env[key] = process.env[key];
  assert(process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot));
  const executable = path.win32.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
    `$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], {
    env: { ...env, ...paths }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 65536,
  });
}
async function extract(file: string, directory: string): Promise<void> {
  await mkdir(directory);
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $base = [IO.Path]::GetFullPath($env:TEST_EXTRACT_DIR) + [IO.Path]::DirectorySeparatorChar;
    $zip = [IO.Compression.ZipFile]::OpenRead($env:TEST_ARCHIVE);
    try { foreach ($entry in $zip.Entries) {
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $entry.FullName));
      if (!$target.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe ZIP entry' }
    }} finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($env:TEST_ARCHIVE,$env:TEST_EXTRACT_DIR);`,
  { TEST_ARCHIVE: file, TEST_EXTRACT_DIR: directory });
}
async function qualify(): Promise<void> {
  assert.equal(process.platform, 'win32'); assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Native staging is GHA-only');
  const run = api<Run>(`actions/runs/${runId}`), job = api<Job>(`actions/jobs/${jobId}`);
  const artifact = api<BuildArtifact>(`actions/artifacts/${artifactId}`);
  assertProducer(run, job, artifact);
  const proofArtifact = api<BuildArtifact>(`actions/artifacts/${proofId}`);
  assertArtifact(proofArtifact, proofId, 'build-provenance-1', 903, proofSha);
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-qualified-'));
  const originalArchivePath = path.join(root, 'original-official-artifact.zip');
  const proofArchive = path.join(root, 'original-provenance.zip');
  await download(artifactId, originalArchivePath, artifact.size_in_bytes, archiveSha);
  await download(proofId, proofArchive, proofArtifact.size_in_bytes, proofSha);
  const proofDir = path.join(root, 'producer-proof'); await extract(proofArchive, proofDir);
  const proof = JSON.parse(await readFile(path.join(proofDir, `build-provenance-${runId}-1.json`), 'utf8')) as {
    applicationSha: string; runId: number; attempt: number; jobs: { id: number; run_id: number; conclusion: string }[];
  };
  assert.equal(proof.applicationSha, source); assert.equal(proof.runId, runId); assert.equal(proof.attempt, 1);
  assert(proof.jobs.some((entry) => entry.id === jobId && entry.run_id === runId && entry.conclusion === 'success'));
  const lock = api<{ encoding: string; content: string }>(`contents/runtime.lock.json?ref=${source}`);
  assert.equal(lock.encoding, 'base64');
  assert.equal((JSON.parse(Buffer.from(lock.content, 'base64').toString('utf8')) as { version: string }).version, '0.0.105');
  const payload = path.join(root, 'payload'); await extract(originalArchivePath, payload);
  const installer = path.join(payload, 'Agent.Teams.AI.Setup.2.17.6.exe');
  assert.equal((await fingerprint(installer)).sha256, '89bd16189ff0defe4fad4c83519975377ca414ad3d5d655526f9147a20bd3ccf');
  const install = path.join(root, 'install');
  powershell(`$p = Start-Process -Wait -PassThru -FilePath $env:TEST_INSTALLER -ArgumentList @('/S',('/D=' + $env:TEST_INSTALL_DIR));
    if ($p.ExitCode -ne 0) { throw ('Official NSIS install failed: ' + $p.ExitCode) }`,
  { TEST_INSTALLER: installer, TEST_INSTALL_DIR: install });
  const app = await fingerprint(path.join(install, 'AgentTeamsAI.exe'));
  const archive = await fingerprint(path.join(install, 'resources/app.asar'));
  assert.equal(app.sha256, '195290e47626eb8d534a2423344909c00f7126108cf962d9facdb0406996b2fb');
  assert.equal(archive.sha256, '1a3ae25f04d96934073ce2d61ebd769685daeb36f29873e0119faa915e4be298');
  const receipt = { schemaVersion: 1 as const, sourceCommit: source, runtimeVersion: '0.0.105',
    buildRunId: String(runId), buildJobId: String(jobId), artifactId: String(artifactId), buildAttempt: 1,
    originalArchivePath, originalArchiveSha256: archiveSha,
    artifact: { app, archive, orchestrator: await fingerprint(path.join(install, 'resources/runtime/claude-multimodel.exe')),
      rendererArtifact: await fingerprint(path.join(install, 'resources/app.asar.unpacked/out/renderer/index.html')) },
    producer: { run, job, artifact, proofArtifact, proof }, toolingCommit: process.env.GITHUB_SHA,
    scenario: await fingerprint(fileURLToPath(new URL('./new-dashboard-install.mts', import.meta.url))),
  };
  assertQualifiedPayload(receipt.artifact, receipt);
  const receiptPath = path.join(root, 'qualified-payload.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  assert(process.env.GITHUB_OUTPUT);
  await appendFile(process.env.GITHUB_OUTPUT, `receipt=${receiptPath}\nexecutable=${app.path}\nroot=${root}\n`);
  console.log(JSON.stringify({ root, receiptPath, executable: app.path, scenario: receipt.scenario }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await qualify();
