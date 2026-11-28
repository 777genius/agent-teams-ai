import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpoint, digest, jsonDigest, originalHistoryMarker } from './desktop-resume-records.ts';
import { CONTEXT_MARKER, REQUIRED_TOOLS, startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { parseDesktopCodexSourceInputs, seedDesktopCodexResumeOwner } from './desktop-codex-resume-fixture.ts';
import { verifyDesktopNativeFreeze } from './desktop-source-freeze.ts';
import { captureCodexCodeModeProcess, observeCodexCodeModeProcess } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const thread = '019a1234-5678-7000-8000-123456789abc';
const callIds = Array.from({ length: 7 }, (_, index) => `native_CODEX_TEAM_ONE_${index}`);

test('original CodeMode helper witness binds parent, executable and birth without adopting a reused PID', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST codex helper identity ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeInputs = await Promise.all(['codex', 'codex-code-mode-host'].map(async name => {
    const path = join(root, name), bytes = `TEST-${name}; never executed`;
    await writeFile(path, bytes, { mode: 0o755 });
    return { path, sha256: digest(bytes) };
  }));
  const codex = { pid: 300, parentPid: 200, groupId: 300, birth: 'Wed Oct 28 16:00:00 2026', command: nativeInputs[0]!.path };
  const helper = { pid: 301, parentPid: 300, groupId: 301, birth: 'Wed Oct 28 16:00:01 2026', command: nativeInputs[1]!.path };
  const witness = await captureCodexCodeModeProcess(200, nativeInputs, () => [codex, helper]);
  assert.deepEqual(witness.helper, helper); assert.deepEqual(witness.codex, codex);
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex, helper]).state, 'same-live');
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex]).state, 'absent');
  for (const changed of [{ ...helper, birth: 'Wed Oct 28 16:01:01 2026' },
    { ...helper, parentPid: 1 }, { ...helper, command: nativeInputs[0]!.path }, { ...helper, groupId: 300 }])
    assert.equal(observeCodexCodeModeProcess(witness, () => [codex, changed]).state, 'identity-mismatch');
  assert.deepEqual(witness.firstIdentityMismatch, { ...helper, birth: 'Wed Oct 28 16:01:01 2026' });
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex]).state, 'absent');
  assert.deepEqual(witness.helper, helper, 'original saved identity is never adopted or replaced');
  assert.deepEqual(witness.firstIdentityMismatch, { ...helper, birth: 'Wed Oct 28 16:01:01 2026' }, 'absence retains the first drift fact');
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex]), /helper must be observed/);
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex, { ...helper, parentPid: 999 }]), /helper must be observed/);
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex, helper, { ...helper, pid: 302 }]), /helper must be observed/);
});

