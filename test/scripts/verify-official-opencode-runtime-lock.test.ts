import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = resolve('scripts/ci/verify-official-opencode-runtime-lock.mjs');
const rootLock = resolve('opencode-hosted-runtime.lock.json');
type MutableLock = {
  releaseRepository: string;
  productionEligible: boolean;
  tag: string;
  source: { commit: string };
  platforms: Record<string, Record<string, string>>;
};

async function verifyMutation(mutate: (lock: MutableLock) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'official-opencode-lock-'));
  try {
    const lock = JSON.parse(await readFile(rootLock, 'utf8')) as MutableLock;
    mutate(lock);
    const file = join(directory, 'lock.json');
    await writeFile(file, JSON.stringify(lock));
    try {
      await run(process.execPath, [script, file]);
      return 'accepted';
    } catch (error) {
      return String(error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('official hosted OpenCode release gate', () => {
  it('accepts the checked-in v1.18.32 lock offline', async () => {
    const { stdout } = await run(process.execPath, [script]);
    expect(stdout).toContain(
      'official-opencode-runtime-lock-ok:v1.18.32:545f51d26cc39a907d2867492d498d9607ea5fa4:6'
    );
  });

  it.each([
    [
      'fork',
      (lock: MutableLock) => {
        lock.releaseRepository = '777genius/opencode-anomaly';
      },
      'release',
    ],
    [
      'ineligible',
      (lock: MutableLock) => {
        lock.productionEligible = false;
      },
      'release',
    ],
    [
      'tag',
      (lock: MutableLock) => {
        lock.tag = 'v1.18.33';
      },
      'release',
    ],
    [
      'commit',
      (lock: MutableLock) => {
        lock.source.commit = '0'.repeat(40);
      },
      'source',
    ],
    [
      'platform missing',
      (lock: MutableLock) => {
        delete lock.platforms['win32-arm64'];
      },
      'platforms',
    ],
    [
      'platform unavailable',
      (lock: MutableLock) => {
        lock.platforms['win32-arm64'] = {
          status: 'unavailable',
          reason: 'artifact_digests_pending',
        };
      },
      'asset:win32-arm64',
    ],
  ])('rejects %s', async (_name, mutation, reason) => {
    expect(await verifyMutation(mutation)).toContain(
      `official-opencode-runtime-lock-invalid:${reason}`
    );
  });

  it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'])(
    'rejects archive and binary digest drift on %s',
    async (platform) => {
      for (const field of ['archiveSha256', 'binarySha256']) {
        const result = await verifyMutation((lock) => {
          lock.platforms[platform][field] = '0'.repeat(64);
        });
        expect(result).toContain(`official-opencode-runtime-lock-invalid:asset:${platform}`);
      }
    }
  );
});
