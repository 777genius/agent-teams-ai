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
  const [sdkArg, rootArg, packageArg, outputArg, ...extra] = process.argv.slice(2);
  const runnerTemp = process.env.RUNNER_TEMP;
  requireInput(outputArg && runnerTemp && path.isAbsolute(outputArg) && path.isAbsolute(runnerTemp));
  requireInput(path.basename(outputArg) === 'selected-identity-diagnostic.json');
  requireInput(await realpath(path.dirname(outputArg)) === await realpath(runnerTemp));
  const outputLeaf = await lstat(outputArg);
  requireInput(outputLeaf.isFile() && !outputLeaf.isSymbolicLink());
  receiptPath = outputArg;
  saveReceipt();
  requireInput(process.platform === 'win32');
  if (process.env.SDK_CHECKOUT_OUTCOME !== 'success') {
    receipt.phase = 'sdk_source_unavailable';
    return;
  }
  receipt.phase = 'owned_inputs';
  requireInput(sdkArg && rootArg && packageArg && runnerTemp && extra.length === 0);
  requireInput([sdkArg, rootArg, packageArg, runnerTemp].every(value => path.isAbsolute(value)));
  const [sdk, root, packaged, temp] = await Promise.all([sdkArg, rootArg, packageArg, runnerTemp].map(value => realpath(value)));
  requireInput(sdk && root && packaged && temp && contained(root, temp));
  requireInput(path.basename(root).startsWith('opencode-diagnostics-e2e-'));
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
  const native = await realpath(evidence.opencode.path);
  requireInput(contained(native, path.join(root, 'user-data')) && await hash(native) === NATIVE_SHA);
  receipt.nativeHash = NATIVE_SHA;
  receipt.phase = 'packaged_wrapper_sidecar';
  const wrapper = await realpath(path.join(packaged, 'resources', 'runtime', 'opencode-console', 'opencode.exe'));
  requireInput(contained(wrapper, packaged));
  const wrapperHash = await hash(wrapper);
  receipt.wrapperHash = wrapperHash;
  const sidecar = path.join(path.dirname(wrapper), 'opencode.real.path');
  requireInput((await stat(sidecar)).size <= 4096);
  const target = (await readFile(sidecar, 'utf8')).trim();
  requireInput(path.isAbsolute(target) && await realpath(target) === native);
  receipt.wrapperSidecarMatchesNative = true;
  receipt.phase = 'sdk_source';
  requireInput((await readFile(path.join(sdk, '.git', 'HEAD'), 'utf8')).trim() === SDK_HEAD);
  for (const [relative, expected] of sourcePins) requireInput(await hash(path.join(sdk, relative)) === expected);
  const closureHash = createHash('sha256').update(JSON.stringify(sourcePins.map(([file, sha256]) => ({ path: file, sha256 })))).digest('hex');
  requireInput(closureHash === SDK_CLOSURE_SHA);
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