test('external native pair freeze retains a failed flow and refuses changed or missing companions after cleanup', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST codex native freeze ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(['codex', 'codex-code-mode-host'].map(async name => {
    const path = join(root, name), bytes = `TEST-${name}; never executed`;
    await writeFile(path, bytes, { mode: 0o755 });
    return { path, sha256: digest(bytes) };
  }));
  const candidate = {
    "kind": "TEST_CODEX_CANDIDATE_INPUTS_V1",
    "version": "0.169.0",
    "target": "aarch64-apple-darwin",
    "archive": {
      "name": "codex-npm-darwin-arm64-0.169.0.tgz",
      "bytes": 153831622,
      "sha256": "d67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d"
    },
    "files": [
      {
        "path": "package/README.md",
        "bytes": 3334,
        "mode": 384,
        "sha256": "ba4e1f69ff48386e72a9c5e1edaf76aad64a475c2d51af79ccba6d1128261ba7"
      },
      {
        "path": "package/package.json",
        "bytes": 517,
        "mode": 384,
        "sha256": "562ad7506d539ba099c54ada0981587fe99791299c71fb506e5c04d86217a081"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/bin/codex",
        "bytes": 280704736,
        "mode": 448,
        "sha256": "739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/bin/codex-code-mode-host",
        "bytes": 70426256,
        "mode": 448,
        "sha256": "10feae2abe764bcf2273e241ace67aecc360eb8c28a82a2988bf1d8498a9bacf"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-package.json",
        "bytes": 200,
        "mode": 384,
        "sha256": "3723fe22480c3863025f2e09a89c912f1e3906b9e70d57077d51deb555a8b6b3"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-path/rg",
        "bytes": 4030432,
        "mode": 448,
        "sha256": "2caf75aae63d8fd944456686d5241f4864f5e2a930e0a93434e121873f7ff6bf"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/NOTICE.md",
        "bytes": 2403,
        "mode": 384,
        "sha256": "40097a1799441051aa0b6645cdc819cceb19be73cdd265eb602aa2b15e0b1f48"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/bin/codex-voice-host",
        "bytes": 9717888,
        "mode": 448,
        "sha256": "64ddf43fdbb4a9c48cb0c8371034e9a1cb412c9471b3ad2728e72dcabc548b8d"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libffi.8.dylib",
        "bytes": 136768,
        "mode": 448,
        "sha256": "2ab52271c2826e256754936fe2479511cd56c052e7ad151b78d744f8089a794e"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgio-2.0.0.dylib",
        "bytes": 1903344,
        "mode": 448,
        "sha256": "4f976ee37b12a75db9a5f0aa12d608fa4100533cf85b71b619651cbafb90472c"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libglib-2.0.0.dylib",
        "bytes": 1354064,
        "mode": 448,
        "sha256": "3552e5dddc6afc2bbbb5000b15eccdd3b9518f6371b481543d7aa0e1017f5a42"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgmodule-2.0.0.dylib",
        "bytes": 68720,
        "mode": 448,
        "sha256": "fe3616bda97af2cc4f37aacc073daefaed0935e9bec22caa194510b2f4ed2863"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgobject-2.0.0.dylib",
        "bytes": 417008,
        "mode": 448,
        "sha256": "696b25cad9b6d899aa550be9ab0b2d3f0711e9cf13aff9d6c5ca7a6092bdb727"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstapp-1.0.0.dylib",
        "bytes": 151984,
        "mode": 448,
        "sha256": "4a950388fca25b938cd69357d3fc86f60e9923cbb89c5b90ecd816fa03d88310"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstaudio-1.0.0.dylib",
        "bytes": 560384,
        "mode": 448,
        "sha256": "8f8a27c208c7361c62368530d1906c200c70fbafaa127f7d1444fbac6489d9dc"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstbase-1.0.0.dylib",
        "bytes": 520256,
        "mode": 448,
        "sha256": "6c33491f03b6d1dfa9848847a3434ef08f35f7a7fe296f4b36b8f214541a5d4e"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstnet-1.0.0.dylib",
        "bytes": 115920,
        "mode": 448,
        "sha256": "08b3faee5e02158f0a64937713c1711687635bb11beb695e02c9af5d1b10376c"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstpbutils-1.0.0.dylib",
        "bytes": 323568,
        "mode": 448,
        "sha256": "4f0e07a5cd48b75f03115191afc0dd304a411c762d26b06ec2dbd9ec9a9c3be1"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstreamer-1.0.0.dylib",
        "bytes": 1357856,
        "mode": 448,
        "sha256": "a536ba764b3bc4efa788092e833b4d2a0fe3d266087eac94d18fe9c564e83b8d"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstrtp-1.0.0.dylib",
        "bytes": 222192,
        "mode": 448,
        "sha256": "d6e7d328bcefeab0247e93dbc99ffacb61ee675e0263a58de34d0c6926724f40"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgsttag-1.0.0.dylib",
        "bytes": 283280,
        "mode": 448,
        "sha256": "dfef74604fa0b2aceb3123264dbe7fbe08174ff6444d06b507ce95eb4f2f5ad8"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libgstvideo-1.0.0.dylib",
        "bytes": 948944,
        "mode": 448,
        "sha256": "b36c553f4e0b617ce3bbe899ea364e8933a5989d6e8e8023cbb0084f58b36468"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libintl.8.dylib",
        "bytes": 50080,
        "mode": 448,
        "sha256": "3968aa5cf61ca4faffc06c2f1c87b7e865081f30187642f8e357b261b3683c1e"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libopus.0.dylib",
        "bytes": 520480,
        "mode": 448,
        "sha256": "0e180129087bf3c4aa525826f5de674819b12089799b80a720b1d4e429568386"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libpcre2-8.0.dylib",
        "bytes": 456832,
        "mode": 448,
        "sha256": "276883a87bae2b24066a0a8506d5a8eb1e5b24637b4518179a2e1a18efeb2dfd"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/lib/libz.1.dylib",
        "bytes": 139712,
        "mode": 448,
        "sha256": "855c3792a7745d354edffabe4262282f440a9a0b763f96720e1cad9124b2d131"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/LGPL-2.1.txt",
        "bytes": 26431,
        "mode": 384,
        "sha256": "ad2eec519ebd4b5df86ea84dff24ae3bfa2edea846a703b58902dd221ae375db"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/Opus.txt",
        "bytes": 1945,
        "mode": 384,
        "sha256": "01e1167d54a096d123cf6dfbbeb19587278845c6481d2d66d545669846079551"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/PCRE2.md",
        "bytes": 4011,
        "mode": 384,
        "sha256": "197d8a73ffee0d6b09adba2f9c677b5f5aede24edf89258a68e48248d010d811"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/libffi.txt",
        "bytes": 1132,
        "mode": 384,
        "sha256": "17b64dc60f3b6897a60f971e288b973f655c2edcdf08b25f3c3dd5549857881c"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/proxy-libintl.txt",
        "bytes": 25292,
        "mode": 384,
        "sha256": "d245807f90032872d1438d741ed21e2490e1175dc8aa3afa5ddb6c8e529b58e5"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/sljit.txt",
        "bytes": 1444,
        "mode": 384,
        "sha256": "5f216505c0f6ea3273caec89e766eef93cdeb7bbb0c429f9360116d7c938feeb"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/licenses/zlib.txt",
        "bytes": 1002,
        "mode": 384,
        "sha256": "e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/manifest.json",
        "bytes": 4637,
        "mode": 384,
        "sha256": "de47c1e0b9145db978ef68e4daa1c65dd84a9e99dc3c9428408bda019ffa8cff"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstapp.dylib",
        "bytes": 49872,
        "mode": 448,
        "sha256": "17a675734988c9e9ef2ab302d224e88377ebaacecfd030f5e6a6bd66888c95f7"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstaudioconvert.dylib",
        "bytes": 93344,
        "mode": 448,
        "sha256": "eda25a99dcad6e55e658ff80fbd1549da88599da52aa044d53455686f69d92bd"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstaudioresample.dylib",
        "bytes": 91696,
        "mode": 448,
        "sha256": "22255b2f1d3d3454eb0b6a6e6d164a36718541ade4d754360349653dcac18897"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstcoreelements.dylib",
        "bytes": 458832,
        "mode": 448,
        "sha256": "b3f4fa41813cead8efdb868d6041d93a6dd836093a021d49946fb542a6f59e7e"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstopus.dylib",
        "bytes": 131120,
        "mode": 448,
        "sha256": "811090a156458a6f785e9ed8af177474f8c2ff0eef94ebd314bf868936e622f3"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstrtp.dylib",
        "bytes": 674960,
        "mode": 448,
        "sha256": "59cb4fbee05d95ff65a5bfa1c987dcf527302af9614a78140fd6fcbf3f514bcc"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/plugins/libgstrtpmanager.dylib",
        "bytes": 538400,
        "mode": 448,
        "sha256": "6c37e475550f75f738a17fe658313240575036ef851ef7a49ca15d3665cfa743"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/runtime.json",
        "bytes": 14915,
        "mode": 448,
        "sha256": "dde0d887565dd84755db7346966cc0ce67bcabc6b1d1105b0e4e8928697f551a"
      },
      {
        "path": "package/vendor/aarch64-apple-darwin/codex-resources/voice/sources.json",
        "bytes": 4911,
        "mode": 384,
        "sha256": "5613f37012effc3e28cdad52a7c88b9098aaaf7aae43f3cb7199f55ffbb15908"
      }
    ]
  };
  const selected = parseDesktopCodexSourceInputs(candidate);
  assert.equal(selected.version, '0.169.0'); assert.equal(selected.files.length, 43);
  assert.deepEqual(selected.files, candidate.files);
  for (const changed of [
    { ...candidate, version: '0.170.0' },
    { ...candidate, files: candidate.files.filter(row => !row.path.endsWith('/bin/codex-code-mode-host')) },
    { ...candidate, files: candidate.files.map(row => row.path.endsWith('/bin/codex-code-mode-host') ? { ...row, sha256: 'a'.repeat(64) } : row) },
  ]) assert.throws(() => parseDesktopCodexSourceInputs(changed));
  const originalFailure = 'TEST original business failure';
  const good: Record<string, unknown> = { status: 'INCOMPLETE', originalFailure };
  await verifyDesktopNativeFreeze(before, good);
  assert.deepEqual(good.selectedNativeInputHashesAfterCleanup, before);
  assert.equal(good.nativeInputFreezeFailure, undefined);
  for (const change of [
    () => writeFile(before[1]!.path, 'CHANGED helper'),
    () => rm(before[1]!.path),
    () => symlink(before[0]!.path, before[1]!.path),
    async () => { await rm(before[1]!.path); await writeFile(before[1]!.path, 'TEST-codex-code-mode-host; never executed'); await chmod(before[1]!.path, 0o644); },
  ]) {
    await change();
    const failed: Record<string, unknown> = { status: 'PASS', originalFailure };
    await verifyDesktopNativeFreeze(before, failed);
    assert.equal(failed.status, 'INCOMPLETE');
    assert.equal(failed.originalFailure, originalFailure);
    assert.equal(typeof failed.nativeInputFreezeFailure, 'string');
  }
});

