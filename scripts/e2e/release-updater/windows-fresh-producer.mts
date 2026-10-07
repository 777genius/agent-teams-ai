import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createInflateRaw } from 'node:zlib';

import { hashFile } from './inputs.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';

import type { WindowsProducerJob } from './windows-plan-producer.mts';

export const freshSource = 'b54020c17cc2624668fed77d5c8e98698866da59';
export const freshInstaller = 'Agent.Teams.AI.Setup.2.17.6-arm64.exe';
const repository = '777genius/agent-teams-ai';
const workflow = '.github/workflows/build-linux-windows-draft.yml';
export interface FreshPins {
  runId: number;
  attempt: number;
  jobId: number;
  artifactId: number;
  artifactSha256: string;
  testedApplicationSha: string;
}
export interface FreshAuthority {
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
    size_in_bytes: number;
    expired: boolean;
    created_at: string;
    workflow_run: { id: number; head_sha: string };
  };
}
export function checkFreshAuthority(value: FreshAuthority, pins: FreshPins) {
  for (const id of [pins.runId, pins.attempt, pins.jobId, pins.artifactId])
    assert(Number.isSafeInteger(id) && id > 0);
  assert.equal(pins.testedApplicationSha, freshSource);
  assert(/^[a-f0-9]{64}$/u.test(pins.artifactSha256));
  assert.equal(pins.runId, 37577692624);
  assert.equal(pins.attempt, 1);
  assert.equal(pins.jobId, 112650170568);
  assert.equal(value.run.id, pins.runId);
  assert.equal(value.run.run_attempt, pins.attempt, 'Latest producer attempt changed');
  assert.equal(value.run.head_sha, freshSource);
  assert.equal(value.run.path, workflow);
  assert.equal(value.run.event, 'workflow_dispatch');
  assert.equal(value.run.head_repository.full_name, repository);
  assert(['queued', 'in_progress', 'completed'].includes(value.run.status));
  const jobs = value.jobs.filter((job) => job.id === pins.jobId);
  assert.equal(jobs.length, 1, 'Exact job must belong to selected attempt');
  const job = jobs[0];
  assert(job);
  assert.equal(job.name, 'release-win arm64');
  assert.equal(value.artifact.id, pins.artifactId);
  assert.equal(value.artifact.name, `draft-win32-arm64-${pins.attempt}`);
  assert.equal(value.artifact.digest, `sha256:${pins.artifactSha256}`);
  assert.equal(value.artifact.expired, false);
  assert(Number.isSafeInteger(value.artifact.size_in_bytes) && value.artifact.size_in_bytes > 0);
  assert.equal(value.artifact.workflow_run.id, pins.runId);
  assert.equal(value.artifact.workflow_run.head_sha, freshSource);
  validateWindowsProducerUpload(
    job,
    pins.runId,
    'Upload immutable producer payloads',
    value.artifact.created_at
  );
  // This qualifies one producer artifact only. Aggregate build success is not claimed.
}

interface ZipEntry {
  name: string;
  offset: number;
  size: number;
  compressed: number;
  flags: number;
  method: number;
}
export function checkFreshZipDirectory(directory: Buffer, count: number): ZipEntry[] {
  assert.equal(count, 2, 'Exactly installer and blockmap required');
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    assert(cursor + 46 <= directory.length);
    assert.equal(directory.readUInt32LE(cursor), 0x02014b50);
    const flags = directory.readUInt16LE(cursor + 8),
      method = directory.readUInt16LE(cursor + 10);
    const compressed = directory.readUInt32LE(cursor + 20),
      size = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28),
      extra = directory.readUInt16LE(cursor + 30),
      comment = directory.readUInt16LE(cursor + 32);
    const mode = directory.readUInt32LE(cursor + 38) >>> 16,
      offset = directory.readUInt32LE(cursor + 42);
    assert.equal(directory.readUInt16LE(cursor + 34), 0, 'No multidisk ZIP');
    assert(
      (flags & ~0x808) === 0 && [0, 8].includes(method),
      'No encryption or unsupported compression'
    );
    assert([0, 0x8000].includes(mode & 0xf000), 'Only regular ZIP entries');
    assert((directory.readUInt32LE(cursor + 38) & 0x10) === 0, 'No directory entries');
    assert(
      size > 0 &&
        size < 2_147_483_648 &&
        compressed > 0 &&
        compressed < 2_147_483_648 &&
        offset !== 0xffffffff
    );
    assert(cursor + 46 + nameLength + extra + comment <= directory.length);
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert(
      [freshInstaller, `${freshInstaller}.blockmap`].includes(name),
      'Unexpected or unsafe ZIP path'
    );
    entries.push({ name, offset, size, compressed, flags, method });
    cursor += 46 + nameLength + extra + comment;
  }
  assert.equal(cursor, directory.length);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, 2, 'Duplicate ZIP path');
  return entries;
}

