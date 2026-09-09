import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Socket } from 'node:net';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from '../contracts';
import type { SupervisorPlan, ProcessStartEvidence } from '../processes';
import { ownerChildPlanV2, OWNER_V2_ARGV } from '../owner-child-protocol';
import { parseOwnerLaunchEvidenceV2 } from '../owner-descriptor-v2';
import { assembleOwnerBootstrap, type AssembleBootstrapInput, type BootstrapFrames } from './bootstrap-v2';
import { canonicalJson as supervisorCanonicalJson, sha256 as supervisorSha256 } from './canonical';
import { launchNativeOwner, OwnerLaunchError, type InheritedImage } from './native-launch';
import { decodeFailure, NATIVE_EVENT, type HeldOwner } from './native-protocol';
import { SERVER_AUTH_V2 } from './private-profile-transfer';

const sources = dirname(fileURLToPath(import.meta.url));
let sandbox: string;
before(() => {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0, 'root-only disposable native tests');
  sandbox = mkdtempSync('/var/tmp/hosted-owner-launch-'); chmodSync(sandbox, 0o700);
  writeFileSync(join(sandbox, '.test-owned'), 'hosted-owner-native-checkpoint-tests/v1\n', { flag: 'wx', mode: 0o600 });
  process.chdir(sandbox);
  const env = { PATH: '/usr/bin:/bin', HOME: sandbox, TMPDIR: sandbox };
  execFileSync('/bin/sh', [join(sources, 'build.sh'), sandbox], { cwd: sandbox, env });
  const flags = ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror'];
  execFileSync('cc', [...flags, join(sources, 'test-child.c'), '-o', join(sandbox, 'test-child')], { cwd: sandbox, env });
  execFileSync('cc', [...flags, join(sources, 'owner-launch.c'), join(sources, 'test-missing-seal.c'),
    '-Wl,--wrap=fcntl', '-o', join(sandbox, 'missing-seal-helper')], { cwd: sandbox, env });
  chmodSync(join(sandbox, 'test-child'), 0o500); chmodSync(join(sandbox, 'missing-seal-helper'), 0o500);
});
after(() => { if (sandbox) console.log(`Retained disposable native test sandbox: ${sandbox}`); });

