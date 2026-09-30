import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCoreIdentity } from './admission.mjs';
import { assertPublishedTeamIdentity, coreBootstrapHeader, coreLauncherLease, stageAgentTeamsMcp,
  stageOfficialOpenCode } from './run.mjs';

const OFFICIAL_OPENCODE_SHA256 = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080';

// Owner's exact-order key lists (agent_teams_orchestrator bd4c4c46,
// src/services/hostedControl/HostedControlBootstrap.ts): CORE_HEADER_KEYS,
// PERSONAL_HOST_APP_MCP_HEADER_KEYS = [...CORE_HEADER_KEYS, 'appMcp'], CORE_LEASE_KEYS.
const OWNER_CORE_HEADER_KEYS = [
  'format', 'admissionKind', 'restoreGeneration', 'teamId', 'declaredRootHash',
  'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'claudeRoot', 'socketPath',
  'legacyKey', 'bootstrapBinding', 'leaseEvidence',
];
const OWNER_CORE_LEASE_KEYS = ['format', 'launcherLeaseId', 'ownerArtifactDigest',
  'ownerExecutableDigest', 'bootstrapDigest', 'proofKeyId', 'ownerGeneration', 'ownerSessionId'];
const OWNER_BINDING_KEYS = ['deploymentId', 'bootId', 'workspaceId', 'mountGeneration',
  'bootstrapDigest', 'ownerArtifactDigest', 'proofKeyId'];
const OWNER_EVIDENCE_KEYS = ['device', 'inode', 'uid', 'gid', 'mode', 'launcherLeaseId',
  'leaseArtifactDigest'];

test('launcher-finalized personal-host header and lease keep the exact Owner key order', () => {
  const image = Object.freeze({
    ownerArtifactDigest: `sha256:${'a'.repeat(64)}`,
    ownerExecutableDigest: `sha256:${'b'.repeat(64)}`,
    imageReference: `127.0.0.1:5000/core-owner@sha256:${'a'.repeat(64)}`,
  });
  const identity = createCoreIdentity({ image });
  identity.legacyKey = 'sandbox_0123456789abcdef';
  assert.deepEqual(Object.keys(coreLauncherLease(image, identity, 'launcher-lease_x')), OWNER_CORE_LEASE_KEYS);
  const header = coreBootstrapHeader(identity, { claudeRoot: '/tmp/claude', socketPath: '/tmp/owner.sock' });
  // Owner accepts appMcp only with this kind and rejects it under core-lifecycle-v1.
  assert.equal(header.admissionKind, 'core-lifecycle-personal-host-v1');
  const appMcp = { command: '/tmp/m/node', commandSha256: 'c'.repeat(64),
    entry: '/tmp/m/index.js', entrySha256: 'd'.repeat(64) };
  const finalize = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('launcher', sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
header, app_mcp = json.loads(sys.stdin.read())
sys.stdout.buffer.write(launcher.finalize_header(header, os.stat(sys.argv[1]), 'launcher-lease_x', b'lease', app_mcp))`;
  const launcher = fileURLToPath(new URL('./descriptor-launcher.py', import.meta.url));
  for (const mcp of [appMcp, null]) {
    const text = execFileSync('python3', ['-I', '-c', finalize, launcher],
      { input: JSON.stringify([header, mcp]), env: { PYTHONDONTWRITEBYTECODE: '1' } }).toString('utf8');
    const finalized = JSON.parse(text);
    // Owner rejects any byte difference from compact JSON in this key order.
    assert.equal(JSON.stringify(finalized), text);
    assert.deepEqual(Object.keys(finalized),
      mcp ? [...OWNER_CORE_HEADER_KEYS, 'appMcp'] : OWNER_CORE_HEADER_KEYS);
    assert.deepEqual(Object.keys(finalized.bootstrapBinding), OWNER_BINDING_KEYS);
    assert.deepEqual(Object.keys(finalized.leaseEvidence), OWNER_EVIDENCE_KEYS);
    if (mcp) assert.deepEqual(Object.keys(finalized.appMcp), ['command', 'commandSha256', 'entry', 'entrySha256']);
  }
});

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