export async function extractFreshZip(archive: string, destination: string) {
  const handle = await open(archive, 'r');
  try {
    const length = (await handle.stat()).size;
    async function bytes(offset: number, size: number) {
      assert(offset >= 0 && size > 0 && offset + size <= length);
      const result = Buffer.alloc(size);
      assert.equal((await handle.read(result, 0, size, offset)).bytesRead, size);
      return result;
    }
    const end = await bytes(length - 22, 22);
    assert.equal(end.readUInt32LE(0), 0x06054b50);
    assert.equal(end.readUInt32LE(4), 0, 'No multidisk ZIP');
    assert.equal(end.readUInt16LE(8), end.readUInt16LE(10));
    assert.equal(end.readUInt16LE(20), 0, 'No ZIP trailer');
    const centralSize = end.readUInt32LE(12),
      centralOffset = end.readUInt32LE(16);
    assert(
      centralSize < 65_536 && centralOffset + centralSize === length - 22,
      'No ZIP64 or hidden trailer'
    );
    const entries = checkFreshZipDirectory(
      await bytes(centralOffset, centralSize),
      end.readUInt16LE(10)
    );
    const payloads = [];
    for (const entry of entries.toSorted((a, b) => a.offset - b.offset)) {
      const header = await bytes(entry.offset, 30);
      assert.equal(header.readUInt32LE(0), 0x04034b50);
      assert.equal(header.readUInt16LE(6), entry.flags);
      assert.equal(header.readUInt16LE(8), entry.method);
      const nameSize = header.readUInt16LE(26),
        extraSize = header.readUInt16LE(28);
      assert.equal((await bytes(entry.offset + 30, nameSize)).toString('utf8'), entry.name);
      const start = entry.offset + 30 + nameSize + extraSize;
      const end = start + entry.compressed;
      assert(
        end <= centralOffset &&
          (payloads.length === 0
            ? entry.offset === 0
            : entry.offset >= (payloads.at(-1)?.end ?? 0)),
        'Overlapping ZIP entries'
      );
      if (!(entry.flags & 8)) {
        assert.equal(header.readUInt32LE(18), entry.compressed);
        assert.equal(header.readUInt32LE(22), entry.size);
      }
      payloads.push({ ...entry, start, end });
    }
    // Validate every path/header before creating any extracted file.
    const ledger = [];
    for (const entry of payloads) {
      const file = path.join(destination, entry.name);
      const source = createReadStream(archive, { start: entry.start, end: entry.end - 1 });
      const target = createWriteStream(file, { flags: 'wx' });
      if (entry.method === 8) await pipeline(source, createInflateRaw(), target);
      else await pipeline(source, target);
      const proof = await hashFile(file);
      assert.equal(proof.size, entry.size);
      ledger.push({ name: entry.name, ...proof });
    }
    return ledger;
  } finally {
    await handle.close();
  }
}

export async function retrieveFreshProducer(pins: FreshPins, output: string) {
  // Authentication exists only in the gh subprocess environment, never decoder/app/native env.
  const ghEnvironment = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(?:GH_TOKEN|GITHUB_TOKEN)$/iu.test(key)) delete process.env[key];
  assert.equal(process.platform, 'win32');
  const programFiles = Object.entries(ghEnvironment).find(
    ([key]) => key.toLowerCase() === 'programfiles'
  )?.[1];
  assert(programFiles && path.isAbsolute(programFiles));
  const gh = path.join(programFiles, 'GitHub CLI', 'gh.exe');
  assert.equal(
    (await realpath(gh)).toLowerCase(),
    gh.toLowerCase(),
    'Installed gh must not resolve outside ProgramFiles'
  );
  const execute = promisify(execFile);
  async function api<T>(endpoint: string): Promise<T> {
    const result = await execute(gh, ['api', `repos/${repository}/${endpoint}`], {
      env: ghEnvironment,
      timeout: 30_000,
      maxBuffer: 16_777_216,
    });
    return JSON.parse(result.stdout) as T;
  }
  const run = await api<FreshAuthority['run']>(`actions/runs/${pins.runId}`);
  const pages = await execute(
    gh,
    [
      'api',
      `repos/${repository}/actions/runs/${pins.runId}/attempts/${pins.attempt}/jobs?per_page=100`,
      '--paginate',
      '--slurp',
    ],
    { env: ghEnvironment, timeout: 30_000, maxBuffer: 16_777_216 }
  );
  const jobs = (JSON.parse(pages.stdout) as { jobs: WindowsProducerJob[] }[]).flatMap(
    (page) => page.jobs
  );
  const artifact = await api<FreshAuthority['artifact']>(`actions/artifacts/${pins.artifactId}`);
  const authority = { run, jobs, artifact };
  checkFreshAuthority(authority, pins);
  const archive = path.join(output, 'producer.zip');
  const child = spawn(gh, ['api', `repos/${repository}/actions/artifacts/${pins.artifactId}/zip`], {
    env: ghEnvironment,
    stdio: ['ignore', 'pipe', 'ignore'],
    signal: AbortSignal.timeout(300_000),
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`gh artifact transfer failed (${code})`))
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(archive, { flags: 'wx' })),
    completion,
  ]);
  const { proof, ledger } = await verifyFreshArchive(
    archive,
    output,
    pins.artifactSha256,
    artifact.size_in_bytes
  );
  const receipt = {
    qualifying: false,
    fullOtaProved: false,
    pins,
    authority,
    archive: proof,
    ledger,
  };
  await writeFile(path.join(output, 'producer-proof.json'), JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  return receipt;
}

export async function verifyFreshArchive(
  archive: string,
  output: string,
  sha256: string,
  size: number
) {
  const proof = await hashFile(archive);
  assert.equal(proof.sha256, sha256, 'Full producer ZIP hash mismatch');
  assert.equal(proof.size, size, 'Full producer ZIP size mismatch');
  return { proof, ledger: await extractFreshZip(archive, output) };
}