function image(path: string): InheritedImage {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), s = fstatSync(fd, { bigint: true });
  return { fd, pin: { device: String(s.dev), inode: String(s.ino), size: Number(s.size), mode: Number(s.mode & 0o7777n), sha256: sha256(readFileSync(fd)) } };
}
function inputs(label: string, helperName = 'owner-launch') {
  const root = mkdtempSync(join(sandbox, `${label}-`)); chmodSync(root, 0o700);
  const rawPath = join(root, 'raw'), walPath = join(root, 'wal');
  const handles = { helper: image(join(sandbox, helperName)), executable: image(join(sandbox, 'test-child')),
    cwdFd: openSync(root, constants.O_RDONLY | constants.O_DIRECTORY),
    rawFd: openSync(rawPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600),
    walFd: openSync(walPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600) };
  return { handles, rawPath, walPath, root, closeBorrowed() {
    closeSync(handles.helper.fd); closeSync(handles.executable.fd); closeSync(handles.cwdFd);
  } };
}
function fixtureFrames(headerLength = 65536, authLength = 8192): BootstrapFrames {
  // Transport-only payload, not a fake production bootstrap admission.
  const header = Buffer.from(`{"p":"${'b'.repeat(headerLength - 8)}"}`), key = Buffer.alloc(32, 7);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  const authenticated = Buffer.concat([prefix, header]);
  const tag = createHmac('sha256', key).update('agent-teams.hosted-control.bootstrap/v2\0').update(authenticated).digest();
  const auth = Buffer.from(`{"p":"${'a'.repeat(authLength - 8)}"}`), authPrefix = Buffer.alloc(4); authPrefix.writeUInt32BE(auth.length);
  return { leaseBytes: Buffer.from('{"fixture":"lease"}'), bootstrapFrame: Buffer.concat([authenticated, key, tag]), authFrame: Buffer.concat([authPrefix, auth]) };
}
function retain(frames: BootstrapFrames): BootstrapFrames {
  return { leaseBytes: Buffer.from(frames.leaseBytes), bootstrapFrame: Buffer.from(frames.bootstrapFrame), authFrame: Buffer.from(frames.authFrame) };
}
function readSocket(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('test_socket_deadline')), 2000);
    const onData = (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= n) finish(); };
    const onClose = () => finish(new Error('test_socket_closed'));
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.off('data', onData); socket.off('error', finish); socket.off('close', onClose);
      if (error) reject(error); else resolve(bytes);
    };
    socket.on('data', onData); socket.once('error', finish); socket.once('close', onClose);
  });
}
function readReport(path: string) {
  const bytes = readFileSync(path); let offset = 0;
  const lines: string[] = [];
  for (;;) {
    const end = bytes.indexOf(10, offset); assert(end >= offset);
    const line = bytes.subarray(offset, end).toString('utf8'); offset = end + 1; lines.push(line);
    if (line.startsWith('frame ')) break;
    assert(lines.length <= 11);
  }
  const [boot, auth, lease] = lines.at(-1)!.split(' ').slice(1).map(Number);
  assert.equal(bytes.length - offset, boot + auth + lease);
  return { lines, bootstrapFrame: bytes.subarray(offset, offset + boot), authFrame: bytes.subarray(offset + boot, offset + boot + auth), leaseBytes: bytes.subarray(offset + boot + auth) };
}
async function failure(promise: Promise<unknown>): Promise<OwnerLaunchError> {
  try {
    const result = await promise;
    if (result && typeof result === 'object' && 'dispose' in result && typeof result.dispose === 'function') await result.dispose();
    assert.fail('launch unexpectedly succeeded');
  }
  catch (error) { assert(error instanceof OwnerLaunchError); return error; }
}
function nativeFailure(error: OwnerLaunchError) {
  const record = error.nativeEvents.find(e => e.type === NATIVE_EVENT.failed); assert(record, error.message);
  const result = decodeFailure(Buffer.from(record.bodyBase64, 'base64'));
  if (result.ownerPid) assert.equal(result.reaped, true, 'owned child must be reaped');
  return result;
}
function assertGone(held: HeldOwner): void {
  try {
    const stat = readFileSync(`/proc/${held.ownerPid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    assert.notEqual(ticks, held.ownerStartTicks, 'exact owned child survived');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function bootstrapInput(held: HeldOwner): AssembleBootstrapInput {
  const hex = '1'.repeat(64), artifact = '2'.repeat(64), key = Buffer.alloc(32, 3);
  const product = Buffer.from('{"fixture":"serialized-product-document"}'), bootstrapDigest = sha256(product);
  const common = { restoreGeneration: 0, teamId: `team_${'a'.repeat(32)}`, declaredRootHash: hex,
    ownerAuthority: 'owner-authority_test0001', ownerGeneration: 1, ownerSessionId: 'owner-session_test0001',
    claudeRoot: '/sandbox/claude', socketPath: '/sandbox/owner.sock', legacyKey: 'test',
    bootstrapBinding: { deploymentId: 'test', bootId: 'test', workspaceId: 'test', mountGeneration: 1,
      bootstrapDigest, ownerArtifactDigest: `sha256:${artifact}`, proofKeyId: sha256(key) },
    approvalActivationV2: { approvalGeneration: 2, admissionOwnerGeneration: 3, approvalDigest: `sha256:${hex}`,
      admissionDocumentDigest: `sha256:${hex}`, ownerArtifactDigest: `sha256:${artifact}`, wireCapabilityDigest: `sha256:${hex}`,
      signedManifest: { format: 'agent-teams.hosted-lifecycle-owner-admission/v4' as const, releasePinDigest: `sha256:${hex}`, launcherKeyId: hex } } };
  return { held, common, key, serializedProductBootstrap: product, launcherArtifactDigest: artifact, launcherLeaseId: 'test-lease',
    credentials: { username: 'test', password: 'benign-test-only' }, rawRetention: {
      format: 'agent-teams.hosted-control.opencode-raw-retention/v1', captureId: hex, initialByteLength: 0, initialSha256: sha256(Buffer.alloc(0)), nextSequence: 1 },
    supervisorBinding: { supervisorPid: held.callerPid, supervisorStartTicks: held.callerStartTicks, supervisorStartToken: hex,
      supervisorExecutableSha256: hex, recipeSha256: hex, ownerEntrySha256: artifact, ownerPid: held.ownerPid,
      ownerStartTicks: held.ownerStartTicks, ownerProcessStartToken: hex, harnessContractSha256: hex, ownerProducerCapsuleSha256: hex },
    // Codec fixtures only. No OpenCode is launched, and these identities grant no custody.
    expectedHost: { endpoint: { protocol: 'http:', address: '127.0.0.1', port: 4096, baseUrl: 'http://127.0.0.1:4096' },
      process: { pid: process.pid, startTicks: held.callerStartTicks,
        startIdentity: `start_${sha256(`${process.pid}\0proc:${held.callerStartTicks}`)}`, supervisorProcessStartToken: hex,
        pidNamespaceInode: held.ownerPidNamespaceInode, networkNamespaceInode: held.ownerNetworkNamespaceInode },
      executable: { device: '1', inode: '2', size: '3', sha256: hex, artifactManifestSha256: hex, moduleSha256: hex },
      profile: { projectPath: '/sandbox/project', profileRootKey: 'test-profile', profileRootPath: '/sandbox/profile',
        projectBehaviorFingerprint: hex, managedConfigFingerprint: hex, resolvedConfigFingerprint: hex,
        sourceAuthFingerprint: null, managedAuthFingerprint: null, sourceAuthSources: [], toolApprovalMode: 'manual' },
      hosted: { schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', authentication: 'opencode-basic',
        runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`, configGeneration: `config_generation_${'b'.repeat(32)}` },
      activation: { controllerNonce: hex, runId: hex, stackManifestSha256: hex, bootstrapDigest,
        admissionDocumentDigest: `sha256:${hex}`, ownerArtifactDigest: `sha256:${artifact}`, ownerGeneration: 1, ownerSessionId: common.ownerSessionId }, serverAuthId: 'test-auth' } };
}

