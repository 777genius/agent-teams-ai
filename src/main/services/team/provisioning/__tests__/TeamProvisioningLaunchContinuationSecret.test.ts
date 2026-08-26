import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureLaunchContinuationSecret } from '../TeamProvisioningLaunchContinuationSecret';

const tempDirectories: string[] = [];

async function makeSecretPath(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'continuation-secret-'));
  tempDirectories.push(directory);
  return path.join(directory, 'identity', 'continuation.key');
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true }))
  );
});

describe('ensureLaunchContinuationSecret', () => {
  it('creates a private restart-stable secret without exposing its raw stored value', async () => {
    const secretPath = await makeSecretPath();
    const first = await ensureLaunchContinuationSecret({ secretPath });
    const second = await ensureLaunchContinuationSecret({ secretPath, allowCreate: false });
    const persisted = await fs.promises.readFile(secretPath, 'utf8');

    expect(second).toBe(first);
    expect(first).toMatch(/^launch-continuation-hmac-v1:[a-f0-9]{64}$/);
    expect(first).not.toBe(persisted.trim());
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed instead of replacing a missing secret for persisted evidence', async () => {
    const secretPath = await makeSecretPath();

    await expect(
      ensureLaunchContinuationSecret({ secretPath, allowCreate: false })
    ).rejects.toThrow('unavailable for persisted evidence');
    await expect(fs.promises.stat(secretPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for an invalid or non-private persisted secret', async () => {
    const secretPath = await makeSecretPath();
    await fs.promises.mkdir(path.dirname(secretPath), { recursive: true });
    await fs.promises.writeFile(secretPath, 'not-a-secret\n', { mode: 0o600 });
    await expect(ensureLaunchContinuationSecret({ secretPath })).rejects.toThrow('invalid');

    await fs.promises.writeFile(secretPath, `v1:${'a'.repeat(64)}\n`, { mode: 0o644 });
    if (process.platform !== 'win32') {
      await fs.promises.chmod(secretPath, 0o644);
      await expect(ensureLaunchContinuationSecret({ secretPath })).rejects.toThrow('not private');
    }
  });
});