test('Codex sidebar seed persists final settings once without a roster or delivery transition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-codex-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hoststore'));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-desktop-backend' };
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'TEST-human',
    owner: { ownerId: 'TEST-owner', revision: 'TEST-revision', storageRoot: join(root, 'hoststore'), profileId: 'TEST-profile',
      protocolVersion: 1, buildId: 'TEST-build', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    teams: [{ binding, scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
      runId: 'TEST-run', memberId: 'human', generation: '1' },
      savedSettings: { cwd: join(root, 'workspace'), providerId: 'codex', model: 'TEST-retained-native-model', effort: 'low' },
      members: [{ memberId: 'alice-id', name: 'alice', role: 'lead', delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' } }],
      grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] }] }],
  };
  const selected = profile.teams[0]!, seeded = await seedDesktopCodexResumeOwner(root, profile);
  assert.deepEqual(seeded.savedSettings, selected.savedSettings);
  const reopened = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding, members: selected.members, grants: selected.grants,
    savedSettings: { cwd: join(root, 'workspace'), providerId: 'anthropic', model: 'TEST-obsolete-base-model' } }).connect(profile.principalId);
  assert.deepEqual(reopened.readRoster().savedSettings, selected.savedSettings, 'reopen hydrates persisted Codex choice, not obsolete base options');
  assert.equal(reopened.listTasks().length, 1); assert.equal(reopened.listTasks()[0]!.id, seeded.uiSeed.taskId);
  const state = JSON.parse(await readFile(join(root, 'hoststore/teams/test-desktop-backend/.host-owner/state.json'), 'utf8'));
  assert.deepEqual(state.members, selected.members); assert.deepEqual(state.runtimeCaptures ?? [], []);
  assert.equal(state.rosterVersion ?? 0, 0); assert.deepEqual(state.rosterCommands ?? [], []);
  assert.ok(state.grants.every((grant: { revoked?: boolean }) => grant.revoked !== true));
  await assert.rejects(seedDesktopCodexResumeOwner(root, profile), 'never reseed an existing canonical owner');
});