test('supervisor canonical utility matches Product UTF-8 key order and byte digests', () => {
  const value = { '\u{10000}': 'astral', '\ue000': 'bmp', z: [true, null, { b: 1, a: 'é' }] };
  assert.equal(supervisorCanonicalJson(value), canonicalJson(value));
  assert.equal(supervisorSha256(Buffer.from([0, 128, 255])), sha256(Buffer.from([0, 128, 255])));
});

test('real seal, maximum frames, cyclic remap, exact exec, separate parent, retained endpoints', async () => {
  const input = inputs('maximum'); let expected!: BootstrapFrames;
  try {
    const launch = await launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
      // activation->11->anchor, WAL->8->raw->9 form destructive cycles for naive dup2.
      sourceSlots: [11, 3, 9, 8, 5, 6], async assemble(held) {
        assert.notEqual(held.ownerPid, held.parentPid); assert.notEqual(held.callerPid, held.parentPid);
        assert.equal(held.descriptors[0].accessMode, 'read-only'); assert.equal(held.descriptors[0].seals, 0);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(statSync(input.rawPath).size, 0, 'Owner must not execute while assembler holds the barrier');
        const f = fixtureFrames(); expected = retain(f); return f;
      } });
    const activation = launch.activation.take(), liveness = launch.liveness.take();
    try {
      assert.throws(() => launch.activation.take(), /already_transferred/u);
      assert.equal((await readSocket(activation, 5)).toString(), 'READY');
      const report = readReport(input.rawPath);
      assert.deepEqual(report.bootstrapFrame, expected.bootstrapFrame); assert.deepEqual(report.authFrame, expected.authFrame);
      assert.deepEqual(report.leaseBytes, expected.leaseBytes); assert.equal(report.bootstrapFrame.length, 65604);
      assert.equal(report.authFrame.length, 8196); assert(report.lines.includes('seals 15 EBADF EPERM'));
      assert.equal(report.lines[0], `start ${launch.held.ownerPid} ${launch.held.parentPid} 1`);
      for (let i = 0; i < 8; ++i) {
        const [, fd, dev, ino, mode, flags, seals] = report.lines[i + 1].split(' '), observed = launch.held.descriptors[i];
        assert.equal(Number(fd), observed.childFd); assert.equal(dev, observed.device); assert.equal(ino, observed.inode);
        assert.equal(Number(mode), observed.mode);
        if (i === 0) { assert.equal(Number(flags) & 3, 0); assert.equal(Number(seals), 15); }
      }
      assert.equal(launch.executed.executableSha256, input.handles.executable.pin.sha256);
      assert.equal(launch.parentWriterClosures.length, 2);
      for (const row of launch.parentWriterClosures) {
        assert.equal(row.spawnBoundaryMonotonicNs, launch.held.forkMonotonicNs);
        assert(BigInt(row.observedOpenMonotonicNs) < BigInt(row.spawnBoundaryMonotonicNs));
        assert(BigInt(row.spawnBoundaryMonotonicNs) < BigInt(row.observedClosedMonotonicNs));
        assert(BigInt(row.observedClosedMonotonicNs) < BigInt(launch.executed.observedMonotonicNs));
      }
      assert.notEqual(launch.executed.executable.inode, input.handles.helper.pin.inode);
      assert.equal(readFileSync(input.walPath, 'utf8'), 'wal-descriptor-survived\n');
      const echo = readSocket(activation, 4); activation.write('PING'); assert.equal((await echo).toString(), 'PING');
      liveness.destroy(); assert.equal((await launch.exit).reaped, true); assertGone(launch.held);
    } finally { activation.destroy(); liveness.destroy(); await launch.dispose(); }
  } finally { input.closeBorrowed(); }
});

