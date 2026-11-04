import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';

import {
  cleanupPublicationHelperFixture,
  configurePublicationHelperFixture,
  preparePublicationHelperFixture,
  retirePublicationHelperFixture,
} from './publicationHelperFixture';

let apiProfileScope: typeof import('@features/local-http-auth/main').apiProfileScope;
let preparePrivateFileDirectory: typeof import('@features/local-http-auth/main').preparePrivateFileDirectory;
let publishApiAuthority: typeof import('@features/local-http-auth/main').publishApiAuthority;
let removeApiAuthority: typeof import('@features/local-http-auth/main').removeApiAuthority;
beforeAll(preparePublicationHelperFixture);
beforeEach(async () => {
  expectedRetirementFailures = 0;
  vi.resetModules();
  await configurePublicationHelperFixture();
  ({
    apiProfileScope,
    preparePrivateFileDirectory,
    publishApiAuthority,
    removeApiAuthority,
  } = await import('@features/local-http-auth/main'));
});
afterAll(cleanupPublicationHelperFixture);

const roots: string[] = [];
let expectedRetirementFailures = 0;
afterEach(async () => {
  await retirePublicationHelperFixture(expectedRetirementFailures);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixtureRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(homedir(), 'TEST-private-authority-')),
  );
  roots.push(root);
  return root;
}

it('refuses a linked ancestor before creating anything through it', async () => {
  const root = await fixtureRoot(),
    foreign = await fixtureRoot();
  const alias = path.join(root, 'alias');
  await symlink(
    foreign,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(
    preparePrivateFileDirectory(path.join(alias, 'created', 'credential.json')),
  ).rejects.toThrow();
  await expect(lstat(path.join(foreign, 'created'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
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

function authorityFor(root: string) {
  return {
    schemaVersion: 1 as const,
    service: 'api' as const,
    profileScope: apiProfileScope(root),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl: 'http://127.0.0.1:3456',
    token: 'a'.repeat(64),
  };
}

it('retains an exactly committed generation when manual discovery becomes invalid', async () => {
  expectedRetirementFailures = 1;
  const root = await fixtureRoot();
  const authority = authorityFor(root);
  const reference = await publishApiAuthority(root, authority);
  const before = await readFile(reference, 'utf8');
  const descriptor = JSON.parse(before).descriptorPath;
  await writeFile(path.join(root, 'team-control-api.json'), '{}\n', {
    mode: 0o600,
  });
  await expect(publishApiAuthority(root, authority)).rejects.toThrow();
  expect(await readFile(reference, 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(descriptor, 'utf8'))).toEqual(authority);
});

it('does not treat an orphan descriptor or unsafe current reference as committed', async () => {
  expectedRetirementFailures = 1;
  const root = await fixtureRoot();
  const authority = authorityFor(root);
  const reference = await publishApiAuthority(root, authority);
  const descriptor = JSON.parse(
    await readFile(reference, 'utf8'),
  ).descriptorPath;
  await rm(reference);
  await writeFile(path.join(root, 'team-control-api.json'), '{}\n', {
    mode: 0o600,
  });
  await expect(publishApiAuthority(root, authority)).rejects.toThrow();
  await expect(readFile(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(path.join(root, 'team-control-api.json'));
  await publishApiAuthority(root, authority);
  await writeFile(reference, '{}\n', { mode: 0o600 });
  await expect(publishApiAuthority(root, authority)).rejects.toThrow();
  await expect(readFile(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves the committed previous generation and foreign manual publisher on a failed replacement', async () => {
  expectedRetirementFailures = 1;
  const root = await fixtureRoot();
  const previous = authorityFor(root);
  const reference = await publishApiAuthority(root, previous);
  const oldReference = await readFile(reference, 'utf8');
  const foreign = authorityFor(root);
  const foreignReference = await publishApiAuthority(root, foreign);
  const foreignBefore = await readFile(foreignReference, 'utf8');
  const foreignManual =
    JSON.stringify({ ...JSON.parse(foreignBefore), unexpected: true }) + '\n';
  await writeFile(path.join(root, 'team-control-api.json'), foreignManual, {
    mode: 0o600,
  });
  const replacement = {
    ...previous,
    generation: randomUUID(),
    token: 'b'.repeat(64),
  };
  await expect(publishApiAuthority(root, replacement)).rejects.toThrow();
  expect(await readFile(reference, 'utf8')).toBe(oldReference);
  expect(await readFile(path.join(root, 'team-control-api.json'), 'utf8')).toBe(
    foreignManual,
  );
  expect(await readFile(foreignReference, 'utf8')).toBe(foreignBefore);
  expect(
    JSON.parse(
      await readFile(JSON.parse(foreignBefore).descriptorPath, 'utf8'),
    ),
  ).toEqual(foreign);
  expect(
    JSON.parse(await readFile(JSON.parse(oldReference).descriptorPath, 'utf8')),
  ).toEqual(previous);
  await expect(
    readFile(
      path.join(
        root,
        'local-http-auth',
        `api-${replacement.instanceId}-${replacement.generation}.json`,
      ),
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not delete an immutable existing descriptor when the attempted credentials differ', async () => {
  const root = await fixtureRoot();
  const authority = authorityFor(root);
  const reference = await publishApiAuthority(root, authority);
  const before = await readFile(reference, 'utf8');
  await expect(
    publishApiAuthority(root, { ...authority, token: 'b'.repeat(64) }),
  ).rejects.toThrow('immutable');
  expect(await readFile(reference, 'utf8')).toBe(before);
  expect(
    JSON.parse(await readFile(JSON.parse(before).descriptorPath, 'utf8')),
  ).toEqual(authority);
});