test('Codex checkpoint proof requires exact captured thread metadata and preserves original payload bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-codex-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'native-codex/config'), cwd = join(root, 'workspace');
  const sessions = join(home, 'sessions/2026/10/28');
  for (const path of [sessions, cwd, join(root, 'hoststore/runtime-checkpoints')]) await mkdir(path, { recursive: true });
  const profilePath = join(root, 'host-profile.json');
  const member = { provider: 'codex', teamId: 'TEST-team', memberId: 'alice-id', cwd, environment: { CODEX_HOME: home } };
  const saveProfile = (value: unknown) => writeFile(profilePath, JSON.stringify({ runtime: { members: [value] } }));
  await saveProfile(member);
  const binding = { teamId: 'TEST-team', memberId: 'alice-id', generation: '1' };
  const config = { sessionId: 'TEST-derived-captured-session' };
  const historyDigest = jsonDigest({ baseline: null, operations: [] });
  const reference = `cp1-${jsonDigest({ binding, checkpointId: 'TEST-checkpoint' })}`;
  const body = { reference, checkpointId: 'TEST-checkpoint', sourceSessionRef: 'TEST-session-ref',
    sourceBinding: binding, sourceConfig: config, historyDigest, completedOperations: [],
    opaque: { version: 2, engine: 'codex-app-server', nativeThreadId: thread } };
  const payload = { ...body, digest: jsonDigest(body) };
  const payloadPath = join(root, 'hoststore/runtime-checkpoints', `${reference}.json`);
  await writeFile(payloadPath, JSON.stringify(payload));
  const session = { sessionRef: body.sourceSessionRef, binding, config, inputs: [],
    checkpoints: [{ status: 'published', reference, payloadDigest: payload.digest, historyDigest }] };
  const historyPath = join(sessions, `rollout-2026-10-28T00-00-00-${thread}.jsonl`);
  const metadata = (id = thread, workspace = cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace } }) + '\n';
  const history = metadata() + JSON.stringify({ type: 'event_msg', payload: { text: 'CODEX_TEAM_ONE REPLY_CODEX_ONE' } }) + '\n';
  await writeFile(historyPath, history);
  const original = await checkpoint(root, session, 'codex');
  assert.equal(original.nativeSession, thread); assert.equal(original.historyPath, historyPath);
  assert.equal(original.historySha256, digest(history));
  await writeFile(historyPath, history + '{"type":"event_msg","payload":{"text":"CODEX_TEAM_TWO"}}\n');
  const continued = await checkpoint(root, session, 'codex');
  assert.equal(continued.nativeSession, original.nativeSession);
  assert.equal(digest(continued.history.subarray(0, original.history.length)), original.historySha256);
  assert.equal(digest(await readFile(payloadPath)), original.payloadFileSha256);
  for (const invalid of [metadata('019a1234-5678-7000-8000-000000000000'), metadata(thread, '/TEST-foreign/workspace'), '{}\n']) {
    await writeFile(historyPath, invalid);
    await assert.rejects(checkpoint(root, session, 'codex'));
  }
  await writeFile(historyPath, history);
  await saveProfile({ ...member, environment: { CODEX_HOME: '/TEST-foreign/config' } });
  await assert.rejects(checkpoint(root, session, 'codex'));
  await saveProfile(member);
  const duplicate = join(sessions, `rollout-duplicate-${thread}.jsonl`);
  await writeFile(duplicate, history); await assert.rejects(checkpoint(root, session, 'codex'));
  await rm(duplicate); await rm(historyPath); await symlink(payloadPath, historyPath);
  await assert.rejects(checkpoint(root, session, 'codex'));
  assert.equal(originalHistoryMarker(callIds, 'codex'), jsonDigest(callIds));
  assert.throws(() => originalHistoryMarker([...callIds.slice(1), callIds[0]!], 'codex'));
  assert.throws(() => originalHistoryMarker(callIds), 'Claude default remains distinct');
});