test('canonical H0 -> lease -> H2; distinct digests; only signed manifest digest deferred', async () => {
  const input = inputs('codec'); let expected!: BootstrapFrames;
  try {
    const launch = await launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {}, assemble(held) {
      const spec = bootstrapInput(held);
      const premature = structuredClone(spec); Object.assign(premature.common.approvalActivationV2.signedManifest, { manifestDigest: `sha256:${'9'.repeat(64)}` });
      assert.throws(() => assembleOwnerBootstrap(premature), /keys/u);
      const substituted = structuredClone(spec); substituted.supervisorBinding.ownerPid++;
      assert.throws(() => assembleOwnerBootstrap(substituted), /observed_start/u);
      const badProduct = { ...spec, serializedProductBootstrap: Buffer.from('{}') };
      assert.throws(() => assembleOwnerBootstrap(badProduct), /product_bootstrap_digest/u);
      const f = assembleOwnerBootstrap(spec); expected = retain(f);
      const frame = f.bootstrapFrame, size = frame.readUInt32BE(0), headerBytes = frame.subarray(4, 4 + size);
      const header = JSON.parse(headerBytes.toString('utf8'));
      assert.equal(canonicalJson(header), headerBytes.toString('utf8'));
      assert.equal('manifestDigest' in header.approvalActivationV2.signedManifest, false);
      assert.equal(header.approvalActivationV2.approvalGeneration, 2); assert.equal(header.approvalActivationV2.admissionOwnerGeneration, 3);
      const expectedTag = createHmac('sha256', spec.key).update('agent-teams.hosted-control.bootstrap/v2\0').update(frame.subarray(0, 4 + size)).digest();
      assert.deepEqual(frame.subarray(-32), expectedTag);
      const lease = JSON.parse(f.leaseBytes.toString('utf8')); delete header.leaseEvidence.leaseArtifactSha256;
      assert.equal(lease.bootstrapStatementSha256, sha256(`agent-teams.hosted-control.bootstrap-statement/v2\0${canonicalJson(header)}`));
      assert.equal(new Set([f.digests.bootstrapDigest, f.digests.bootstrapV2HeaderSha256, f.digests.leaseArtifactSha256, f.digests.launcherArtifactDigest]).size, 4);
      return f;
    } });
    const socket = launch.activation.take();
    try {
      await readSocket(socket, 5); const actual = readReport(input.rawPath);
      assert.deepEqual(actual.bootstrapFrame, expected.bootstrapFrame); assert.deepEqual(actual.authFrame, expected.authFrame);
      assert.deepEqual(actual.leaseBytes, expected.leaseBytes);
    } finally { socket.destroy(); await launch.dispose(); }
  } finally { input.closeBorrowed(); }
});

