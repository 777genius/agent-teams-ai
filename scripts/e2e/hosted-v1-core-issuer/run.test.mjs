import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertPublishedTeamIdentity } from './run.mjs';

test('rotation accepts only the Product published team and legacy key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-issuer-published-team-test-'));
  const uid = process.getuid();
  const gid = process.getgid();
  const teamId = `team_${'a'.repeat(32)}`;
  const deploymentId = 'deployment_test123';
  const operationId = `adoption_${'b'.repeat(32)}`;
  const legacyKey = `draft-${operationId.slice(9)}`;
  try {
    const directory = join(root, 'teams', legacyKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const marker = { schemaVersion: 1, operationId, teamId,
      directoryFingerprint: 'c'.repeat(64), rootFingerprint: 'd'.repeat(64),
      teamsFingerprint: 'e'.repeat(64) };
    const identity = { schemaVersion: 1, teamId, createdAt: new Date().toISOString(),
      originDeploymentId: deploymentId };
    await writeFile(join(directory, '.hosted-draft-publication.json'),
      `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await writeFile(join(directory, 'team.identity.json'),
      `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    const observed = await assertPublishedTeamIdentity(root, teamId, legacyKey, deploymentId, uid, gid);
    assert.equal(observed.operationId, operationId);
    await assert.rejects(assertPublishedTeamIdentity(root, `team_${'f'.repeat(32)}`,
      legacyKey, deploymentId, uid, gid), /identity-mismatch/);
    await assert.rejects(assertPublishedTeamIdentity(root, teamId,
      `draft-${'f'.repeat(32)}`, deploymentId, uid, gid), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