test('Codex UI oracle records actual model/effort, original call IDs and incoming reply contract without replay', async t => {
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true, captureHistoryMarkers: true,
    principalId: () => 'TEST-actual-captured-Alice' });
  t.after(() => model.close());
  const messageId = '019a1234-5678-7000-8000-123456789def';
  const input: Record<string, unknown>[] = [
    { role: 'developer', content: CONTEXT_MARKER },
    ...callIds.flatMap((call_id, index) => [
      { type: 'function_call', call_id, name: 'TEST-original-native-tool', arguments: '{}' },
      { type: 'function_call_output', call_id, output: index === 3 ? 'Process exited with code 7\n' :
        JSON.stringify({ phase: 'completed', principalId: 'TEST-actual-captured-Alice' }) },
    ]),
    { role: 'user', content: `CODEX_TEAM_TWO {"messageId":"${messageId}"} message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId` },
  ];
  const next = () => fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'TEST-retained-native-launch-model', reasoning: { effort: 'medium' }, input,
      tools: [{ type: 'function', name: 'exec_command' }, { type: 'namespace', name: 'mcp__team', tools: REQUIRED_TOOLS.map(name => ({ name })) }] }) });
  const nativeCall = async (response: Response) => {
    const text = await response.text();
    const events = text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as { type: string; item?: Record<string, unknown> });
    const call = events.find(event => event.type === 'response.output_item.done')!.item!;
    assert.equal(call.type, 'function_call'); input.push(call); return text;
  };
  const shell = await next(); assert.equal(shell.status, 200); await nativeCall(shell);
  input.push({ type: 'function_call_output', call_id: 'native_CODEX_TEAM_TWO_0', output: 'Process exited with code 0\nFinal output:\n' });
  const reply = await next(); assert.equal(reply.status, 200); assert.match(await nativeCall(reply), /REPLY_CODEX_TWO/);
  input.push({ type: 'function_call_output', call_id: 'native_CODEX_TEAM_TWO_1', output: JSON.stringify({ phase: 'completed', principalId: 'TEST-actual-captured-Alice' }) });
  const terminal = await next(); assert.equal(terminal.status, 200); assert.match(await terminal.text(), /DONE_CODEX_TEAM_TWO/);
  assert.deepEqual(model.observations.map(value => value.step), [0, 1, 2]);
  for (const value of model.observations) {
    assert.equal(value.requestedModel, 'TEST-retained-native-launch-model'); assert.equal(value.requestedEffort, 'medium');
    assert.equal(value.incomingMessageId, messageId); assert.equal(value.visibleReplyContract, true);
    assert.equal(value.toolResultError, false); assert.deepEqual(value.priorNativeToolIds, callIds);
  }
  const replay = await next(); assert.equal(replay.status, 400); await replay.text();
  assert.equal(model.observations.length, 3, 'no fourth inference continuation is fabricated');
});

test('Codex UI oracle refuses a copied message id before any business continuation', async t => {
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true });
  t.after(() => model.close());
  const response = await fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [{ role: 'developer', content: CONTEXT_MARKER }, { role: 'user', content:
      'CODEX_TEAM_TWO {"messageId":"TEST-copied-id"} message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId' }] }) });
  assert.equal(response.status, 400); await response.text(); assert.deepEqual(model.observations, []);
  assert.equal(model.failures.length, 1);
});
