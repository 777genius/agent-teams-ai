import assert from 'node:assert/strict';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Add only the same owner's local receipt authority before the existing fixture pin writes. */
export function configureRetainedOpenCodeImportAuthority(
  profile: Record<string, unknown>,
  descriptor: Record<string, unknown>
): { profile: Record<string, unknown>; descriptor: Record<string, unknown> } {
  const owner = record(profile.owner), selected = record(descriptor.defaultOwner);
  for (const field of ['ownerId', 'revision', 'profileId', 'buildId'] as const) {
    const value = owner[field];
    assert.ok(typeof value === 'string' && value.length > 0);
  }
  assert.equal(owner.protocolVersion, 1);
  assert.ok(typeof owner.storageRoot === 'string' && owner.storageRoot.length > 0);
  for (const field of ['nodeSha256', 'hostEntrySha256'] as const) {
    const value = owner[field];
    assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  }
  const principalId = profile.principalId;
  assert.ok(typeof principalId === 'string' && principalId.length > 0 &&
    principalId.length <= 256 && !principalId.includes('\0'));
  const ownerRef = { ownerId: owner.ownerId, revision: owner.revision };
  assert.deepEqual(selected, ownerRef, 'retained fixture uses its original default owner');
  assert.ok(Array.isArray(descriptor.owners));
  const matches = descriptor.owners.map(record).filter(candidate =>
    candidate.ownerId === owner.ownerId && candidate.revision === owner.revision);
  assert.equal(matches.length, 1, 'one exact selected owner');
  const target = matches[0];
  assert.ok(target);
  const targetProfile = record(target.profile);
  assert.equal(target.storageRoot, owner.storageRoot);
  for (const [targetField, ownerField] of [
    ['profileId', 'profileId'], ['expectedBuildId', 'buildId'],
    ['nodeSha256', 'nodeSha256'], ['hostEntrySha256', 'hostEntrySha256'],
  ] as const) assert.equal(targetProfile[targetField], owner[ownerField]);
  const profileCreation = { contextIds: ['local'] };
  const descriptorCreation = {
    owner: ownerRef, contextIds: ['local'], importAuthority: { principalId },
  };
  if (profile.creation !== undefined) assert.deepEqual(profile.creation, profileCreation);
  if (descriptor.creation !== undefined) assert.deepEqual(descriptor.creation, descriptorCreation);
  return {
    profile: { ...profile, creation: profileCreation },
    descriptor: { ...descriptor, creation: descriptorCreation },
  };
}