test('explicit FD7 v2 delivers 1 MiB concurrently with maximum FD4 and wipes transferred buffers', async () => {
  const input = inputs('private-v2-maximum');
  let sent!: BootstrapFrames;
  let expected!: BootstrapFrames;
  try {
    const launch = await launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
      serverAuthFormat: SERVER_AUTH_V2, assemble() {
        sent = fixtureFrames(65536, 1024 * 1024); expected = retain(sent); return sent;
      } });
    const activation = launch.activation.take();
    try {
      await readSocket(activation, 5);
      const actual = readReport(input.rawPath);
      assert.deepEqual(actual.authFrame, expected.authFrame);
      assert.deepEqual(actual.bootstrapFrame, expected.bootstrapFrame);
      assert.equal(actual.authFrame.length, 1024 * 1024 + 4);
      assert(sent.authFrame.every(byte => byte === 0));
      assert(sent.bootstrapFrame.every(byte => byte === 0));
    } finally { activation.destroy(); await launch.dispose(); }
  } finally { input.closeBorrowed(); }
});

test('large private frame never probes or downgrades the default v1 selection', async () => {
  const input = inputs('private-v1-reject');
  let sent!: BootstrapFrames;
  try {
    const error = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
      assemble() { sent = fixtureFrames(65536, 8193); return sent; } }));
    assert(!error.nativeEvents.some(event => event.type === NATIVE_EVENT.exec));
    assert(sent.authFrame.every(byte => byte === 0));
    assert(sent.bootstrapFrame.every(byte => byte === 0));
  } finally { input.closeBorrowed(); }
});

