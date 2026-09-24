import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertPublishedTeamIdentity, stageOfficialOpenCode } from './run.mjs';

const OFFICIAL_OPENCODE_SHA256 = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080';

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

test('stages a nonroot official OpenCode source as root-owned immutable binary', async t => {
  const sourcePath = process.env.CORE_ISSUER_OFFICIAL_OPENCODE_SOURCE;
  if (process.platform !== 'linux' || process.getuid() !== 0 || !sourcePath) {
    t.skip('requires isolated Linux root and an exact official OpenCode test binary');
    return;
  }
  const sourceBefore = await lstat(sourcePath);
  assert.equal(sourceBefore.isFile(), true);
  assert.notEqual(sourceBefore.uid, 0);
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
    OFFICIAL_OPENCODE_SHA256);
  const root = await mkdtemp('/tmp/hosted-core-issuer-stage-');
  try {
    const installed = await stageOfficialOpenCode({ root }, sourcePath);
    const staged = await lstat(installed);
    assert.equal(staged.isFile(), true);
    assert.equal(staged.uid, 0);
    assert.equal(staged.gid, 0);
    assert.equal(staged.nlink, 1);
    assert.equal(staged.mode & 0o777, 0o555);
    assert.equal(createHash('sha256').update(await readFile(installed)).digest('hex'),
      OFFICIAL_OPENCODE_SHA256);
    const sourceAfter = await lstat(sourcePath);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.equal(sourceAfter.uid, sourceBefore.uid);
    assert.equal(sourceAfter.gid, sourceBefore.gid);
    assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
      OFFICIAL_OPENCODE_SHA256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
