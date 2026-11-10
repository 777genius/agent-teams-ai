import assert from 'node:assert/strict';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
const fixtureRoot = '/Volumes/Transcend/dev/TEST-m19-cold-owner-cpp1gflx/tmp/TEST-desktop-launch-issuer-couk3f/tmp/TEST-desktop-backend-6ZNw8J';
const originalReceiptSha256 = '8ae969880dfc553ee63c5a6a81112de66e43bbf8b301e484f5854391e03e375a';
const originalBeforeSha256 = 'f48f4ea63ee0ea5ed622ba188484a2d5a75d14320703cd0d63623c309d9ae151';
/** TEST continuation of one original failed probe, never bootstrap or capture. */
export function nativeProcessReadbackAction(): 'observe' | 'stop-original' {
  const action = process.env.LEGACY_M19_COLD_UI_ACTION;
  assert.ok(action === 'observe' || action === 'stop-original', 'explicit scoped continuation');
  assert.match(process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID ?? '', /^[A-Za-z0-9]{6}$/);
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined, 'no original crash authority in readback');
  return action;
}
/** Read-only filesystem/source checks; deliberately never imports native custody. */
export async function verifyNativeProcessReadbackSource(root: string, saved: Record<string, unknown>) {
  assert.equal(root, fixtureRoot);
  assert.equal(await realpath(root), root);
  assert.equal(await fileDigest(join(root, 'desktop-backend-receipt.json')), originalReceiptSha256);
  assert.equal(saved.mode, 'native-process-ui');
  assert.equal(saved.status, 'INCOMPLETE', 'original pre-app HOLD remains unchanged');
  assert.equal(await fileDigest(join(root, 'native-process-before-crash.json')), originalBeforeSha256);
  for (const [name, sha256] of [
    ['original-host-crash-requested.json', 'b188de1a1ef86d3e4b2e96bc7c2500123e1341e6211e53d418fcbfb086bbc335'],
    ['original-host-crash-result.json', '9374c60b7a1c0f85479d037108e09663b61696308ff5206bad6a3037113c9f1c'],
    ['original-native-root-observation.json', '5bee4fa078e91111b09c0fa5416d4fb2dd146d3b97e2d6988cf842552ca2d0fb'],
  ] as const) assert.equal(await fileDigest(join(root, name)), sha256, 'original crash/root receipts unchanged');
  const before = await json(join(root, 'native-process-before-crash.json'));
  const primary = row(before.canonicalPrimary), original = row(before.original);
  assert.equal(primary.capturedByCommand, 'TEST-native-process-register-original');
  assert.equal(primary.id, original.id);
  assert.ok(typeof original.processRef === 'string' && original.processRef.startsWith('p1:' + String(primary.id) + ':'));
  const capture = row(primary.capturedNative);
  assert.deepEqual(before.rootCapture, { ...capture, target: structuredClone(capture.root) });
  const registry = row(before.registry);
  assert.equal(registry.path, join(root, 'hoststore/teams/test-desktop-backend/processes.json'));
  assert.equal(await fileDigest(String(registry.path)), registry.sha256, 'original registration bytes unchanged');
  assert.deepEqual(JSON.parse(await readFile(String(registry.path), 'utf8')), [primary]);
  const crash = await json(join(root, 'original-host-crash-result.json'));
  assert.equal(crash.signal, 'SIGKILL');
  assert.equal(crash.nativeCleanupClaim, false);
  const request = await json(join(root, 'original-host-crash-requested.json'));
  assert.equal(request.operation, 'original ChildProcess.kill');
  assert.equal(request.originalHostPid, row(before.host).pid);
  const originalRoot = await json(join(root, 'original-native-root-observation.json'));
  assert.equal(originalRoot.status, 'INCOMPLETE');
  assert.equal(originalRoot.observation, 'same-live');
  assert.equal(originalRoot.runtimeCustody, 'HOLD');
  for (const key of ['signals', 'recaptures', 'adoptions']) assert.equal(originalRoot[key], 0);
  const repo = '/Users/belief/.codex/worktrees/provider-migration-two-stage-plan/old-agent-teams-frontend';
  const artifact = '/Volumes/Transcend/dev/TEST-m19-cold-reboot-prep-xqpztswh/native-artifact';
  const expectedPaths = [
    join(repo, 'scripts/legacy-agent-host/desktop-native-process-host.ts'),
    join(repo, 'packages/legacy-agent-host/src/process/DarwinRegisteredProcess.ts'),
    join(repo, 'packages/legacy-agent-host/dist/process/DarwinRegisteredProcess.js'),
    join(repo, 'packages/legacy-agent-host/dist/composition/processCustody.js'),
    ...['manifest.json', 'registered-process.node', 'registered-process-darwin.c'].map(name => join(artifact, name)),
  ];
  assert.ok(Array.isArray(before.sourceOracle));
  const pins = before.sourceOracle.map(row);
  assert.deepEqual(pins.map(pin => pin.path), expectedPaths);
  assert.deepEqual(originalRoot.sourceOracle, before.sourceOracle);
  for (const pin of pins) {
    assert.equal(await realpath(String(pin.path)), pin.path);
    assert.match(String(pin.sha256), /^[a-f0-9]{64}$/);
    assert.equal(await fileDigest(String(pin.path)), pin.sha256);
  }
  assert.deepEqual(before.processCustody, {
    directory: artifact, manifestSha256: '17cc2429f59a5261dfd65c2af414ed307f669bc271a2bb5f51c131be05cd2278',
  });
  // Capture original immutable business/runtime state before the new Host. No model endpoint starts.
  return {
    originalJobId: '911fe6c78626b3f36b881133bd45bddc', originalReceiptSha256,
    originalBeforeSha256, originalRoot, sourceOracle: pins,
    nativeCleanupClaim: false, runtimeCustody: 'HOLD',
    snapshot: await readNativeProcessReadbackSnapshot(root),
  };
}
/** Exact existing Runtime records and command filenames; no reconciliation or cleanup request. */
export async function readNativeProcessReadbackSnapshot(root: string) {
  assert.equal(root, fixtureRoot);
  const sessions = await readDesktopNativeStopSessions(root);
  assert.equal(sessions.length, 1, 'one original generation; never new allocation');
  const session = sessions[0]!;
  assert.equal(row(session.binding).memberId, 'alice-id');
  assert.equal(row(session.binding).generation, '1');
  const commandsPath = join(root, 'hoststore/teams/test-desktop-backend/.host-owner/commands');
  const commands = (await readdir(commandsPath)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  assert.ok(commands.length <= 128);
  return { sessions, commands };
}