test('plan caller imports in the private cwd and launches from verified inherited handles', async () => {
  // This exercises composition with a benign ELF and a non-authoritative plan fixture, not OpenCode.
  const { launchOwnerFromPlan } = await import('./index');
  const input = inputs('plan-caller');
  const proc = readFileSync('/proc/self/stat', 'utf8');
  const start = proc.slice(proc.lastIndexOf(')') + 2).split(' ')[19];
  const seed = { callerPid: process.pid, callerStartTicks: start, ownerPid: process.pid, ownerStartTicks: start,
    ownerPidNamespaceInode: String(statSync('/proc/self/ns/pid', { bigint: true }).ino),
    ownerNetworkNamespaceInode: String(statSync('/proc/self/ns/net', { bigint: true }).ino) } as HeldOwner;
  const { held: _seed, supervisorBinding: _unbound, ...bootstrap } = bootstrapInput(seed);
  const self = statSync('/proc/self/exe', { bigint: true }), cwd = fstatSync(input.handles.cwdFd, { bigint: true });
  const owner = input.handles.executable.pin, openCode = bootstrap.expectedHost.executable;
  // Only the plan fields consumed by this launch stage. No fabricated transcript/qualification flags.
  const plan = { schemaVersion: 2, protocol: 'agent-teams.p3c.supervisor-transcript/v1',
    controllerNonce: bootstrap.expectedHost.activation.controllerNonce, runId: bootstrap.expectedHost.activation.runId,
    startSchedule: [{ role: 'owner', generation: 1 }], processOwnership: { marker: 'benign-plan-fixture' },
    ownerChildProtocol: ownerChildPlanV2(), ownerRecipeSha256: '6'.repeat(64), ownerHarnessContractSha256: '7'.repeat(64),
    ownerLaunchHelper: { root: 'p3b2', relativePath: 'owner-launch', ...input.handles.helper.pin, nlink: 1 },
    expectedArgv: { owner: OWNER_V2_ARGV },
    expectedCwd: { owner: { device: String(cwd.dev), inode: String(cwd.ino) } },
    expectedExecutableSha256: { supervisor: sha256(readFileSync('/proc/self/exe')), owner: owner.sha256, opencode: openCode.sha256 },
    expectedExecutableDevice: { supervisor: String(self.dev), owner: owner.device, opencode: openCode.device },
    expectedExecutableInode: { supervisor: String(self.ino), owner: owner.inode, opencode: openCode.inode },
    expectedProducerArtifactSha256: { owner: '4'.repeat(64), opencode: openCode.artifactManifestSha256 },
    expectedProducerModuleSha256: { owner: owner.sha256, opencode: openCode.moduleSha256 },
    runtimeManifest: { schemaVersion: 1, purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
      runId: bootstrap.expectedHost.activation.runId, refs: { openCodeExecutableSha256: openCode.sha256 }, captureEmissionContract: { contract: 'claude-team/hosted-producer-provenance', version: 2,
      environment: 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2', descriptorSlots: { ownerWalTimeline: 9 },
      contractSha256: 'ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba' } } } as unknown as SupervisorPlan;
  try {
    const module = { path: '/sandbox/immutable/owner.ts', sha256: '9'.repeat(64) };
    const selectedImage = input.handles.helper.pin;
    const sourcePlan = { ...plan,
      expectedExecutableSha256: { ...plan.expectedExecutableSha256, owner: selectedImage.sha256 },
      expectedExecutableDevice: { ...plan.expectedExecutableDevice, owner: selectedImage.device },
      expectedExecutableInode: { ...plan.expectedExecutableInode, owner: selectedImage.inode },
      expectedProducerModuleSha256: { ...plan.expectedProducerModuleSha256, owner: module.sha256 },
      ownerSourceInvocation: { format: 'agent-teams.hosted-owner-source-invocation/v1' as const,
        executable: { device: selectedImage.device, inode: selectedImage.inode, sha256: selectedImage.sha256 }, module } };
    const sourceOptions = { plan: sourcePlan, handles: input.handles, bootstrap,
      invocation: { kind: 'source-bun' as const, modulePath: module.path, moduleSha256: module.sha256 },
      environment: {}, supervisorProcessStartToken: '5'.repeat(64), recipeSha256: '6'.repeat(64), harnessContractSha256: '7'.repeat(64) };
    // Correctly pinned image B cannot replace selected image A, despite preserving selected module M.
    await assert.rejects(launchOwnerFromPlan(sourceOptions), /selected_owner_image/u);
    // A legacy built-entry plan is not an independently selected source invocation.
    await assert.rejects(launchOwnerFromPlan({ ...sourceOptions, plan }), /source_selection/u);
    const boundSourcePlan = { ...sourcePlan,
      expectedExecutableSha256: plan.expectedExecutableSha256,
      expectedExecutableDevice: plan.expectedExecutableDevice,
      expectedExecutableInode: plan.expectedExecutableInode,
      ownerSourceInvocation: { ...sourcePlan.ownerSourceInvocation,
        executable: { device: owner.device, inode: owner.inode, sha256: owner.sha256 } } };
    await assert.rejects(launchOwnerFromPlan({ ...sourceOptions, plan: boundSourcePlan,
      invocation: { ...sourceOptions.invocation, modulePath: '/sandbox/immutable/different.ts' } }), /source_selection/u);
    assert.equal(statSync(input.rawPath).size, 0);
    assert(fstatSync(input.handles.rawFd).isFile()); assert(fstatSync(input.handles.walFd).isFile());
    const supervisorObservedNs = String(process.hrtime.bigint());
    const launch = await launchOwnerFromPlan({ plan, handles: input.handles, bootstrap, invocation: { kind: 'built-entry' },
      environment: {}, supervisorProcessStartToken: '5'.repeat(64), recipeSha256: '6'.repeat(64), harnessContractSha256: '7'.repeat(64) });
    const socket = launch.activation.take();
    try {
      await readSocket(socket, 5);
      const frame = readReport(input.rawPath).bootstrapFrame;
      const header = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString('utf8'));
      assert.equal(header.supervisorBinding.ownerPid, launch.held.ownerPid); assert.notEqual(launch.held.ownerPid, process.pid);
      assert.equal(header.supervisorBinding.ownerProcessStartToken, launch.ownerProcessStartToken);
      assert.equal(launch.parentCleanup.wrapperPid, launch.held.parentPid);
      assert.equal(launch.parentCleanup.ownerPid, launch.held.ownerPid);
      // Product's parser consumes the actual accepted native output and independent caller observation.
      // This benign consumer is not an Owner/OpenCode composition or a qualifying supervisor corpus.
      const evidence = launch.launchEvidence();
      const context = { plan,
        owner: { role: 'owner', pid: launch.held.ownerPid, startTime: launch.held.ownerStartTicks,
          startToken: launch.ownerProcessStartToken, pidfdInode: launch.held.pidfdInode,
          parentStartToken: launch.parentCleanup.wrapperStartToken, observerStartToken: '5'.repeat(64),
          observedMonotonicNs: String(process.hrtime.bigint()), executableDevice: owner.device,
          executableInode: owner.inode, executableSha256: owner.sha256 } as ProcessStartEvidence,
        supervisor: { role: 'supervisor', pid: process.pid, startTime: launch.held.callerStartTicks,
          startToken: '5'.repeat(64), observedMonotonicNs: supervisorObservedNs } as ProcessStartEvidence,
        pidNamespaceInode: String(statSync('/proc/self/ns/pid', { bigint: true }).ino),
        networkNamespaceInode: String(statSync('/proc/self/ns/net', { bigint: true }).ino) };
      assert.deepEqual(parseOwnerLaunchEvidenceV2(evidence, context).parentCleanup, launch.parentCleanup);
      assert.throws(() => parseOwnerLaunchEvidenceV2({ ...evidence,
        parentCleanup: { ...evidence.parentCleanup, wrapperPid: launch.held.ownerPid } }, context));
      assert.throws(() => parseOwnerLaunchEvidenceV2({ ...evidence, nativeEvents: [] }, context));
      assert.throws(() => parseOwnerLaunchEvidenceV2({ ...evidence,
        wrapperObservation: { ...evidence.wrapperObservation, startTicks: '1' } }, context));
      assert.equal(launch.digests.bootstrapV2HeaderSha256, sha256(frame.subarray(4, 4 + frame.readUInt32BE(0))));
    } finally { socket.destroy(); await launch.dispose(); }
  } finally { input.closeBorrowed(); }
});

