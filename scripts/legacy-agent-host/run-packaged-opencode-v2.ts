/** Run the existing Host scenario using only the actual unsigned candidate's resources. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { candidateDigest } from './candidate-closure.ts';
import { readPackagedOpenCodeV2, renameCapturedPackagedBundle } from './packaged-opencode-v2-inputs.ts';
import { nativeHostEnvironment, writeNativeFailureReceipt } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { assertNativeV1Source } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';

const repo = await realpath(resolve(import.meta.dirname, '../..'));
const [bundleArgument, requestedPlatform, ...extra] = process.argv.slice(2);
assert.ok(bundleArgument && requestedPlatform && extra.length === 0);
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'relocation is confined to the disposable CI checkout');
assert.equal(await realpath(process.env.GITHUB_WORKSPACE!), repo);
assert.equal(requestedPlatform, `${process.platform}-${process.arch}`);
const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
assertNativeV1Source(repo, sourceHead);
const originalBundle = await realpath(resolve(repo, bundleArgument));
const relativeBundle = relative(repo, originalBundle);
assert.ok(relativeBundle.startsWith(`release${sep}`) && !relativeBundle.split(sep).includes('..'));
const runnerTemp = await realpath(process.env.RUNNER_TEMP!);
assert.ok(isAbsolute(runnerTemp) && !runnerTemp.startsWith(repo + sep));
const root = await realpath(await mkdtemp(join(runnerTemp, 'TEST-packaged-v2-')));
const relocatedBundle = join(root, basename(originalBundle));
const resources = join(relocatedBundle, ...(process.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']));
const retainedLegacy = join(root, 'TEST-retained-legacy-runtime');
const hiddenSource = join(dirname(repo), `.TEST-packaged-source-${randomUUID()}`);
const harness = await realpath(process.env.OPENCODE_V2_PACKAGED_HARNESS!);
assert.ok(harness.startsWith(runnerTemp + sep) && basename(harness).startsWith('TEST-packaged-v2-host-'));
const receiptPath = process.env.OPENCODE_V2_PACKAGED_RECEIPT!;
assert.ok(receiptPath && isAbsolute(receiptPath) && !receiptPath.startsWith(repo + sep));
const nativeReceiptPath = receiptPath.replace(/\.json$/, '') + '-native.json';
let sourceMoved = false, bundleMoved = false, bundleCopied = false, legacyMoved = false;
let passed = false, nativeStarted = false, nativeCleanupConfirmed = false, originalFailure: unknown;
const cleanupErrors: unknown[] = [];
const receipt: Record<string, unknown> = { kind: 'TEST_PACKAGED_V2_QUALIFICATION', status: 'HOLD',
  sourceHead, platform: requestedPlatform, cleanup: false, phase: 'relocation',
  desktopJourneyQualified: false, vendorAuthQualified: false, releaseQualified: false };
try {
  let originalAppAsarSha256: string | undefined;
  if (process.platform === 'win32') {
    const originalResources = join(originalBundle, 'resources');
    originalAppAsarSha256 = await candidateDigest(join(originalResources, 'app.asar'));
    const original = await readPackagedOpenCodeV2({ resourcesRoot: join(originalResources, 'legacy-agent-host'),
      manifestSha256: process.env.OPENCODE_V2_PACKAGED_MANIFEST_SHA256!,
      appAsar: join(originalResources, 'app.asar'), appAsarSha256: originalAppAsarSha256 });
    assert.equal(original.manifest.sourceHead, sourceHead);
    assert.equal(await candidateDigest(harness), original.manifest.harnessSha256);
  }
  try {
    if (process.platform === 'win32') await renameCapturedPackagedBundle(originalBundle, relocatedBundle);
    else await rename(originalBundle, relocatedBundle);
    bundleMoved = true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(originalBundle, relocatedBundle, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    bundleCopied = true;
  }
  const capture = { resourcesRoot: join(resources, 'legacy-agent-host'),
    manifestSha256: process.env.OPENCODE_V2_PACKAGED_MANIFEST_SHA256!,
    appAsar: join(resources, 'app.asar'), appAsarSha256: originalAppAsarSha256 ?? await candidateDigest(join(resources, 'app.asar')) };
  const captured = await readPackagedOpenCodeV2(capture);
  assert.equal(captured.manifest.sourceHead, sourceHead);
  assert.equal(await candidateDigest(harness), captured.manifest.harnessSha256);
  receipt.appAsarSha256 = capture.appAsarSha256;
  receipt.candidateManifestSha256 = capture.manifestSha256;
  receipt.hostEntrySha256 = captured.manifest.hostEntrySha256;
  receipt.nodeSha256 = captured.manifest.node.binarySha256;
  await assert.rejects(lstat(nativeReceiptPath), { code: 'ENOENT' }, 'a previous receipt cannot attest this original child');
  // Keep the legacy payload intact outside the tested bundle. Any dependency on
  // its front door, Node or Bun must fail while this selected Host path is tested.
  await rename(join(resources, 'runtime'), retainedLegacy); legacyMoved = true;
  process.chdir(root);
  assertNativeV1Source(repo, sourceHead);
  await rename(repo, hiddenSource); sourceMoved = true;
  await assert.rejects(lstat(repo), { code: 'ENOENT' });
  for (const name of ['home', 'tmp']) await mkdir(join(root, name));
  const environment = { ...nativeHostEnvironment(captured.node, root),
    OPENCODE_V2_PACKAGED_GO: '1', OPENCODE_V2_PACKAGED_CAPTURE: JSON.stringify(capture),
    OPENCODE_V2_PACKAGED_SOURCE_ROOT: repo, OPENCODE_V2_TEST_SOURCE_HEAD: sourceHead,
    OPENCODE_V2_EMBEDDED_HOST_RECEIPT: nativeReceiptPath,
    OPENCODE_V2_EMBEDDED_APPROVAL_MODE: 'manual' };
  receipt.phase = 'native-host';
  const child = spawn(captured.node, [harness], { cwd: root, env: environment,
    stdio: ['pipe', 'inherit', 'inherit'] });
  nativeStarted = child.pid !== undefined;
  child.once('spawn', () => { nativeStarted = true; });
  child.stdin.on('error', () => { /* The original exit and receipt remain decisive. */ });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  const waitExit = async (timeoutMs: number) => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([exited, new Promise<undefined>(done => {
      timer = setTimeout(() => done(undefined), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  let outcome = await waitExit(480_000);
  const timedOut = outcome === undefined;
  if (timedOut) {
    receipt.timedOut = true;
    // EOF asks the captured TEST harness to close its retained original Host.
    // Killing only this root cannot prove absence of Host's detached native Bun.
    child.stdin.end();
    outcome = await waitExit(90_000);
  }
  if (!outcome) {
    child.unref();
    throw new Error('TEST packaged original Host cleanup remains unknown after cancellation');
  }
  receipt.nativeExit = outcome;
  const native = JSON.parse(await readFile(nativeReceiptPath, 'utf8'));
  assert.equal(native.kind, 'TEST_PACKAGED_NATIVE_V2_HOST');
  assert.equal(native.sourceHead, sourceHead); assert.equal(native.platform, requestedPlatform);
  assert.equal(native.packaged.appAsarSha256, capture.appAsarSha256);
  assert.equal(native.packaged.candidateManifestSha256, capture.manifestSha256);
  assert.equal(native.packaged.harnessSha256, captured.manifest.harnessSha256);
  assert.equal(native.cleanup, true);
  assert.ok(Array.isArray(native.hosts) && native.hosts.every((host: Record<string, unknown>) =>
    host.exitCode === 0 && host.signalCode === null && host.stdoutValid === true));
  nativeCleanupConfirmed = true;
  receipt.nativeReceiptSha256 = await candidateDigest(nativeReceiptPath);
  assert.equal(timedOut, false, 'a cancelled scenario cannot qualify the candidate');
  assert.deepEqual(outcome, { code: 0, signal: null });
  assert.equal(native.status, 'PASS');
  assert.equal(native.approvalMode, 'manual'); assert.equal(native.modelRequests, 11);
  assert.deepEqual(native.modelFailures, []);
  assert.equal(native.packaged.sourceCheckoutUnavailable, true);
  assert.equal(native.packaged.legacyRuntimeUnavailable, true);
  receipt.sourceCheckoutUnavailable = true;
  receipt.legacyRuntimeUnavailable = true;
  passed = true;
} catch (error) { originalFailure = error; }
finally {
  // Scenario failure may restore only after the retained original Host attests
  // cleanup. UNKNOWN leaves these isolated TEST inputs in place for diagnosis.
  process.chdir(runnerTemp);
  const canRestore = !nativeStarted || nativeCleanupConfirmed;
  if (!canRestore) {
    cleanupErrors.push(new Error('TEST packaged inputs retained because original native cleanup is unconfirmed'));
    receipt.retainedInputs = { root, hiddenSource };
  }
  if (canRestore && sourceMoved) {
    try { await rename(hiddenSource, repo); sourceMoved = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (canRestore && legacyMoved) {
    try { await rename(retainedLegacy, join(resources, 'runtime')); legacyMoved = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (canRestore && bundleMoved && !sourceMoved) {
    try { await rename(relocatedBundle, originalBundle); bundleMoved = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (!sourceMoved) {
    try { assertNativeV1Source(repo, sourceHead); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (passed && cleanupErrors.length === 0 && !legacyMoved && !bundleMoved) {
    try { await rm(root, { recursive: true, force: true }); bundleCopied = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  receipt.cleanup = (!nativeStarted || nativeCleanupConfirmed) && cleanupErrors.length === 0 &&
    !sourceMoved && !legacyMoved && !bundleMoved && (!passed || !bundleCopied);
  receipt.sourceRestored = !sourceMoved;
  receipt.bundleRestored = !bundleMoved;
  receipt.legacyRuntimeRestored = !legacyMoved;
  receipt.status = passed && receipt.cleanup ? 'PASS' : 'INCOMPLETE';
  receipt.phase = 'finished';
  let serialized: string | undefined;
  let receiptWritten = false;
  try {
    serialized = JSON.stringify(receipt, null, 2) + '\n';
    await writeFile(receiptPath, serialized, { mode: 0o600 });
    receiptWritten = true;
  }
  catch (error) { cleanupErrors.push(error); }
  if (serialized !== undefined && (originalFailure !== undefined || cleanupErrors.length > 0 || !passed)) {
    await writeNativeFailureReceipt({ kind: 'TEST_PACKAGED_V2_FAILURE_RECEIPT', sourceHead,
      platform: requestedPlatform, serialized, details: { receiptWritten } });
  }
}
if (originalFailure !== undefined) {
  if (cleanupErrors.length) throw new AggregateError([originalFailure, ...cleanupErrors],
    'TEST packaged scenario failed with unconfirmed cleanup or restoration');
  throw originalFailure;
}
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST packaged input restoration failed');
assert.equal(passed, true);
process.stdout.write(JSON.stringify(receipt) + '\n');
