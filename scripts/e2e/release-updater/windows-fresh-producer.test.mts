import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkFreshAuthority,
  freshInstaller,
  freshSource,
  verifyFreshArchive,
} from './windows-fresh-producer.mts';

import type { FreshAuthority, FreshPins } from './windows-fresh-producer.mts';

const pins: FreshPins = {
  runId: 37577692624,
  attempt: 1,
  jobId: 112650170568,
  artifactId: 123,
  artifactSha256: 'a'.repeat(64),
  testedApplicationSha: freshSource,
};
function authority(): FreshAuthority {
  return {
    run: {
      id: pins.runId,
      run_attempt: 1,
      head_sha: freshSource,
      path: '.github/workflows/build-linux-windows-draft.yml',
      event: 'workflow_dispatch',
      status: 'in_progress',
      head_repository: { full_name: '777genius/agent-teams-ai' },
    },
    jobs: [
      {
        id: pins.jobId,
        run_id: pins.runId,
        name: 'release-win arm64',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-07T00:00:00Z',
        completed_at: '2026-10-07T00:02:00Z',
        steps: [
          {
            name: 'Upload immutable producer payloads',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-10-07T00:01:00Z',
            completed_at: '2026-10-07T00:01:30Z',
          },
        ],
      },
    ],
    artifact: {
      id: 123,
      name: 'draft-win32-arm64-1',
      digest: `sha256:${pins.artifactSha256}`,
      size_in_bytes: 1234,
      expired: false,
      created_at: '2026-10-07T00:01:15Z',
      workflow_run: { id: pins.runId, head_sha: freshSource },
    },
  };
}
// A changed source, foreign/unfinished job, stale attempt or substituted archive must fail before NSIS.
void test('one immutable successful ARM producer is admitted while aggregate build remains active', () => {
  assert.doesNotThrow(() => checkFreshAuthority(authority(), pins));
  const mutations: ((value: FreshAuthority) => void)[] = [
    (value) => {
      value.run.head_sha = 'f'.repeat(40);
    },
    (value) => {
      value.run.head_repository.full_name = 'foreign/repo';
    },
    (value) => {
      value.run.id++;
    },
    (value) => {
      value.run.run_attempt++;
    },
    (value) => {
      value.run.path = '.github/workflows/other.yml';
    },
    (value) => {
      value.run.event = 'push';
    },
    (value) => {
      const job = value.jobs[0];
      assert(job);
      job.id++;
    },
    (value) => {
      const job = value.jobs[0];
      assert(job);
      job.run_id++;
    },
    (value) => {
      const job = value.jobs[0];
      assert(job);
      job.conclusion = 'failure';
    },
    (value) => {
      const job = value.jobs[0];
      assert(job);
      job.steps = [];
    },
    (value) => {
      value.artifact.name = 'draft-win32-x64-1';
    },
    (value) => {
      value.artifact.digest = `sha256:${'f'.repeat(64)}`;
    },
    (value) => {
      value.artifact.expired = true;
    },
    (value) => {
      value.artifact.workflow_run.head_sha = 'f'.repeat(40);
    },
    (value) => {
      value.artifact.created_at = '2026-10-07T00:02:01Z';
    },
  ];
  for (const mutate of mutations) {
    const value = authority();
    mutate(value);
    assert.throws(() => checkFreshAuthority(value, pins));
  }
  assert.throws(() =>
    checkFreshAuthority(authority(), { ...pins, testedApplicationSha: 'f'.repeat(40) })
  );
});
function zip(names = [freshInstaller, `${freshInstaller}.blockmap`], mode = 0x8000) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [index, name] of names.entries()) {
    const nameBytes = Buffer.from(name),
      data = Buffer.from(`source-byte-fixture-${index}`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
void test('actual ZIP bytes: full digest/size and all paths/types are checked before extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-fresh-arm-byte-boundary-'));
  try {
    const variants = [
      zip(),
      zip(['../escape.exe', `${freshInstaller}.blockmap`]),
      zip([freshInstaller, freshInstaller]),
      zip(undefined, 0xa000),
    ];
    for (const [index, bytes] of variants.entries()) {
      const archive = path.join(root, `${index}.zip`),
        output = path.join(root, `output-${index}`);
      await mkdir(output);
      await writeFile(archive, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      await assert.rejects(
        verifyFreshArchive(archive, output, 'f'.repeat(64), bytes.length),
        /ZIP hash/
      );
      await assert.rejects(verifyFreshArchive(archive, output, sha, bytes.length + 1), /ZIP size/);
      assert.deepEqual(await readdir(output), []);
      if (index > 0) {
        await assert.rejects(verifyFreshArchive(archive, output, sha, bytes.length));
        assert.deepEqual(await readdir(output), []);
      } else {
        const result = await verifyFreshArchive(archive, output, sha, bytes.length);
        assert.equal(result.ledger.length, 2);
        assert.equal(
          (await readFile(path.join(output, freshInstaller))).toString(),
          'source-byte-fixture-0'
        );
        assert.equal(
          (await readFile(path.join(output, `${freshInstaller}.blockmap`))).toString(),
          'source-byte-fixture-1'
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