for (const stale of ['rawFd', 'walFd'] as const) {
  test(`stale ${stale} preserves structured failure and closes every other transferred writer`, async () => {
    const input = inputs(`stale-${stale}`);
    const other = stale === 'rawFd' ? 'walFd' : 'rawFd';
    closeSync(input.handles[stale]);
    try {
      const error = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
        assemble: () => { assert.fail('stale descriptor must fail before assembly'); } }));
      assert.equal(error.nativeEvents.length, 0);
      assert(error.cause instanceof AggregateError);
      assert.equal((error.cause.errors[0] as NodeJS.ErrnoException).code, 'EBADF');
      assert(error.cause.errors.slice(1).some((cause: NodeJS.ErrnoException) => cause.code === 'EBADF'));
      assert.throws(() => fstatSync(input.handles[other]), { code: 'EBADF' });
      assert.equal(statSync(input.rawPath).size, 0); assert.equal(statSync(input.walPath).size, 0);
    } finally { input.closeBorrowed(); }
  });
}

test('same inode through two distinct writer opens is refused before fork', async () => {
  const input = inputs('alias'); closeSync(input.handles.walFd);
  input.handles.walFd = openSync(input.rawPath, constants.O_WRONLY | constants.O_APPEND);
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {}, assemble: () => fixtureFrames() }));
    assert.equal(nativeFailure(e).ownerPid, 0); assert.equal(statSync(input.rawPath).size, 0);
  } finally { input.closeBorrowed(); }
});

