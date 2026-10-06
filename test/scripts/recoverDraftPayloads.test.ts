// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { platformNames } from '../../scripts/ci/release/contract.js';
import {
  RECOVERY,
  appendDraftPayloads,
  recoverDraftPayloads,
  recoveryPort,
  validateProducer,
  verifyArtifactArchive,
} from '../../scripts/ci/release/recoverDraftPayloads.js';
import type { RecoveryPort } from '../../scripts/ci/release/recoverDraftPayloads.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
interface StoredAsset {
  id: number;
  name: string;
  size: number;
  digest: string;
  state: string;
}
class DraftStorage implements RecoveryPort {
  assets: StoredAsset[] = [];
  uploaded: { releaseId: number; bytes: Buffer; name: string }[] = [];
  draftId = 404985707;
  attempts = 1;
  lostResponse = false;
  artifactMutation: Record<string, unknown> = {};
  archived = false;
  tagSha: string | null = null;
  runPath = '.github/workflows/build-linux-windows-draft.yml';
  runEvent = 'workflow_dispatch';
  json<T>(endpoint: string): Promise<T> {
    let value: unknown;
    if (endpoint.includes('/assets?')) value = this.assets.map((asset) => ({ ...asset }));
    else if (endpoint.includes('/releases/'))
      value = {
        id: this.draftId,
        tag_name: 'v2.17.5',
        target_commitish: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
        draft: true,
        prerelease: false,
      };
    else if (endpoint.includes('matching-refs'))
      value = this.tagSha ? [{ ref: 'refs/tags/v2.17.5' }] : [];
    else if (endpoint.includes('/commits/')) value = { sha: this.tagSha };
    else if (endpoint.includes('/actions/runs/'))
      value = {
        id: 37498376671,
        path: this.runPath,
        event: this.runEvent,
        head_sha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
      };
    else if (endpoint.includes('/actions/jobs/')) {
      const pin = RECOVERY.producers.find((producer) => endpoint.endsWith(String(producer.jobId)));
      if (!pin) throw new Error('Unknown fixture job');
      value = {
        id: pin.jobId,
        run_id: 37498376671,
        run_attempt: this.attempts,
        head_sha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
        name: pin.jobName,
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Upload immutable producer payloads',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-10-05T17:20:46Z',
            completed_at: '2026-10-05T17:20:54Z',
          },
        ],
      };
    } else if (endpoint.includes('/actions/artifacts/')) {
      const pin = RECOVERY.producers.find((producer) =>
        endpoint.endsWith(String(producer.artifactId))
      );
      if (!pin) throw new Error('Unknown fixture artifact');
      value = {
        id: pin.artifactId,
        name: pin.name,
        digest: `sha256:${pin.sha256}`,
        expired: false,
        created_at: '2026-10-05T17:20:54Z',
        workflow_run: {
          id: 37498376671,
          head_sha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
          repository_id: 1163183284,
          head_repository_id: 1163183284,
        },
        ...this.artifactMutation,
      };
    } else throw new Error(`Unexpected fixture API: ${endpoint}`);
    return Promise.resolve(value as T);
  }
  archive(): Promise<void> {
    this.archived = true;
    return Promise.reject(new Error('Fixture stops before archive transport'));
  }
  extract(): Promise<void> {
    return Promise.reject(new Error('Unexpected extraction'));
  }
  async verifyBuild(): Promise<void> {
    /* Producer-job fixtures are validated independently below. */
  }
  async upload(repository: string, releaseId: number, file: string): Promise<void> {
    expect(repository).toBe('777genius/agent-teams-ai');
    const bytes = await readFile(file),
      name = path.basename(file);
    this.uploaded.push({ releaseId, bytes, name });
    this.assets.push({
      id: this.assets.length + 100,
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      state: 'uploaded',
    });
    if (this.lostResponse) throw new Error('Upload succeeded but connection reset');
  }
}
async function payloadFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-recovery-payloads-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'payloads'));
  const names = platformNames('2.17.5');
  for (const name of [
    ...names.windows,
    ...names.windows.map((item) => `${item}.blockmap`),
    ...names.linux,
  ])
    await writeFile(path.join(directory, 'payloads', name), `independent fixture bytes: ${name}`);
  return directory;
}

