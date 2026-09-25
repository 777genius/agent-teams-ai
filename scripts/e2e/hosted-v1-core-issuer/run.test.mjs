import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertPublishedTeamIdentity, stageAgentTeamsMcp, stageOfficialOpenCode } from './run.mjs';

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

test('app MCP staging is all-or-nothing and requires a pinned Node 24 image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-issuer-mcp-input-test-'));
  const entrySource = join(root, 'index.js');
  const entrySha256 = 'a'.repeat(64);
  const nodeImage = `node:24.16.0-slim@sha256:${'b'.repeat(64)}`;
  const extractFile = () => assert.fail('no image may be touched for rejected input');
  try {
    await writeFile(entrySource, 'console.log("mcp")\n');
    const realEntry = await realpath(entrySource);
    assert.equal(await stageAgentTeamsMcp({ root }, {}, { extractFile }), null);
    await assert.rejects(stageAgentTeamsMcp({ root }, { nodeImage }, { extractFile }),
      /entry-source-invalid/u);
    await assert.rejects(stageAgentTeamsMcp({ root }, { entrySource: realEntry, entrySha256 }, { extractFile }),
      /node-image-must-be-pinned-node-24-slim/u);
    for (const image of ['node:24.16.0-slim', `node:22.20.0-slim@sha256:${'b'.repeat(64)}`]) {
      await assert.rejects(stageAgentTeamsMcp({ root }, { entrySource: realEntry, entrySha256, nodeImage: image },
        { extractFile }), /node-image-must-be-pinned-node-24-slim/u);
    }
    await assert.rejects(stageAgentTeamsMcp({ root }, { entrySource: 'index.js', entrySha256, nodeImage },
      { extractFile }), /entry-source-invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stages the app MCP entry and Node as root-owned pinned files', async t => {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    t.skip('requires isolated Linux root');
    return;
  }
  const source = await mkdtemp(join(tmpdir(), 'core-issuer-mcp-source-'));
  const root = await mkdtemp('/tmp/hosted-core-issuer-stage-');
  try {
    const entrySource = join(source, 'index.js');
    await writeFile(entrySource, 'console.log("mcp")\n');
    const entrySha256 = createHash('sha256').update('console.log("mcp")\n').digest('hex');
    const nodeImage = `node:24.16.0-slim@sha256:${'b'.repeat(64)}`;
    const extractFile = async ({ image, source: path, destination }) => {
      assert.equal(image, nodeImage);
      assert.equal(path, '/usr/local/bin/node');
      await copyFile(process.execPath, destination);
    };
    await assert.rejects(stageAgentTeamsMcp({ root: join(root, 'wrong') }, {
      entrySource, entrySha256: 'c'.repeat(64), nodeImage }, { extractFile }), /ENOENT/u);
    await mkdir(join(root, 'wrong'));
    await assert.rejects(stageAgentTeamsMcp({ root: join(root, 'wrong') }, {
      entrySource, entrySha256: 'c'.repeat(64), nodeImage }, { extractFile }), /stage-invalid/u);
    const staged = await stageAgentTeamsMcp({ root }, { entrySource, entrySha256, nodeImage }, { extractFile });
    assert.deepEqual(Object.keys(staged), ['command', 'commandSha256', 'entry', 'entrySha256']);
    assert.equal(staged.entry, join(root, 'agent-teams-mcp', 'index.js'));
    assert.equal(staged.command, join(root, 'agent-teams-mcp', 'node'));
    assert.equal(staged.commandSha256, createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
    for (const [path, mode] of [[staged.entry, 0o444], [staged.command, 0o555],
      [join(root, 'agent-teams-mcp'), 0o555]]) {
      const entry = await lstat(path);
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
      assert.equal(entry.mode & 0o777, mode);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
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