test('a read-write ledger handle is refused even with the right inode and file mode', async () => {
  const input = inputs('access-mode'); closeSync(input.handles.rawFd);
  input.handles.rawFd = openSync(input.rawPath, constants.O_RDWR | constants.O_APPEND);
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {}, assemble: () => fixtureFrames() }));
    assert.equal(nativeFailure(e).ownerPid, 0); assert.equal(statSync(input.rawPath).size, 0);
  } finally { input.closeBorrowed(); }
});

test('oversized assembled bytes cancel the suspended child without executing it', async () => {
  const input = inputs('oversize'); let held!: HeldOwner;
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {}, assemble(value) {
      held = value; return fixtureFrames(65537);
    } }));
    nativeFailure(e); assert.equal(statSync(input.rawPath).size, 0); assertGone(held);
  } finally { input.closeBorrowed(); }
});

test('kernel missing seals refuse release even when the seal operation reports success', async () => {
  const input = inputs('missing-seal', 'missing-seal-helper'); let held!: HeldOwner;
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
      assemble(value) { held = value; return fixtureFrames(); } }));
    assert.equal(nativeFailure(e).phase, 6); assert.equal(statSync(input.rawPath).size, 0); assertGone(held);
  } finally { input.closeBorrowed(); }
});

test('unexpected exit during maximum-frame delivery retains failure and reaps child', async () => {
  const input = inputs('child-exit'); let held!: HeldOwner;
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child', 'exit'], environment: {},
      assemble(value) { held = value; return fixtureFrames(); } }));
    nativeFailure(e); assertGone(held);
  } finally { input.closeBorrowed(); }
});

test('cancel a partial socket send without waiting for the non-reading child', async () => {
  const input = inputs('cancel'); const abort = new AbortController(); let held!: HeldOwner;
  let poll: NodeJS.Timeout | undefined, cancel: NodeJS.Timeout | undefined;
  try {
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child', 'no-read'], environment: {}, signal: abort.signal,
      assemble(value) {
        held = value;
        poll = setInterval(() => {
          if (statSync(input.rawPath).size > 0) { clearInterval(poll); cancel = setTimeout(() => abort.abort(), 100); }
        }, 5);
        return fixtureFrames();
      } }));
    const observed = nativeFailure(e); assert.equal(observed.phase, 9);
    assert(observed.bootstrapBytes > 0 && observed.bootstrapBytes < 65604); assertGone(held);
    assert(statSync(input.rawPath).size > 0, 'retain actual post-exec prefix on failure');
  } finally { clearInterval(poll); clearTimeout(cancel); input.closeBorrowed(); }
});

test('native absolute deadline kills the held child while the JS event loop is blocked', async () => {
  const input = inputs('native-deadline'); let held!: HeldOwner;
  try {
    const started = performance.now();
    const e = await failure(launchNativeOwner({ ...input.handles, argv: ['test-child'], environment: {},
      assemble(value) {
        held = value;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6100);
        return fixtureFrames();
      } }));
    const observed = nativeFailure(e); assert.equal(observed.phase, 5); assert.equal(observed.errno, 110);
    assert(performance.now() - started < 9500); assert.equal(statSync(input.rawPath).size, 0); assertGone(held);
  } finally { input.closeBorrowed(); }
});
