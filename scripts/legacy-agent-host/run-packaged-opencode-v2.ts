/** Run the existing Host scenario using only the actual unsigned candidate's resources. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { candidateDigest } from './candidate-closure.ts';
import { readPackagedOpenCodeV2 } from './packaged-opencode-v2-inputs.ts';
import { nativeHostEnvironment } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
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
  try { await rename(originalBundle, relocatedBundle); bundleMoved = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(originalBundle, relocatedBundle, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    bundleCopied = true;
  }
  const capture = { resourcesRoot: join(resources, 'legacy-agent-host'),
    manifestSha256: process.env.OPENCODE_V2_PACKAGED_MANIFEST_SHA256!,
    appAsar: join(resources, 'app.asar'), appAsarSha256: await candidateDigest(join(resources, 'app.asar')) };
  const captured = await readPackagedOpenCodeV2(capture);
  assert.equal(captured.manifest.sourceHead, sourceHead);
  assert.equal(await candidateDigest(harness), captured.manifest.harnessSha256);
  receipt.appAsarSha256 = capture.appAsarSha256;
  receipt.candidateManifestSha256 = capture.manifestSha256;
  receipt.hostEntrySha256 = captured.manifest.hostEntrySha256;
  receipt.nodeSha256 = captured.manifest.node.binarySha256;
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
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    const child = spawn(captured.node, [harness], { cwd: root, env: environment,
      stdio: ['ignore', 'inherit', 'inherit'], timeout: 480_000, killSignal: 'SIGTERM' });
    nativeStarted = true;
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  receipt.nativeExit = outcome;
  assert.deepEqual(outcome, { code: 0, signal: null });
  const native = JSON.parse(await readFile(nativeReceiptPath, 'utf8'));
  assert.equal(native.kind, 'TEST_PACKAGED_NATIVE_V2_HOST');
  assert.equal(native.status, 'PASS'); assert.equal(native.cleanup, true);
  nativeCleanupConfirmed = true;
  assert.equal(native.sourceHead, sourceHead); assert.equal(native.platform, requestedPlatform);
  assert.equal(native.approvalMode, 'manual'); assert.equal(native.modelRequests, 8);
  assert.deepEqual(native.modelFailures, []);
  assert.equal(native.packaged.sourceCheckoutUnavailable, true);
  assert.equal(native.packaged.legacyRuntimeUnavailable, true);
  assert.equal(native.packaged.appAsarSha256, capture.appAsarSha256);
  assert.equal(native.packaged.candidateManifestSha256, capture.manifestSha256);
  receipt.nativeReceiptSha256 = await candidateDigest(nativeReceiptPath);
  receipt.sourceCheckoutUnavailable = true;
  receipt.legacyRuntimeUnavailable = true;
  passed = true;
} catch (error) { originalFailure = error; }
finally {
  // Restoration is independent of provider/scenario failure. Never leave the
  // disposable job checkout hidden, or claim complete packaging after a failed restore.
  process.chdir(runnerTemp);
  if (sourceMoved) {
    try { await rename(hiddenSource, repo); sourceMoved = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (legacyMoved) {
    try { await rename(retainedLegacy, join(resources, 'runtime')); legacyMoved = false; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (bundleMoved && !sourceMoved) {
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
  try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { cleanupErrors.push(error); }
}
if (originalFailure !== undefined) throw originalFailure;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST packaged input restoration failed');
assert.equal(passed, true);
process.stdout.write(JSON.stringify(receipt) + '\n');
