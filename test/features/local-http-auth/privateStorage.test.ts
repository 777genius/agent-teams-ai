import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import {
  apiProfileScope,
  preparePrivateFileDirectory,
  publishApiAuthority,
  removeApiAuthority,
} from '@features/local-http-auth/main';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixtureRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(
      path.join(process.platform === 'win32' ? homedir() : tmpdir(), 'private-authority-')
    )
  );
  roots.push(root);
  return root;
}

it('refuses a linked ancestor before creating anything through it', async () => {
  const root = await fixtureRoot(),
    foreign = await fixtureRoot();
  const alias = path.join(root, 'alias');
  await symlink(foreign, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(
    preparePrivateFileDirectory(path.join(alias, 'created', 'credential.json'))
  ).rejects.toThrow();
  await expect(lstat(path.join(foreign, 'created'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('publishes a generation privately with token-free discovery and retires only its own files', async () => {
  const root = await fixtureRoot();
  const authority = {
    schemaVersion: 1 as const,
    service: 'api' as const,
    profileScope: apiProfileScope(root),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl: 'http://127.0.0.1:3456',
    token: 'a'.repeat(64),
  };
  const reference = await publishApiAuthority(root, authority);
  const raw = await readFile(reference, 'utf8');
  expect(raw).not.toContain(authority.token);
  const descriptor = JSON.parse(raw).descriptorPath as string;
  expect(JSON.parse(await readFile(descriptor, 'utf8'))).toEqual(authority);
  if (process.platform !== 'win32') {
    expect((await lstat(path.dirname(reference))).mode & 0o777).toBe(0o700);
    expect((await lstat(descriptor)).mode & 0o777).toBe(0o600);
  }
  await removeApiAuthority(root, authority);
  await expect(readFile(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
});