// These regressions reject corrupt ZIP bytes, foreign attempt/artifact metadata,
// conflicting existing assets, and writes to a replacement draft. Successful
// retries must retain original attempt-1 provenance and persist no duplicate bytes.
it('verifies actual archive bytes rather than trusting the metadata digest', async () => {
  const directory = await payloadFixture(),
    archive = path.join(directory, 'archive.zip');
  await writeFile(archive, 'abc');
  const knownSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  await expect(verifyArtifactArchive(archive, knownSha256)).resolves.toBeUndefined();
  await writeFile(archive, 'abd');
  await expect(verifyArtifactArchive(archive, knownSha256)).rejects.toThrow('ZIP digest mismatch');
});
it.skipIf(process.platform === 'win32')(
  'extracts validated ZIP entries and rejects traversal before filesystem writes',
  async () => {
    const directory = await payloadFixture();
    const archive = path.join(directory, 'artifact.zip');
    const destination = path.join(directory, 'extracted');
    const run = promisify(execFile);
    await run('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],"verified ZIP fixture"); z.close()',
      archive,
      'payload.exe',
    ]);
    const port = recoveryPort();
    await port.extract(archive, destination, ['payload.exe']);
    expect(await readFile(path.join(destination, 'payload.exe'), 'utf8')).toBe(
      'verified ZIP fixture'
    );
    const unsafe = path.join(directory, 'unsafe.zip');
    await run('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("../escaped.exe","unsafe"); z.close()',
      unsafe,
    ]);
    await expect(port.extract(unsafe, destination, ['payload.exe'])).rejects.toThrow(
      'payload names mismatch'
    );
    await expect(readFile(path.join(directory, 'escaped.exe'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);
it('requires the original successful upload window and immutable artifact receipt', async () => {
  await expect(validateProducer(new DraftStorage(), 0)).resolves.toBeUndefined();
});
it('accepts original successful producer jobs even when the later draft job failed', async () => {
  const storage = new DraftStorage();
  await expect(recoverDraftPayloads(storage, await payloadFixture())).rejects.toThrow(
    'Fixture stops before archive transport'
  );
  expect(storage.archived).toBe(true);
  expect(storage.uploaded).toHaveLength(0);
});
it.each(['.github/workflows/release.yml', '.github/workflows/foreign.yml'])(
  'rejects a different producer workflow even if generally trusted: %s',
  async (workflow) => {
    const storage = new DraftStorage();
    storage.runPath = workflow;
    await expect(recoverDraftPayloads(storage, await payloadFixture())).rejects.toThrow(
      'build run identity mismatch'
    );
    expect(storage.archived).toBe(false);
  }
);
it('rejects a changed producer event before archive transport', async () => {
  const storage = new DraftStorage();
  storage.runEvent = 'push';
  await expect(recoverDraftPayloads(storage, await payloadFixture())).rejects.toThrow(
    'build run identity mismatch'
  );
  expect(storage.archived).toBe(false);
});
it.each([
  { name: 'draft-win32-x64-2' },
  { digest: `sha256:${'0'.repeat(64)}` },
  { id: 11361141480 },
  { expired: true },
  { created_at: '2026-10-05T17:20:55Z' },
  {
    workflow_run: {
      id: 37342668378,
      head_sha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
      repository_id: 1163183284,
      head_repository_id: 1163183284,
    },
  },
])('rejects a changed artifact receipt before download: %j', async (mutation) => {
  const storage = new DraftStorage();
  storage.artifactMutation = mutation;
  await expect(recoverDraftPayloads(storage, await payloadFixture())).rejects.toThrow(
    /artifact|Artifact/
  );
  expect(storage.archived).toBe(false);
  expect(storage.uploaded).toHaveLength(0);
});
it('rejects attempt-2 jobs even when their conclusion is success', async () => {
  const storage = new DraftStorage();
  storage.attempts = 2;
  await expect(recoverDraftPayloads(storage, await payloadFixture())).rejects.toThrow(
    'job identity mismatch'
  );
  expect(storage.archived).toBe(false);
});
it('appends eight actual payloads and original provenance, then a fresh retry is a no-op', async () => {
  const storage = new DraftStorage();
  await appendDraftPayloads(storage, await payloadFixture(), []);
  expect(storage.uploaded).toHaveLength(9);
  expect(storage.uploaded.every((upload) => upload.releaseId === 404985707)).toBe(true);
  const evidence = storage.uploaded.find(
    (upload) => upload.name === 'build-provenance-37498376671-1.json'
  );
  expect(evidence).toBeDefined();
  const proof: unknown = JSON.parse(evidence?.bytes.toString() ?? 'null');
  expect(proof).toMatchObject({
    runId: 37498376671,
    attempt: 1,
    applicationSha: '36c48514bce010d50d5b74660d2c2ab5a00d233b',
    workflowPath: '.github/workflows/build-linux-windows-draft.yml',
    jobs: [{ id: 112388693906 }, { id: 112388693295 }, { id: 112388693609 }],
  });
  expect(
    storage.uploaded
      .filter((upload) => !upload.name.endsWith('.json'))
      .every((upload) => upload.bytes.toString() === `independent fixture bytes: ${upload.name}`)
  ).toBe(true);
  await appendDraftPayloads(storage, await payloadFixture(), [...storage.assets]);
  expect(storage.uploaded).toHaveLength(9);
});
it('rejects every known collision before the first write', async () => {
  const storage = new DraftStorage();
  storage.assets.push({
    id: 1,
    name: 'agent-teams-ai_2.17.5_amd64.deb',
    size: 10,
    digest: `sha256:${'0'.repeat(64)}`,
    state: 'uploaded',
  });
  await expect(
    appendDraftPayloads(storage, await payloadFixture(), [...storage.assets])
  ).rejects.toThrow('Asset collision');
  expect(storage.uploaded).toHaveLength(0);
});
it('rejects replacement draft identity and changed asset snapshots without mutation', async () => {
  const storage = new DraftStorage();
  storage.draftId = 404009046;
  await expect(appendDraftPayloads(storage, await payloadFixture(), [])).rejects.toThrow(
    'Bound draft identity'
  );
  storage.draftId = 404985707;
  storage.assets.push({
    id: 1,
    name: 'foreign.json',
    size: 0,
    digest: `sha256:${'0'.repeat(64)}`,
    state: 'uploaded',
  });
  await expect(appendDraftPayloads(storage, await payloadFixture(), [])).rejects.toThrow(
    'Draft assets changed'
  );
  expect(storage.uploaded).toHaveLength(0);
});
it('requires an existing target tag to resolve to the original application commit', async () => {
  const storage = new DraftStorage();
  storage.tagSha = '0'.repeat(40);
  await expect(appendDraftPayloads(storage, await payloadFixture(), [])).rejects.toThrow(
    'target tag application SHA changed'
  );
  expect(storage.uploaded).toHaveLength(0);
  storage.tagSha = '36c48514bce010d50d5b74660d2c2ab5a00d233b';
  await appendDraftPayloads(storage, await payloadFixture(), []);
  expect(storage.uploaded).toHaveLength(9);
});
it('reconciles an accepted upload whose response was lost without issuing another POST', async () => {
  const storage = new DraftStorage();
  storage.lostResponse = true;
  await appendDraftPayloads(storage, await payloadFixture(), []);
  expect(storage.uploaded).toHaveLength(9);
  expect(new Set(storage.uploaded.map((upload) => upload.name)).size).toBe(9);
});
