// Failure evidence only: never changes the qualification gate or SDK acceptance.
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SDK_HEAD = 'd6361e0f50821ffc31cc5a9efd0dcaf6643c850d';
const NATIVE_SHA = 'bb731f311416df16691fa16763eb87657c4a5f5f3bcff5202718c416e8f7ab1a';
const SDK_CLOSURE_SHA = '60c1b866f6d90ce272001513e29a84a416306fe64bb61fc7e8fdfe6dbc05706f';
const sourcePins: ReadonlyArray<readonly [string, string]> = [
  ["src/services/opencode/OpenCodeBinaryResolver.ts", "835887e50b2110dd9eab585d95f63a0a3bc792317372b23bdc665c3404a94076"],
  ["src/services/opencode/OpenCodeCursorAgentTreeKill.ts", "f2f627dc8e046f17aa287b803ac8a7693a936e48c916e4229bef631ae1220c62"],
  ["src/services/opencode/compatibility/OpenCodeGenerationPolicy.ts", "5bd3b1ac41fea0bb54e67e7306bc73b4d602696dd8004a4cbf785aa488d18918"],
  ["src/services/opencode/compatibility/OpenCodeNativeIdentity.ts", "1aa543c0b1d1ec2d5a51999768d68d45d829c2c3d255fefafb92d4ceff04836a"],
  ["src/services/opencode/compatibility/OpenCodeVersionProbe.ts", "de5f62a250c67392cb8656c8a26bd1d65c4e5ca89122103975cd4e2a2073fcf1"],
  ["src/services/opencode/profile/OpenCodeV2ManagedConfig.ts", "2fbcce7612cd6b523a370b0f84513ad98adb2b878a15b31b580ffc01ffe32b38"],
  ["src/services/opencode/transport/OpenCodeBoundedFetch.ts", "27d3dbe54a9d9e0c91ad29433fed03d1597313661147054e7cc7e2ad483a2c2c"],
  ["src/utils/portableCli.ts", "04c23d5b6096159371f19379e7657b5a8e9b69578ee679cee0c53f02d3586e4c"],
  ["src/utils/processKill.ts", "fe32e7704fc34803d708def8158dc5697b678e43befbec4188ae0d74f46678a5"],
];
const receipt: Record<string, unknown> = {
  schemaVersion: 1, sdkHead: SDK_HEAD, sdkClosureSha256: SDK_CLOSURE_SHA,
  outcome: 'NOT_RUN', admissionCalls: 0, physicalRetirement: 'unproven', phase: 'platform',
};
let receiptPath: string | undefined;
const saveReceipt = () => {
  if (receiptPath) writeFileSync(receiptPath, JSON.stringify(receipt) + '\n');
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireInput(ok: unknown): asserts ok {
  if (!ok) throw new Error('diagnostic_precondition_failed');
}
const contained = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function json(file: string): Promise<unknown> {
  requireInput((await stat(file)).size <= 1024 * 1024);
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function main() {
  const instrumented = process.argv[2] === '--instrumented';
  const args = process.argv.slice(instrumented ? 3 : 2);
  if (instrumented) Object.assign(receipt, { diagnosticInstrumented: true, environmentEquivalentToPackagedRun: false, wrapperByteIdenticalToPackagedRun: false });
  const [sdkArg, rootArg, packageArg, outputArg, ...extra] = args;
  const runnerTemp = process.env.RUNNER_TEMP;
  requireInput(outputArg && runnerTemp && path.isAbsolute(outputArg) && path.isAbsolute(runnerTemp));
  requireInput(path.basename(outputArg) === 'selected-identity-diagnostic.json');
  requireInput(await realpath(path.dirname(outputArg)) === await realpath(runnerTemp));
  const outputLeaf = await lstat(outputArg);
  requireInput(outputLeaf.isFile() && !outputLeaf.isSymbolicLink());
  receiptPath = outputArg;
  saveReceipt();
  requireInput(process.platform === 'win32');
  if (!instrumented && process.env.SDK_CHECKOUT_OUTCOME !== 'success') {
    receipt.phase = 'sdk_source_unavailable';
    return;
  }
  receipt.phase = 'owned_inputs';
  requireInput(sdkArg && rootArg && packageArg && runnerTemp && extra.length === 0);
  requireInput([sdkArg, rootArg, packageArg, runnerTemp].every(value => path.isAbsolute(value)));
  const [sdk, root, packaged, temp] = await Promise.all([sdkArg, rootArg, packageArg, runnerTemp].map(value => realpath(value)));
  requireInput(sdk && root && packaged && temp && contained(root, temp));
  requireInput(path.basename(root).startsWith(instrumented ? 'TEST-windows-selected-identity-' : 'opencode-diagnostics-e2e-'));
  let native: string;
  let wrapper: string;
  let wrapperHash: string;
  if (instrumented) {
    receipt.phase = 'instrumented_provenance';
    const provenance = await json(path.join(root, 'provenance.json'));
    requireInput(record(provenance) && provenance.diagnosticInstrumented === true && provenance.sdkBase === SDK_HEAD);
    requireInput(provenance.sdkHead === process.env.DIAGNOSTIC_SDK_SHA && /^[a-f0-9]{40}$/.test(String(provenance.sdkHead)));
    requireInput(provenance.patchSha256 === process.env.DIAGNOSTIC_PATCH_SHA256 && /^[a-f0-9]{64}$/.test(String(provenance.patchSha256)));
    requireInput(provenance.sdkClosureSha256 === process.env.DIAGNOSTIC_CLOSURE_SHA256 && /^[a-f0-9]{64}$/.test(String(provenance.sdkClosureSha256)));
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const boundedText = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9. _()-]{1,100}$/.test(value);
    requireInput(typeof provenance.productSha === 'string' && /^[a-f0-9]{40}$/.test(provenance.productSha) && provenance.productSha === process.env.GITHUB_SHA);
    requireInput(record(provenance.bun) && provenance.bun.version === '1.3.11' &&
      provenance.bun.sha256 === 'b3e7109556f472490fd8cb2b69cf28aa264cbd2a6bd08d78f3e3d6c20b72d8a9' &&
      provenance.bun.archiveSha256 === '9d0e0f923e9626f3bc6044fc32e0d3ab29039aea753f5678ef8801cf26f75288' &&
      await hash(process.execPath) === provenance.bun.sha256);
    requireInput(record(provenance.compiler) && provenance.compiler.framework === 'v4.0.30319' &&
      boundedText(provenance.compiler.fileVersion) && digest(provenance.compiler.sha256));
    requireInput(record(provenance.wrapper) && digest(provenance.wrapper.sha256) &&
      digest(provenance.wrapper.stageHelperSha256) && digest(provenance.wrapper.sourceSha256) &&
      await hash(path.join(packaged, 'scripts', 'stage-opencode-console-wrapper.mjs')) === provenance.wrapper.stageHelperSha256 &&
      await hash(path.join(packaged, 'tools', 'opencode-console-wrapper', 'OpenCodeConsoleWrapper.cs')) === provenance.wrapper.sourceSha256);
    requireInput(record(provenance.runnerImage) && provenance.runnerImage.os === 'Windows' && boundedText(provenance.runnerImage.imageVersion));
    Object.assign(receipt, { sdkHead: provenance.sdkHead, sdkBase: SDK_HEAD, patchSha256: provenance.patchSha256,
      sdkClosureSha256: provenance.sdkClosureSha256, productSha: provenance.productSha,
      bun: { version: provenance.bun.version, sha256: provenance.bun.sha256, archiveSha256: provenance.bun.archiveSha256 },
      nativePackage: { name: 'opencode-windows-x64', version: '1.19.0', integrity: 'sha512-FsCVPchl5kjXg/UWGOtc2HuD5Fz+o6LtszUVdlVGmfVA+j/o0fSxjcYBHmIAU9/7P3KezAoQ2kL8YNn40O1DwQ==' },
      compiler: { framework: provenance.compiler.framework, fileVersion: provenance.compiler.fileVersion, sha256: provenance.compiler.sha256 },
      wrapperProvenance: { sha256: provenance.wrapper.sha256, stageHelperSha256: provenance.wrapper.stageHelperSha256, sourceSha256: provenance.wrapper.sourceSha256 },
      runnerImage: { os: provenance.runnerImage.os, imageVersion: provenance.runnerImage.imageVersion } });
    native = await realpath(path.join(root, 'native', 'package', 'bin', 'opencode.exe'));
    wrapper = await realpath(path.join(packaged, 'resources', 'runtime', 'opencode-console', 'opencode.exe'));
    requireInput(contained(native, root) && contained(wrapper, packaged) && await hash(native) === NATIVE_SHA);
    wrapperHash = await hash(wrapper);
    requireInput(wrapperHash === provenance.wrapper.sha256);
  } else {
    const manifest = await json(path.join(root, 'manifest.json'));
    requireInput(record(manifest) && manifest.packaged === true && manifest.platform === 'win32');
    requireInput(typeof manifest.root === 'string' && await realpath(manifest.root) === root);
    requireInput(record(manifest.artifact) && record(manifest.artifact.app));
    const app = path.join(packaged, 'AgentTeamsAI.exe');
    requireInput(typeof manifest.artifact.app.path === 'string' && await realpath(manifest.artifact.app.path) === await realpath(app));
    requireInput(typeof manifest.artifact.app.sha256 === 'string' && await hash(app) === manifest.artifact.app.sha256);
    receipt.phase = 'native_receipt';
    // Prefer the last owned run's saved receipt; no registry, auth or profile reads.
    requireInput(typeof manifest.run === 'string' && ['cold', 'warm-1', 'warm-2'].includes(manifest.run));
    const evidence = await json(path.join(root, manifest.run, 'evidence.json'));
    requireInput(record(evidence) && record(evidence.opencode));
    requireInput(evidence.opencode.version === '1.19.0' && evidence.opencode.sha256 === NATIVE_SHA);
    requireInput(typeof evidence.opencode.path === 'string' && path.isAbsolute(evidence.opencode.path));
    native = await realpath(evidence.opencode.path);
    requireInput(contained(native, path.join(root, 'user-data')) && await hash(native) === NATIVE_SHA);
    receipt.nativeHash = NATIVE_SHA;
    wrapper = await realpath(path.join(packaged, 'resources', 'runtime', 'opencode-console', 'opencode.exe'));
    requireInput(contained(wrapper, packaged));
    wrapperHash = await hash(wrapper);
  }
  receipt.nativeHash = NATIVE_SHA;
  receipt.wrapperHash = wrapperHash;
  receipt.phase = 'wrapper_sidecar';
  const sidecar = path.join(path.dirname(wrapper), 'opencode.real.path');
  requireInput((await stat(sidecar)).size <= 4096);
  const target = (await readFile(sidecar, 'utf8')).trim();
  requireInput(path.isAbsolute(target) && await realpath(target) === native);
  receipt.wrapperSidecarMatchesNative = true;
  receipt.phase = 'sdk_source';
  requireInput((await readFile(path.join(sdk, '.git', 'HEAD'), 'utf8')).trim() === receipt.sdkHead);
  const actualPins: Array<{ path: string; sha256: string }> = [];
  for (const [relative, expected] of sourcePins) {
    const actual = await hash(path.join(sdk, relative));
    if (!instrumented) requireInput(actual === expected);
    actualPins.push({ path: relative, sha256: actual });
  }
  const closureHash = createHash('sha256').update(JSON.stringify(actualPins)).digest('hex');
  requireInput(closureHash === receipt.sdkClosureSha256);
  receipt.sdkSourceVerified = true;
  const ownTmp = await mkdtemp(path.join(temp, 'TEST-windows-admission-'));
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  clean.PATH = [path.dirname(process.execPath), path.join(clean.SystemRoot ?? 'C:\\Windows', 'System32')].join(path.delimiter);
  Object.assign(clean, {
    HOME: ownTmp, USERPROFILE: ownTmp, APPDATA: ownTmp, LOCALAPPDATA: ownTmp,
    TMP: ownTmp, TEMP: ownTmp, TMPDIR: ownTmp,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapper, OPENCODE_BIN_PATH: wrapper,
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
  receipt.phase = 'sdk_import';
  saveReceipt();
  const identity: unknown = await import(pathToFileURL(path.join(sdk, 'src/services/opencode/compatibility/OpenCodeNativeIdentity.ts')).href);
  const cleanup: unknown = await import(pathToFileURL(path.join(sdk, 'src/services/opencode/compatibility/OpenCodeVersionProbe.ts')).href);
  requireInput(record(identity) && typeof identity.inspectOpenCodeReadSelection === 'function');
  requireInput(record(cleanup) && typeof cleanup.OpenCodeVersionProbeCleanupError === 'function');
  receipt.admissionCalls = 1;
  receipt.phase = 'admission';
  receipt.outcome = 'IN_PROGRESS';
  saveReceipt();
  const started = performance.now();
  const abort = new AbortController();
  let timedOut = false;
  // SDK keeps its own 5s acquisition / 8s cleanup budget. This outer guard
  // records a stalled diagnostic without granting any additional kill authority.
  const deadline = setTimeout(() => {
    timedOut = true;
    Object.assign(receipt, { outcome: 'TIMEOUT', elapsedMs: Math.round(performance.now() - started), physicalRetirement: 'unproven' });
    saveReceipt();
    abort.abort();
  }, 15000);
  try {
    const result: unknown = await identity.inspectOpenCodeReadSelection(abort.signal);
    if (timedOut) return;
    receipt.elapsedMs = Math.round(performance.now() - started);
    receipt.physicalRetirement = 'confirmed_by_owned_probe';
    receipt.phase = 'admission_result';
    requireInput(record(result) && record(result.policy));
    requireInput(result.path === wrapper && result.fingerprint === wrapperHash);
    requireInput(result.policy.generation === 'v1' && result.policy.version === '1.19.0');
    Object.assign(receipt, { policy: 'v1', version: '1.19.0', fingerprint: result.fingerprint });
    requireInput(await hash(wrapper) === wrapperHash && await hash(native) === NATIVE_SHA);
    if (timedOut) return;
    receipt.outcome = 'ADMITTED';
  } catch (error) {
    if (timedOut) return;
    receipt.elapsedMs = Math.round(performance.now() - started);
    receipt.outcome = 'REJECTED';
    receipt.class = error instanceof Error && ['cleanup_unknown', 'selection_unavailable', 'identity_mismatch'].includes(error.message)
      ? error.message : 'other_error';
    if (receipt.phase === 'admission_result') receipt.class = 'result_mismatch';
    receipt.helperFailure = null;
    if (error instanceof cleanup.OpenCodeVersionProbeCleanupError && record(error)) {
      const helper = error.helperFailure;
      if (record(helper) && ['birth', 'tree'].includes(String(helper.operation)) &&
        ['helper_timeout', 'helper_nonzero', 'helper_spawn_error', 'helper_output_limit', 'helper_error'].includes(String(helper.reason)) &&
        (helper.exitCode === null || Number.isSafeInteger(helper.exitCode)) &&
        typeof helper.elapsedMs === 'number' && Number.isFinite(helper.elapsedMs) && helper.elapsedMs >= 0) {
        receipt.helperFailure = { operation: helper.operation, reason: helper.reason, exitCode: helper.exitCode, elapsedMs: helper.elapsedMs };
      }
    }
    if (instrumented && error instanceof cleanup.OpenCodeVersionProbeCleanupError && record(error)) {
      const probe = error.probeFailure;
      const phases = ['started', 'initial_birth', 'census', 'anchor_birth', 'unanchored_members',
        'candidate_birth', 'candidate_identity_order', 'candidate_reappeared', 'confirmation_census',
        'confirmation_member_absent', 'confirmation_birth', 'signal_birth', 'signal',
        'pending_retirement', 'final_census', 'deadline', 'self_in_group', 'sleep'];
      const pid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
      if (record(probe) && phases.includes(String(probe.phase)) &&
        (probe.targetPid === null || pid(probe.targetPid)) &&
        (probe.targetRole === null || ['leader', 'member'].includes(String(probe.targetRole))) &&
        (probe.birthAvailable === null || typeof probe.birthAvailable === 'boolean') &&
        (probe.alive === null || ['alive', 'gone', 'unknown'].includes(String(probe.alive))) &&
        (probe.censusMemberCount === null || (typeof probe.censusMemberCount === 'number' && Number.isSafeInteger(probe.censusMemberCount) && probe.censusMemberCount >= 0)) &&
        Array.isArray(probe.censusMemberPids) && probe.censusMemberPids.length <= 64 && probe.censusMemberPids.every(pid)) {
        receipt.probeFailure = { phase: probe.phase, targetPid: probe.targetPid, targetRole: probe.targetRole,
          birthAvailable: probe.birthAvailable, alive: probe.alive, censusMemberCount: probe.censusMemberCount,
          censusMemberPids: probe.censusMemberPids };
      } else if (probe !== undefined && probe !== null) {
        receipt.probeFailureRejected = true;
      }
    }
    // Retained SDK owners may still use ownTmp; do not erase it on rejection.
  } finally {
    clearTimeout(deadline);
  }
  saveReceipt();
  if (receipt.outcome === 'ADMITTED') {
    try {
      await rm(ownTmp, { recursive: true, force: true });
      receipt.ownTmpRemoved = true;
    } catch (error) {
      receipt.ownTmpRemoved = false;
      receipt.cleanupFailure = record(error) && ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)) ? error.code : 'other_error';
    }
  }
}
try { await main(); }
catch { receipt.outcome = receipt.admissionCalls === 1 ? 'REJECTED' : 'NOT_RUN'; }
saveReceipt();
