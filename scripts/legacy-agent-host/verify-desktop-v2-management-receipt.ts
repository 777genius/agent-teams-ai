import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { selectOpenCodeV2ManagementModel } from '../../packages/legacy-agent-host/dist/composition/openCodeV2ModelSelection.js';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { parseManagedPreferences } from '../../src/features/runtime-provider-management/core/domain/managedProviderPreferences.ts';
import { captureLinuxNodeExecArtifact } from '../../src/main/utils/linuxNodeExecArtifact.ts';
import { verifyLinuxChildExecInput } from '../../src/main/utils/linuxChildLaunchSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { desktopV2SelectedKey } from './desktop-opencode-v2-management-model.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { compiledBundleHashes } from './desktop-backend-observations.ts';
import { readDesktopNativeProviderArtifact } from './desktop-native-stop-fixture.ts';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const rows = (value: unknown): Record<string, unknown>[] => {
  assert.ok(Array.isArray(value)); return value.map(object);
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
async function bytes(path: string, maximum = 32 * 1024 * 1024) {
  assert.equal(await realpath(path), path);
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum);
  return readFile(path);
}
const json = async (path: string) => object(JSON.parse((await bytes(path)).toString('utf8')));
async function assertOriginalAbsent(original: Record<string, unknown>) {
  assert.ok(Number.isSafeInteger(original.pid) && Number(original.pid) > 1);
  assert.match(text(original.birth), /^\d+$/u);
  try {
    const value = await readFile(`/proc/${original.pid}/stat`, 'utf8');
    assert.notEqual(value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)[19], original.birth,
      'an original native process remains alive after the runner exits');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const expected = [
  ['reject-key', 'TEST-model', 'refused'], ['connect-key', 'TEST-model', 'OK'],
  ['global-default', 'TEST-model', 'OK'], ['project-default', 'TEST-project-model', 'OK'],
  ['project-test', 'TEST-project-model', 'OK'],
] as const;
const excluded = ['Claude/Codex execution', 'vendor authentication/inference', 'native V2 OAuth/forget', 'release qualification'];

/** Verify original files after the runner exits. This never launches an agent or resends an intent. */
export async function verifyDesktopV2ManagementReceipt(repo: string, temporary: string, head: string) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.match(head, /^[a-f0-9]{40}$/u);
  assert.equal(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), head);
  const input = await json(join(temporary, 'host-emulated-inputs.json')), values = object(input.values);
  assert.equal(input.sourceHead, head); assert.equal(input.platform, 'linux'); assert.equal(input.architecture, 'x64');
  assert.equal(input.nativeProviders, 'OpenCode V2 with finite localhost model only');
  const engine = await json(join(temporary, 'host-emulated-opencode-v2-inputs.json'));
  assert.equal(engine.kind, 'TEST_NATIVE_V2_EMBEDDED_INPUTS'); assert.equal(engine.status, 'READY');
  assert.equal(engine.sourceHead, head); assert.equal(engine.platform, 'linux-x64');
  assert.equal(engine.stage, 'prepared'); assert.equal(engine.nodeVersion, 'v24.21.0');
  const bun = object(engine.bun); assert.equal(bun.version, '1.3.11');
  assert.equal(await fileDigest(text(bun.path)), bun.sha256);
  const log = (await bytes(join(temporary, 'host-emulated-opencode-v2-management-ui.log'))).toString('utf8');
  const reports = log.split('\n').filter(line => line.startsWith('{')).map(line => object(JSON.parse(line)));
  const finals = reports.filter(row => row.receipt && row.status);
  assert.equal(finals.length, 1); const summary = finals[0]!;
  assert.equal(summary.mode, 'opencode-v2-management-ui'); assert.equal(summary.status, 'PASS');
  const receiptPath = text(summary.receipt), root = await realpath(dirname(receiptPath));
  assert.match(basename(root), /^TEST-desktop-backend-/u);
  assert.equal(receiptPath, join(root, 'desktop-backend-receipt.json'));
  const receipt = await json(receiptPath), pins = object(receipt.pins), source = object(receipt.source);
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.mode, summary.mode);
  assert.equal(receipt.scope, 'Actual Electron Settings and captured native OpenCode V2 with five finite localhost model intents');
  assert.equal(source.head, head); assert.equal(source.dirty, false); assert.deepEqual(receipt.excluded, excluded);
  for (const key of ['failure', 'sourceFreezeFailure', 'finalObservationFailed', 'logCleanupFailed', 'nativeInputFreezeFailure'])
    assert.equal(receipt[key], undefined);
  const proof = object(receipt.opencodeV2ManagementUiProof);
  assert.equal(proof.status, 'PASS'); assert.deepEqual(proof.excluded, excluded); assert.ok(rows(proof.steps).length > 0);
  assert.equal(proof.scope, 'Original Electron V2 API-key rejection/replacement, model test, global/project defaults, inheritance and renderer reload');
  const sourceBefore = rows(receipt.selectedSourceHashesBeforeApp);
  assert.deepEqual(receipt.selectedSourceHashesAfterFlow, sourceBefore);
  const expectedSources = [...new Set([...desktopProofSources, 'scripts/legacy-agent-host/verify-desktop-v2-management-receipt.ts',
    ...['fixture', 'model', 'process', 'smoke', 'ui'].map(name => `scripts/legacy-agent-host/desktop-opencode-v2-management-${name}.ts`)])];
  assert.equal(new Set(sourceBefore.map(row => row.path)).size, sourceBefore.length);
  assert.deepEqual(sourceBefore.map(row => row.path).sort(), expectedSources.sort());
  for (const row of sourceBefore) assert.equal(await fileDigest(join(repo, text(row.path))), row.sha256);
  for (const [pin, inputName] of [['nodeSha256', 'NODE'], ['hostEntrySha256', 'HOST_ENTRY'], ['pnpmSha256', 'PNPM'],
    ['corepackPackageSha256', 'COREPACK_PACKAGE'], ['corepackLibrarySha256', 'COREPACK_LIBRARY']])
    assert.equal(pins[pin!], values[`LEGACY_DESKTOP_${inputName}_SHA256`]);
  const paths = object(receipt.paths);
  for (const [name, pin] of [['node', 'nodeSha256'], ['hostEntry', 'hostEntrySha256'], ['pnpm', 'pnpmSha256'],
    ['profile', 'profileSha256'], ['descriptor', 'descriptorSha256']])
    assert.equal(await fileDigest(text(paths[name!])), pins[pin!]);
  const packageManager = object(receipt.packageManager);
  assert.equal(await fileDigest(text(packageManager.packagePath)), pins.corepackPackageSha256);
  assert.equal(await fileDigest(text(packageManager.libraryPath)), pins.corepackLibrarySha256);
  const electron = await realpath(join(createRequire(import.meta.url).resolve('electron/package.json'), '../dist/electron'));
  assert.equal(await fileDigest(electron), pins.electronSha256);
  assert.equal(await fileDigest(join(repo, (await readDesktopNativeProviderArtifact(repo)).path)), pins.providerArchiveSha256);
  assert.deepEqual(await compiledBundleHashes(join(repo, 'dist-electron')), receipt.compiledBundleHashesAfterStartup);
  assert.equal(paths.profile, join(root, 'host-profile.json'));
  const profile = readTeamHostProfile(text(paths.profile), text(pins.profileSha256));
  assert.equal(profile.runtime, undefined); assert.equal(profile.management?.length, 1);
  const management = profile.management![0]!; assert.equal(management.provider, 'opencode');
  if (management.provider !== 'opencode') throw new Error('Only the original OpenCode management profile is admitted');
  assert.equal(management.nativeGeneration, 'v2'); assert.equal(management.protocolRevision, '2.1.4'); assert.ok(management.embedded);
  assert.equal(management.executable.path, bun.path); assert.equal(management.executable.sha256, bun.sha256);
  assert.equal(management.embedded.manifestSha256, engine.manifestSha256);
  await verifyOpenCodeV2EmbeddedGraph(management.embedded);
  const fixturePins = object(proof.fixturePins);
  assert.deepEqual(fixturePins, receipt.nativeV2Input); assert.deepEqual(fixturePins, receipt.nativeV2InputAfterCleanup);
  assert.equal(fixturePins.runtimeConfigured, false); assert.equal(fixturePins.managementConfigured, true);
  assert.equal(fixturePins.codexOrClaudeExecutable, false); assert.equal(fixturePins.bunSha256, bun.sha256);
  assert.equal(fixturePins.manifestSha256, engine.manifestSha256);
  const linuxChildExec = verifyLinuxChildExecInput(input.linuxChildExec as Parameters<typeof verifyLinuxChildExecInput>[0]);
  assert.deepEqual(linuxChildExec, input.linuxChildExec); assert.deepEqual(receipt.linuxChildExecInput, linuxChildExec);
  assert.equal(receipt.linuxChildExecInputVerifiedAfterCleanup, true);
  const launcher = captureLinuxNodeExecArtifact(await realpath(join(repo, 'resources/process-launch/linux-x64')));
  assert.deepEqual(input.processLauncher, { manifestSha256: launcher.manifestSha256, binarySha256: launcher.binarySha256 });
  const close = object(receipt.originalClose), cleanup = object(receipt.cleanup);
  assert.equal(receipt.quitRequested, true); assert.equal(close.appExitCode, 0); assert.equal(close.appSignalCode, null);
  assert.deepEqual(close.groupRemaining, []); assert.equal(close.hostAbsent, true); assert.deepEqual(close.nativeRemaining, []);
  assert.deepEqual(receipt.beforeHarnessCleanup, []); assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.cleanupFailure, undefined); assert.equal(cleanup.capturedHostAbsent, true);
  const host = object(receipt.hostChild); assert.equal(host.pid, cleanup.hostPid); assert.equal(host.observedBeforeShutdown, true);
  await assertOriginalAbsent(host);
  assert.deepEqual(receipt.nativeRemaining, []);
  assert.equal(receipt.finiteModelCompleteAfterCleanup, true); assert.equal(receipt.modelServerClosed, true);
  assert.deepEqual(object(receipt.finiteModel).failures, []);
  const requests = expected.map(([step, model, outcome]) => ({ step, model, tools: 0, authorizationMatched: true, promptMatched: true, outcome }));
  assert.deepEqual(object(receipt.finiteModel).requests, requests); assert.deepEqual(proof.modelRequests, requests);
  const effects = rows(proof.effects); assert.equal(effects.length, 5);
  assert.equal(new Set(effects.map(row => row.commandId)).size, 5);
  const native = object(receipt.nativeProcesses), children = rows(native.children), probes = rows(native.probes);
  assert.equal(probes.length, 5); assert.ok(children.length >= 5 && children.length <= 32);
  assert.equal(new Set(probes.map(row => `${row.pid}:${row.birth}`)).size, 5);
  const commandDirectory = join(root, 'hoststore/management-commands');
  assert.deepEqual((await readdir(commandDirectory)).sort(), effects.map(row => managementDigest(row.commandId) + '.json').sort());
  for (let index = 0; index < expected.length; index++) {
    const [step, model] = expected[index]!, effect = effects[index]!, probe = probes[index]!;
    assert.equal(effect.step, step); assert.equal(effect.resourceHeld, false);
    const { digest, ...body } = await json(join(commandDirectory, managementDigest(effect.commandId) + '.json'));
    assert.equal(digest, managementDigest(body)); const command = storedManagementCommandSchema.parse(body);
    assert.equal(command.commandId, effect.commandId); assert.equal(command.profileId, management.profileId);
    assert.equal(command.configRevision, management.configRevision); assert.equal(command.providerId, 'test-local');
    assert.equal(command.resourceHeld, false); assert.equal(command.kind, effect.kind); assert.equal(command.phase, effect.phase);
    let nativeCommandId: string;
    if (index < 2) {
      assert.equal(command.kind, 'credential.set'); if (command.kind !== 'credential.set') throw new Error('Expected original key command');
      assert.equal(command.phase, index === 0 ? 'held' : 'completed'); assert.equal(command.terminalRejection, index === 0 ? true : undefined);
      assert.equal(command.openCodeV2?.phase, 'probe-completed'); assert.equal(command.openCodeV2?.verification?.ok, index === 1);
      nativeCommandId = command.openCodeV2!.verification!.commandId;
      assert.equal(nativeCommandId, 'connect-verify-' + managementDigest(command.commandId).slice(0, 48));
    } else {
      assert.equal(command.kind, 'model.probe'); if (command.kind !== 'model.probe') throw new Error('Expected original model command');
      assert.equal(command.phase, 'completed'); assert.equal(command.ok, true); assert.equal(command.modelId, 'test-local/' + model);
      nativeCommandId = command.commandId;
    }
    assert.equal(probe.step, step); assert.equal(probe.absentAfterReceipt, true);
    const child = children.find(row => row.pid === probe.pid && row.birth === probe.birth); assert.ok(child);
    assert.equal(child.role, 'probe'); assert.equal(child.ppid, cleanup.hostPid); assert.equal(child.pgid, child.pid);
    assert.equal(child.executableSha256, bun.sha256); assert.equal(child.dataRoot, probe.dataRoot);
    const nativeProfile = selectOpenCodeV2ManagementModel(management, { providerId: 'test-local', modelId: 'test-local/' + model });
    const prefix = 'agent-teams-v2-probe-' + managementDigest({ profile: nativeProfile, commandId: nativeCommandId }).slice(0, 16) + '-';
    assert.equal(dirname(text(probe.dataRoot)), management.environment.XDG_DATA_HOME); assert.ok(basename(text(probe.dataRoot)).startsWith(prefix));
  }
  for (const child of children) {
    assert.equal(child.ppid, cleanup.hostPid); assert.equal(child.pgid, child.pid); assert.equal(child.executableSha256, bun.sha256);
    await assertOriginalAbsent(child);
  }
  assert.ok(rows(receipt.finalSentinelCensus).length > 0 && rows(receipt.finalSentinelCensus).every(row => row.allowed === true));
  const credentials = object(proof.credentials);
  assert.equal(credentials.rejectedKeyRetainedUntilExplicitReplacement, true); assert.equal(credentials.successfulReplacementVerified, true);
  const authPath = join(management.environment.XDG_DATA_HOME!, 'opencode/auth.json');
  assert.deepEqual(await json(authPath), { 'test-local': { type: 'api', key: desktopV2SelectedKey } });
  assert.equal(await fileDigest(authPath), credentials.authSha256);
  const preferences = rows(proof.preferences); assert.equal(preferences.length, 3);
  for (const [index, scope, filename, model] of [[0, 'global', 'global/global-runtime-preferences.json', 'test-local/TEST-model'],
    [1, 'project', 'workspace/agent-teams-runtime-preferences.json', null]] as const) {
    const path = join(root, 'preferences', filename); assert.equal(preferences[index]!.scope, scope);
    assert.equal(parseManagedPreferences(await json(path)).defaultModelId, model);
    assert.equal(preferences[index]!.defaultModelId, model); assert.equal(await fileDigest(path), preferences[index]!.sha256);
  }
  assert.deepEqual(preferences[2], { scope: 'other', sha256: null, defaultModelId: null });
  await assert.rejects(lstat(join(root, 'preferences/workspace-other/agent-teams-runtime-preferences.json')), { code: 'ENOENT' });
  for (const [key, filename] of [['rejectionScreenshot', 'rejected-key'], ['connectedScreenshot', 'connected'],
    ['projectScreenshot', 'project-override'], ['inheritanceScreenshot', 'inherited'], ['reloadedScreenshot', 'reloaded']]) {
    const screenshot = object(proof[key!]), path = join(root, `ui-v2-management-${filename}.png`);
    assert.equal(screenshot.path, path); const image = await bytes(path, 16 * 1024 * 1024);
    assert.ok(image.length > 1024); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(await fileDigest(path), screenshot.sha256);
  }
  return { mode: summary.mode, status: 'PASS', sourceHead: head, receipt: receiptPath, receiptSha256: await fileDigest(receiptPath),
    modelRequests: 5, originalProbeProcesses: 5, screenshots: 5, nativeRemaining: 0 };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDesktopV2ManagementReceipt(await realpath(join(import.meta.dirname, '../..')),
    await realpath(process.env.RUNNER_TEMP!), process.env.HOST_EMULATED_SOURCE_HEAD!);
  await writeFile(join(process.env.RUNNER_TEMP!, 'host-emulated-opencode-v2-management-ui-verified.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result));
}
