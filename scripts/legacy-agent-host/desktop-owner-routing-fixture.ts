import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { digest, fileDigest } from './desktop-backend-fixture.ts';

import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';

type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
export type OwnerRoutingRow = Record<string, unknown>;
export const ownerRoutingRow = (value: unknown): OwnerRoutingRow => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as OwnerRoutingRow;
};
export const ownerRoutingJson = async (path: string): Promise<OwnerRoutingRow> =>
  ownerRoutingRow(JSON.parse(await readFile(path, 'utf8')));

/** Original single-owner epoch only: save-only admission adds no Runtime or provider. */
export async function prepareDesktopOwnerRoutingSource(fixture: Fixture): Promise<Fixture> {
  const profile = await ownerRoutingJson(fixture.profilePath);
  const descriptor = await ownerRoutingJson(fixture.descriptorPath);
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  assert.equal(descriptor.creation, undefined);
  const owners = descriptor.owners as unknown[];
  assert.equal(owners.length, 1);
  profile.creation = { contextIds: ['local'] };
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  const selected = ownerRoutingRow(owners[0]);
  const client = ownerRoutingRow(selected.profile);
  ownerRoutingRow(client.env).LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
  descriptor.creation = { owner: structuredClone(descriptor.defaultOwner), contextIds: ['local'] };
  const bytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, bytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  fixture.pins.descriptorSha256 = digest(bytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = digest(bytes);
  return fixture;
}

/** A second physical TEST root; never a directory inside the first owner's storage. */
export async function prepareDesktopOwnerRoutingContinuation(fixture: Fixture) {
  assert.equal(await realpath(fixture.root), fixture.root);
  assert.match(basename(fixture.root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const originalDescriptorBytes = await readFile(fixture.descriptorPath);
  const originalProfileBytes = await readFile(fixture.profilePath);
  const descriptor = ownerRoutingRow(JSON.parse(originalDescriptorBytes.toString('utf8')));
  const a = ownerRoutingRow(JSON.parse(originalProfileBytes.toString('utf8')));
  assert.equal(a.runtime, undefined);
  assert.equal(a.management, undefined);
  assert.deepEqual(a.creation, { contextIds: ['local'] });
  assert.equal((descriptor.owners as unknown[]).length, 1);
  const originalOwner = ownerRoutingRow((descriptor.owners as unknown[])[0]);
  const bRoot = await realpath(await mkdtemp(join(dirname(fixture.root), 'TEST-desktop-backend-')));
  assert.notEqual(bRoot, fixture.root);
  assert.equal(dirname(bRoot), dirname(fixture.root));
  for (const name of ['home', 'tmp', 'workspace', 'hoststore'])
    await mkdir(join(bRoot, name), { mode: 0o700 });
  const proofRoot = join(fixture.root, 'owner-routing');
  await mkdir(proofRoot, { mode: 0o700 });
  const owner = {
    ...ownerRoutingRow(a.owner),
    ownerId: 'TEST-routing-owner-' + basename(bRoot),
    profileId: 'TEST-routing-profile-' + basename(bRoot),
    revision: ownerRoutingRow(a.owner).revision,
    storageRoot: join(bRoot, 'hoststore'),
  };
  const b = {
    schemaVersion: 1,
    owner,
    principalId: a.principalId,
    creation: { contextIds: ['local'] },
    teams: [],
  };
  const bProfilePath = join(bRoot, 'host-profile.json');
  const bBytes = JSON.stringify(b);
  await writeFile(bProfilePath, bBytes, { flag: 'wx', mode: 0o600 });
  const client = structuredClone(ownerRoutingRow(originalOwner.profile));
  client.profileId = owner.profileId;
  client.cwd = join(bRoot, 'workspace');
  client.env = {
    ...ownerRoutingRow(client.env),
    HOME: join(bRoot, 'home'),
    TMPDIR: join(bRoot, 'tmp'),
    LEGACY_AGENT_HOST_PROFILE_PATH: bProfilePath,
    LEGACY_AGENT_HOST_PROFILE_SHA256: digest(bBytes),
  };
  const bOwner = {
    ownerId: owner.ownerId,
    revision: owner.revision,
    storageRoot: owner.storageRoot,
    profile: client,
  };
  const ref = { ownerId: owner.ownerId, revision: owner.revision };
  const switched = {
    ...descriptor,
    owners: [...(descriptor.owners as unknown[]), bOwner],
    defaultOwner: ref,
    creation: { owner: ref, contextIds: ['local'] },
  };
  await writeFile(join(proofRoot, 'original-descriptor.json'), originalDescriptorBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(proofRoot, 'original-owner-a-profile.json'), originalProfileBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(proofRoot, 'owner-b-profile.json'), bBytes, { flag: 'wx', mode: 0o600 });
  return {
    proofRoot,
    bRoot,
    bProfilePath,
    bProfileSha256: digest(bBytes),
    originalDescriptorBytes,
    originalProfileBytes,
    descriptor,
    switched,
    bOwner,
    async install(name: 'default-b' | 'unavailable-a' | 'rollback-a', value: OwnerRoutingRow) {
      const bytes = JSON.stringify(value);
      const path = join(proofRoot, name + '-descriptor.json');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(fixture.descriptorPath, bytes, { mode: 0o600 });
      return {
        path,
        sha256: digest(bytes),
        environment: {
          ...fixture.appEnvironment,
          AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: digest(bytes),
        },
      };
    },
  };
}
