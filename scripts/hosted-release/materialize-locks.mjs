#!/usr/bin/env node
import { createHash, randomUUID, verify as verifySignature } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { LEGACY_HOSTED_OWNER_LOCK_FILENAME, OWNER_LOCK_FILENAME, STACK_LOCK_FILENAME, canonicalJsonBytes, actualOwnersEqual, resolveCommittedHostedLockPair, sha256Digest, trustedReleasePolicyFor, verifyHostedLockPair } from './contracts.mjs';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const MAX_COMPRESSED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_MEMBERS = 2048;
const MAX_ARTIFACT_PATH_BYTES = 4096;
const PUBLICATION_SCHEMA = 1;
const TRANSACTION_PREFIX = '.hosted-lock-transaction-';
const COMMIT_MARKER = '.hosted-lock-commit.json';
const LEASE_MS = 60_000;
const DESCRIPTOR_LINK_TIMEOUT_MS = 5_000;
const DESCRIPTOR_LINK_PROGRAM = "import ctypes,os,sys\nlibc=ctypes.CDLL(None,use_errno=True)\nlibc.linkat.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_int]\nerrno=libc.linkat(-100,b'/proc/self/fd/3',4,os.fsencode(sys.argv[1]),0x400)\nif errno: raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))";
export async function materializeHostedLockPair(input, trustedAdapter) {
  if (!input || typeof input !== 'object') throw new TypeError('materializer input must be an object');
  const { product, owner, openCode, actualOwner, contracts, deploymentRecipe } = input;
  if (!product || !owner || !openCode || !actualOwner || !contracts || !deploymentRecipe) {
    throw new Error('product, owner, openCode, actualOwner, contracts, and deploymentRecipe are required');
  }
  if (!actualOwnersEqual(owner.actualOwner, actualOwner)) {
    throw new Error('owner.actualOwner must exactly match the actual-owner identity tuple');
  }
  await verifyIndependentEvidence(input, trustedReleasePolicyFor(trustedAdapter));
  const ownerLock = { ...owner, schemaVersion: 1, lockType: 'hosted-lifecycle-owner' };
  const ownerBytes = canonicalJsonBytes(ownerLock);
  const stackLock = { product, owner: { ...owner, lockSha256: sha256Digest(ownerBytes) }, openCode, contracts,
    toolchains: { productSha256: sha256Digest(canonicalJsonBytes(product.toolchain)), ownerSha256: sha256Digest(canonicalJsonBytes(owner.toolchain)), openCodeSha256: sha256Digest(canonicalJsonBytes(openCode.toolchain)) },
    deploymentRecipe, eligibility: { temporaryRuntime: true, productionEligible: false, releaseEligible: false }, schemaVersion: 1, lockType: 'hosted-stack' };
  const stackBytes = canonicalJsonBytes(stackLock);
  verifyHostedLockPair(ownerBytes, stackBytes);
  return { ownerBytes, stackBytes, ownerSha256: sha256Digest(ownerBytes), stackSha256: sha256Digest(stackBytes) };
}
export async function recomputeHostedLockDigests(ownerBytes, stackBytes, evidence, trustedAdapter) {
  const pair = verifyHostedLockPair(ownerBytes, stackBytes);
  await verifyIndependentEvidence({ product: pair.stack.product, owner: evidenceIdentity(pair.owner), openCode: pair.stack.openCode, actualOwner: pair.owner.actualOwner, contracts: pair.stack.contracts, deploymentRecipe: pair.stack.deploymentRecipe, evidence }, trustedReleasePolicyFor(trustedAdapter));
  const declaredDigests = recomputeDeclaredDigests(pair, evidence);
  const declarations = collectDeclaredDigests({ owner: pair.owner, stack: pair.stack });
  if (Object.keys(declarations).length !== Object.keys(declaredDigests).length) {
    throw new Error('declared digest recomputation is incomplete');
  }
  for (const [name, declared] of Object.entries(declarations)) {
    if (declaredDigests[name] !== declared) throw new Error(`${name} does not match recomputed evidence`);
  }
  return { ownerSha256: sha256Digest(ownerBytes), stackSha256: sha256Digest(stackBytes), productToolchainSha256: sha256Digest(canonicalJsonBytes(pair.stack.product.toolchain)), ownerToolchainSha256: sha256Digest(canonicalJsonBytes(pair.owner.toolchain)), openCodeToolchainSha256: sha256Digest(canonicalJsonBytes(pair.stack.openCode.toolchain)), declaredDigests };
}
export async function materializeHostedLocksAtRoot(root, input, trustedAdapter, options = {}) {
  requireLinuxFilesystemPublication('secure hosted lock publication');
  const resolvedRoot = path.resolve(root), result = await materializeHostedLockPair(input, trustedAdapter);
  const rootBinding = await openBoundRoot(resolvedRoot);
  const { parentHandle, rootHandle } = rootBinding;
  const rootAnchor = descriptorPath(rootHandle);
  const transactionId = randomUUID();
  const transactionName = `${TRANSACTION_PREFIX}${transactionId}`;
  const transactionRoot = path.join(rootAnchor, transactionName);
  const reservationPath = path.join(rootAnchor, `${transactionName}.json`);
  const markerPath = path.join(rootAnchor, COMMIT_MARKER);
  let reservation, reservationIdentity, transactionHandle, transactionIdentity, marker, markerIdentity, markerPathInTransaction, committed = false;
  const temporary = [{ name: OWNER_LOCK_FILENAME, path: path.join(transactionRoot, OWNER_LOCK_FILENAME), bytes: result.ownerBytes, handle: undefined, identity: undefined }, { name: STACK_LOCK_FILENAME, path: path.join(transactionRoot, STACK_LOCK_FILENAME), bytes: result.stackBytes, handle: undefined, identity: undefined }];
  let primaryError;
  const cleanupErrors = [];
  try {
    await assertRootBinding(rootBinding);
    await recoverTransactions(rootAnchor, rootHandle, markerPath, () => assertRootBinding(rootBinding));
    await assertNoRootLevelLockEntries(rootAnchor);
    if (await exists(markerPath, 2)) throw new Error('hosted locks are already committed');
    await assertRootBinding(rootBinding);
    reservation = await open(reservationPath, 'wx+', 0o600); reservationIdentity = await reservation.stat({ bigint: true });
    await writeTransaction(reservation, reservationIdentity, transactionRecord(transactionId, transactionName, 'reserved'));
    await syncDirectory(rootHandle);
    await assertRootBinding(rootBinding);
    await mkdir(transactionRoot, { recursive: false, mode: 0o700 });
    await syncDirectory(rootHandle);
    transactionHandle = await openDirectoryNoFollow(transactionRoot); transactionIdentity = await transactionHandle.stat({ bigint: true });
    const stagingAnchor = descriptorPath(transactionHandle);
    for (const entry of temporary) entry.path = path.join(stagingAnchor, path.basename(entry.path));
    for (const entry of temporary) {
      await assertRootBinding(rootBinding);
      await assertDirectoryIdentity(stagingAnchor, transactionIdentity);
      entry.handle = await open(entry.path, 'wx+', 0o644);
      entry.identity = await entry.handle.stat({ bigint: true });
      await entry.handle.writeFile(entry.bytes);
      await entry.handle.sync();
      await verifyOwnedBytes(entry.path, entry.handle, entry.identity, entry.bytes, 1n);
    }
    await writeTransaction(reservation, reservationIdentity, transactionRecord(transactionId, transactionName, 'staged'));
    await options.onStaged?.({ stagingRoot: transactionRoot, temporary: temporary.map((entry) => entry.path) });
    for (const entry of temporary) await verifyOwnedBytes(entry.path, entry.handle, entry.identity, entry.bytes, 1n);
    await syncDirectory(transactionHandle);
    await options.onCleanup?.();
    await writeTransaction(reservation, reservationIdentity, transactionRecord(transactionId, transactionName, 'ready-to-commit'));
    await options.onPublished?.({ paths: temporary.map((entry) => entry.path) });
    const commit = commitRecord(transactionId, transactionName, result, transactionIdentity);
    markerPathInTransaction = path.join(stagingAnchor, `${COMMIT_MARKER}.${transactionId}.tmp`);
    await assertRootBinding(rootBinding);
    marker = await open(markerPathInTransaction, 'wx+', 0o600); markerIdentity = await marker.stat({ bigint: true });
    await writeTransaction(marker, markerIdentity, commit);
    await verifyOwnedBytes(markerPathInTransaction, marker, markerIdentity, canonicalJsonBytes(commit));
    await options.onMarkerReady?.({ markerPath: markerPathInTransaction });
    await verifyOwnedBytes(markerPathInTransaction, marker, markerIdentity, canonicalJsonBytes(commit));
    for (const entry of temporary) await verifyOwnedBytes(entry.path, entry.handle, entry.identity, entry.bytes, 1n);
    await assertDirectoryIdentity(stagingAnchor, transactionIdentity);
    await assertRootBinding(rootBinding);
    await assertDirectoryIdentity(path.join(rootAnchor, transactionName), transactionIdentity, true);
    await assertNoRootLevelLockEntries(rootAnchor);
    await syncDirectory(transactionHandle);
    await linkHeldFileAt(rootHandle, marker, COMMIT_MARKER);
    await assertPublishedMarker(markerPath, markerIdentity, 2n); await verifyOwnedBytes(markerPath, marker, markerIdentity, canonicalJsonBytes(commit), 2n);
    await verifyOwnedBytes(markerPathInTransaction, marker, markerIdentity, canonicalJsonBytes(commit), 2n);
    await syncDirectory(rootHandle);
    committed = true;
    await captureCleanup(cleanupErrors, () => options.onCommittedCleanup?.());
    await verifyOwnedBytes(markerPath, marker, markerIdentity, canonicalJsonBytes(commit), 2n);
    await verifyOwnedBytes(markerPathInTransaction, marker, markerIdentity, canonicalJsonBytes(commit), 2n);
    for (const entry of temporary) await verifyOwnedBytes(entry.path, entry.handle, entry.identity, entry.bytes, 1n);
    await assertDirectoryIdentity(path.join(rootAnchor, transactionName), transactionIdentity, true);
    await assertPublishedMarker(markerPath, markerIdentity, 2n);
    await assertRootBinding(rootBinding);
    await assertNoRootLevelLockEntries(rootAnchor);
    const verified = await resolveCommittedHostedLockPair(resolvedRoot);
    if (!verified.ownerBytes.equals(result.ownerBytes) || !verified.stackBytes.equals(result.stackBytes) || verified.transactionIdentity.device !== transactionIdentity.dev.toString() || verified.transactionIdentity.inode !== transactionIdentity.ino.toString()) throw new Error('authoritative hosted lock reader disagrees with published generation');
  } catch (error) {
    primaryError = error;
  } finally {
    if (!committed && reservation && reservationIdentity) {
      await captureCleanup(cleanupErrors, () => writeTransaction(reservation, reservationIdentity, transactionRecord(transactionId, transactionName, 'partial', primaryError)));
    }
    for (const entry of temporary) await captureCleanup(cleanupErrors, () => entry.handle?.close());
    await captureCleanup(cleanupErrors, () => marker?.close());
    await captureCleanup(cleanupErrors, () => transactionHandle?.close());
    await captureCleanup(cleanupErrors, () => reservation?.close());
    await captureCleanup(cleanupErrors, async () => { await rootHandle.close(); await parentHandle.close(); });
  }
  if (primaryError || (!committed && cleanupErrors.length)) throw aggregateFailure(primaryError, cleanupErrors);
  return { ...result, ownerPath: path.join(resolvedRoot, transactionName, OWNER_LOCK_FILENAME), stackPath: path.join(resolvedRoot, transactionName, STACK_LOCK_FILENAME),
    transactionIdentity: { device: transactionIdentity.dev.toString(), inode: transactionIdentity.ino.toString() }, warnings: cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)) };
}
function requireLinuxFilesystemPublication(operation) {
  if (process.platform !== 'linux') throw new Error(`${operation} is unsupported on this platform; Linux descriptor-anchored filesystems are required`);
}
function descriptorPath(handle) { if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`; throw new Error('secure hosted lock publication requires descriptor-anchored paths on this platform'); }
async function linkHeldFileAt(destinationDirectory, source, destinationName) {
  if (process.platform !== 'linux' || !/^[^/]+$/u.test(destinationName)) throw new Error('secure hosted lock publication requires a Linux descriptor-link primitive');
  await new Promise((resolve, reject) => {
    let settled = false, stderr = '';
    const child = spawn('/usr/bin/python3', ['-I', '-c', DESCRIPTOR_LINK_PROGRAM, destinationName], { stdio: ['ignore', 'ignore', 'pipe', source.fd, destinationDirectory.fd] });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('descriptor-link helper exceeded its execution bound')); }, DESCRIPTOR_LINK_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { if (stderr.length < 1024) stderr += chunk.toString(); });
    child.once('error', (error) => finish(new Error(`descriptor-link helper failed: ${error.message}`)));
    child.once('exit', (code, signal) => { if (code === 0) return finish(); const error = new Error(`descriptor-link helper failed${signal ? ` (${signal})` : ''}: ${stderr.trim().slice(0, 1024)}`); if (/\[Errno 17\]/u.test(stderr)) error.code = 'EEXIST'; finish(error); });
  });
}
async function openBoundRoot(rootPath) {
  const parentPath = path.dirname(rootPath), rootName = path.basename(rootPath);
  if (!rootName || rootPath === path.parse(rootPath).root) throw new Error('hosted lock root must not be a filesystem root');
  const parentHandle = await openTrustedDirectory(parentPath);
  try {
    const parentIdentity = await parentHandle.stat({ bigint: true });
    const rootPathFromParent = path.join(descriptorPath(parentHandle), rootName);
    try { await mkdir(rootPathFromParent, { mode: 0o700 }); await syncDirectory(parentHandle); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const rootHandle = await openDirectoryNoFollow(rootPathFromParent);
    return { parentHandle, parentIdentity, rootHandle, rootIdentity: await rootHandle.stat({ bigint: true }), rootName, rootPath };
  } catch (error) { await parentHandle.close(); throw error; }
}
async function assertRootBinding(binding) {
  await assertDirectoryHandleIdentity(binding.parentHandle, binding.parentIdentity);
  const fromHeldParent = await openDirectoryNoFollow(path.join(descriptorPath(binding.parentHandle), binding.rootName));
  try { await assertDirectoryHandleIdentity(fromHeldParent, binding.rootIdentity); } finally { await fromHeldParent.close(); }
  const fromCallerPath = await openDirectoryNoFollow(binding.rootPath);
  try { await assertDirectoryHandleIdentity(fromCallerPath, binding.rootIdentity); } finally { await fromCallerPath.close(); }
  await assertDirectoryHandleIdentity(binding.rootHandle, binding.rootIdentity);
}
async function assertDirectoryHandleIdentity(handle, expected) {
  const current = await handle.stat({ bigint: true });
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) throw new Error('hosted lock root pathname was renamed or replaced during publication');
}
async function openTrustedDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath), parsed = path.parse(absolute); let current = await openDirectoryNoFollow(parsed.root);
  try {
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) { const candidate = path.join(descriptorPath(current), segment); try { await mkdir(candidate, { mode: 0o700 }); await syncDirectory(current); } catch (error) { if (error?.code !== 'EEXIST') throw error; } const next = await openDirectoryNoFollow(candidate); await current.close(); current = next; }
    return current;
  } catch (error) { await current.close(); throw error; }
}
async function openDirectoryNoFollow(directoryPath) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) throw new Error('secure hosted lock publication requires O_NOFOLLOW');
  const handle = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isDirectory()) { await handle.close(); throw new Error('hosted lock root must be a directory and not a symlink'); }
  return handle;
}
async function directoryIdentity(directoryPath, noFollow = false) {
  const metadata = await (noFollow ? lstat : stat)(directoryPath, { bigint: true });
  if (!metadata.isDirectory()) throw new Error(`${directoryPath}: anchored hosted lock path is not a directory`);
  return metadata;
}
async function assertDirectoryIdentity(directoryPath, expected, noFollow = false) {
  const current = await directoryIdentity(directoryPath, noFollow);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) throw new Error(`${directoryPath}: hosted lock directory identity changed during publication`);
}
async function assertPublishedMarker(markerPath, expected, expectedLinks) { const current = await lstat(markerPath, { bigint: true }); if (!current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino || current.nlink !== expectedLinks) throw new Error('authoritative hosted lock marker topology changed during publication'); }
async function verifyOwnedBytes(filePath, handle, expected, bytes, expectedLinks) {
  if (!handle || !expected) throw new Error(`${path.basename(filePath)} has no owned descriptor`); const descriptor = await handle.stat({ bigint: true });
  if (!descriptor.isFile() || descriptor.dev !== expected.dev || descriptor.ino !== expected.ino || descriptor.size !== BigInt(bytes.byteLength)) throw new Error(`${path.basename(filePath)} staged identity changed`);
  if (expectedLinks !== undefined && descriptor.nlink !== expectedLinks) throw new Error(`${path.basename(filePath)} staged link count changed`);
  const entry = await lstat(filePath, { bigint: true }); if (!entry.isFile() || entry.dev !== expected.dev || entry.ino !== expected.ino) throw new Error(`${path.basename(filePath)} staged path was replaced`);
  if (expectedLinks !== undefined && entry.nlink !== expectedLinks) throw new Error(`${path.basename(filePath)} staged link count changed`);
  const observed = Buffer.alloc(bytes.byteLength);
  let offset = 0;
  while (offset < observed.byteLength) { const { bytesRead } = await handle.read(observed, offset, observed.byteLength - offset, offset); if (bytesRead === 0) throw new Error(`${path.basename(filePath)} staged bytes changed`); offset += bytesRead; }
  if (!observed.equals(bytes)) throw new Error(`${path.basename(filePath)} staged bytes changed`);
  const after = await handle.stat({ bigint: true }); if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== BigInt(bytes.byteLength)) throw new Error(`${path.basename(filePath)} staged identity changed`);
  if (expectedLinks !== undefined && after.nlink !== expectedLinks) throw new Error(`${path.basename(filePath)} staged link count changed`);
}
async function captureCleanup(errors, operation) {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}
function aggregateFailure(primaryError, cleanupErrors) {
  const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, 'hosted lock materialization failed and rollback was incomplete');
}
function transactionRecord(transactionId, transactionName, phase, failure) {
  return {
    schemaVersion: PUBLICATION_SCHEMA,
    transactionId,
    transactionName,
    ownerNonce: transactionId,
    processId: process.pid,
    leaseExpiresAtMs: phase === 'partial' ? Date.now() - 1 : Date.now() + LEASE_MS,
    phase,
    ...(failure ? { failure: failure instanceof Error ? failure.message : String(failure) } : {}),
  };
}
function commitRecord(transactionId, transactionName, pair, transactionIdentity) {
  return {
    schemaVersion: PUBLICATION_SCHEMA,
    transactionId,
    transactionName,
    ownerFilename: OWNER_LOCK_FILENAME,
    stackFilename: STACK_LOCK_FILENAME,
    ownerSha256: pair.ownerSha256,
    stackSha256: pair.stackSha256,
    transactionDevice: transactionIdentity.dev.toString(),
    transactionInode: transactionIdentity.ino.toString(),
  };
}
async function writeTransaction(handle, expected, value) {
  const actual = await handle.stat({ bigint: true });
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isFile()) {
    throw new Error('publication transaction descriptor identity changed');
  }
  const bytes = canonicalJsonBytes(value);
  await handle.truncate(0);
  await handle.write(bytes, 0, bytes.byteLength, 0);
  await handle.sync();
}
async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    throw new Error(`hosted lock transaction directory was not durable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function recoverTransactions(rootAnchor, rootHandle, markerPath, assertRootBinding) {
  if (await exists(markerPath, 2)) return;
  const names = await readdir(rootAnchor);
  for (const name of names) {
    if (!name.startsWith(TRANSACTION_PREFIX) || !name.endsWith('.json')) continue;
    const recordPath = path.join(rootAnchor, name);
    const reservation = await readTransaction(recordPath);
    // A failed truncate/write can leave no JSON, partial JSON, or a valid but
    // incomplete object.  None of those is an active reservation; leave it in
    // place as a forensic tombstone and let this invocation continue.
    if (!reservation || !validTransactionRecord(reservation.record, name.slice(0, -5))) continue;
    const { record } = reservation;
    const transactionRoot = path.join(rootAnchor, record.transactionName || '');
    const stagingState = await transactionState(transactionRoot);
    if (isLiveLease(record)) {
      throw new Error(`hosted lock publication is live for transaction ${record.transactionId}`);
    }
    if (stagingState === 'missing') continue;
    if (stagingState !== 'owned-directory') continue;
    await assertRootBinding?.(); await quarantineOwnedReservation(rootHandle, recordPath, reservation);
  }
}
async function readTransaction(recordPath) {
  let handle;
  try {
    handle = await open(recordPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 64n * 1024n) return undefined;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return undefined;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink) return undefined;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return undefined; }
    if (!value || typeof value !== 'object' || !canonicalJsonBytes(value).equals(bytes)) return undefined;
    const entry = await lstat(recordPath, { bigint: true });
    if (!entry.isFile() || entry.dev !== before.dev || entry.ino !== before.ino || entry.nlink !== before.nlink) return undefined;
    return { record: value, identity: { dev: before.dev, ino: before.ino } };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return undefined;
    throw error;
  } finally { await handle?.close(); }
}
async function quarantineOwnedReservation(rootHandle, recordPath, reservation) {
  // linkat(2) names the still-opened descriptor only if the quarantine entry is absent.
  // Keep the original tombstone; removing it would reintroduce a pathname-unlink race.
  let handle;
  try {
    handle = await open(recordPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const owned = await handle.stat({ bigint: true });
    if (!owned.isFile() || owned.nlink !== 1n || owned.dev !== reservation.identity.dev || owned.ino !== reservation.identity.ino) return;
    const quarantinePath = `${recordPath}.tombstone`;
    try { await linkHeldFileAt(rootHandle, handle, path.basename(quarantinePath)); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally { await handle?.close(); }
}
async function transactionState(transactionRoot) {
  try {
    const handle = await openDirectoryNoFollow(transactionRoot);
    await handle.close();
    return 'owned-directory';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return 'foreign-or-invalid';
  }
}
function isLiveLease(record) {
  if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.processId) ||
      !Number.isSafeInteger(record.leaseExpiresAtMs) || record.leaseExpiresAtMs < Date.now()) return false;
  try { process.kill(record.processId, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
function validTransactionRecord(record, transactionName) {
  return record && typeof record === 'object' && record.schemaVersion === PUBLICATION_SCHEMA &&
    typeof record.transactionId === 'string' && /^[0-9a-f-]{36}$/u.test(record.transactionId) &&
    record.ownerNonce === record.transactionId && record.transactionName === transactionName &&
    transactionName === `${TRANSACTION_PREFIX}${record.transactionId}`;
}
async function exists(filePath, maximumLinks = 1) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.nlink < 1 || metadata.nlink > maximumLinks) throw new Error(`${path.basename(filePath)} must be a regular bounded-link file`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
async function assertNoRootLevelLockEntries(rootAnchor) {
  for (const filename of [LEGACY_HOSTED_OWNER_LOCK_FILENAME, OWNER_LOCK_FILENAME, STACK_LOCK_FILENAME]) {
    try {
      await lstat(path.join(rootAnchor, filename), { bigint: true });
      throw new Error(`${filename} already exists; refusing stale materialization`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const names = await readdir(rootAnchor);
  if (names.some((name) => name.startsWith(`${COMMIT_MARKER}.`))) {
    throw new Error('temporary hosted lock commit marker blocks materialization');
  }
}
async function verifyIndependentEvidence(input, trustedRelease) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') throw new Error('independent evidence is required; refusing declarations without underlying bytes');
  if (!trustedRelease || typeof trustedRelease !== 'object' || typeof trustedRelease.repository !== 'string' || typeof trustedRelease.releaseId !== 'string' || typeof trustedRelease.policyVersion !== 'string' || typeof trustedRelease.adapterId !== 'string' || !trustedRelease.publicKey) throw new Error('trusted release policy is malformed');
  for (const kind of ['product', 'owner', 'openCode']) {
    const identity = evidenceIdentity(input[kind]);
    const facts = evidence[kind];
    if (!facts || typeof facts !== 'object') throw new Error(`independent evidence.${kind} is unavailable`);
    if (facts.role !== kind) throw new Error(`independent evidence.${kind} has the wrong role discriminant`);
    verifySource(identity.source, facts.source, kind);
    expectEvidence(identity.toolchain, facts.toolchain, ['nodeVersion', 'pnpmVersion', 'bunVersion'], `${kind}.toolchain`);
    verifyOptionalDigest(identity.toolchain?.pnpmLockSha256, facts.toolchain?.pnpmLockBytes, `${kind}.pnpmLock`);
    verifyOptionalDigest(identity.toolchain?.bunLockSha256, facts.toolchain?.bunLockBytes, `${kind}.bunLock`);
    expectEvidence(identity.artifact, facts.artifact, ['namespace', 'name'], `${kind}.artifact`);
    expectEvidence(identity.image, facts.image, ['reference'], `${kind}.image`);
    verifyDigest(identity.artifact.sha256, facts.artifact?.bytes, `${kind}.artifact`);
    verifyDigest(identity.artifact.signatureSha256, facts.artifact?.signatureBytes, `${kind}.artifact signature`);
    const artifactSubject = {
      source: identity.source,
      artifact: pick(identity.artifact, ['namespace', 'name', 'sha256']),
    };
    verifySubjectBinding(facts.artifact?.subjectBytes, artifactSubject, `${kind}.artifact`);
    verifyBoundSignature(trustedRelease, 'artifact', facts.artifact?.bytes, facts.artifact?.subjectBytes, facts.artifact?.signatureBytes, artifactSubject, `${kind}.artifact`);
    await verifyBuild(identity.build, facts.build, facts.artifact, kind);
    verifyDigest(identity.image.digest, facts.image?.manifestBytes, `${kind}.image`);
    verifyEnvelopeSubject(facts.image?.manifestBytes, {
      source: identity.source,
      image: pick(identity.image, ['reference']),
    }, `${kind}.image`);
    for (const document of ['sbom', 'attestation']) {
      if (identity[document]) {
        expectEvidence(identity[document], facts[document], ['path'], `${kind}.${document}`);
        verifyDigest(identity[document].sha256, facts[document]?.bytes, `${kind}.${document}`);
        verifyDigest(identity[document].signatureSha256, facts[document]?.signatureBytes, `${kind}.${document} signature`);
        const documentSubject = {
          ...artifactSubject,
          document: pick(identity[document], ['path']),
        };
        verifyEnvelopeSubject(facts[document]?.bytes, documentSubject, `${kind}.${document}`);
        verifyBoundSignature(trustedRelease, document, facts[document]?.bytes, canonicalJsonBytes(documentSubject), facts[document]?.signatureBytes, documentSubject, `${kind}.${document}`);
      }
    }
    if (identity.protocol) {
      expectEvidence(identity.protocol, facts.protocol, ['version'], `${kind}.protocol`);
      verifyDigest(identity.protocol.digest, facts.protocol?.bytes, `${kind}.protocol`);
      const capabilityBytes = requireBytes(facts.protocol?.capabilityBytes, `${kind}.capabilities`);
      if (!canonicalJsonBytes(identity.protocol.capabilities).equals(capabilityBytes)) throw new Error(`${kind}.capabilities evidence does not match declared capabilities`);
      verifyDigest(identity.protocol.capabilityDigest, capabilityBytes, `${kind}.capabilityDigest`);
    }
    if (identity.durableState) {
      expectEvidence(identity.durableState, facts.durableState, ['formatVersion'], `${kind}.durableState`);
      verifyDigest(identity.durableState.compatibilityDigest, facts.durableState?.bytes, `${kind}.durableState`);
    }
    if (kind === 'owner') verifyActualOwner(input.actualOwner, identity.actualOwner, facts.actualOwner, facts.socketIdentity);
  }
  verifyTrustedRelease({ ...input, owner: evidenceIdentity(input.owner) }, trustedRelease);
  expectEvidence(input.deploymentRecipe, evidence, ['path'], 'deployment recipe');
  verifyDigest(input.deploymentRecipe.sha256, evidence.deploymentRecipeBytes, 'deployment recipe');
  verifyDigest(input.contracts.actualOwnerContractV2Sha256, evidence.contracts?.actualOwnerContractV2Bytes, 'actual-owner contract');
  verifyDigest(input.contracts.stackContractSha256, evidence.contracts?.stackContractBytes, 'stack contract');
  verifyDigest(input.contracts.hostedProducerProvenanceV2Sha256, evidence.contracts?.hostedProducerProvenanceV2Bytes, 'hosted producer provenance contract');
}
function evidenceIdentity(identity) {
  if (!identity || typeof identity !== 'object') return identity;
  const subject = { ...identity };
  delete subject.schemaVersion;
  delete subject.lockType;
  delete subject.lockSha256;
  return subject;
}
function verifyTrustedRelease(input, policy) {
  const release = input.evidence?.release;
  if (!policy || typeof policy !== 'object' || !release || typeof release !== 'object') {
    throw new Error('trusted release policy and signed release evidence are required');
  }
  if (typeof policy.repository !== 'string' || typeof policy.releaseId !== 'string' || typeof policy.policyVersion !== 'string' || typeof policy.adapterId !== 'string' || !policy.publicKey) {
    throw new Error('trusted release policy is malformed');
  }
  const payload = requireBytes(release.payloadBytes, 'release provenance payload');
  const signature = requireBytes(release.signatureBytes, 'release provenance signature');
  let statement;
  try {
    statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new Error('release provenance payload is not canonical JSON');
  }
  if (!canonicalJsonBytes(statement).equals(payload) || !statement || typeof statement !== 'object' || Array.isArray(statement)) {
    throw new Error('release provenance payload is not canonical JSON');
  }
  if (!verifySignature(null, Buffer.concat([Buffer.from('hosted-lock-release-v1\0'), payload]), policy.publicKey, signature)) {
    throw new Error('release provenance signature is unsigned, forged, or from a foreign key');
  }
  const expected = {
    repository: policy.repository,
    releaseId: policy.releaseId,
    policyVersion: policy.policyVersion,
    trustAdapterId: policy.adapterId,
    composition: {
      product: input.product,
      owner: input.owner,
      openCode: input.openCode,
      actualOwner: input.actualOwner,
      contracts: input.contracts,
      deploymentRecipe: input.deploymentRecipe,
    },
  };
  if (!sameCanonical(statement, expected)) {
    throw new Error('release provenance is stale or bound to a different release, source, artifact, or build closure');
  }
}
function sameCanonical(left, right) {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
function verifySubjectBinding(subjectBytes, expected, label) {
  const bytes = requireBytes(subjectBytes, `${label} subject`);
  let subject;
  try {
    subject = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} subject is not canonical JSON`);
  }
  if (!canonicalJsonBytes(subject).equals(bytes)) throw new Error(`${label} subject is not canonical JSON`);
  if (!canonicalJsonBytes(subject).equals(canonicalJsonBytes(expected))) {
    throw new Error(`${label} subject does not exactly match declared source and payload`);
  }
}
function verifyEnvelopeSubject(envelopeBytes, expected, label) {
  const bytes = requireBytes(envelopeBytes, label);
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} does not contain a canonical subject envelope`);
  }
  if (!canonicalJsonBytes(envelope).equals(bytes) || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`${label} does not contain a canonical subject envelope`);
  }
  verifySubjectBinding(canonicalJsonBytes(envelope.subject), expected, label);
}
function verifyBoundSignature(policy, role, payloadBytes, subjectBytes, signatureBytes, expectedSubject, label) {
  const payload = requireBytes(payloadBytes, `${label} payload`);
  const subject = requireBytes(subjectBytes, `${label} subject`);
  const signature = requireBytes(signatureBytes, `${label} signature`);
  verifySubjectBinding(subject, expectedSubject, `${label} signature`);
  const signed = Buffer.concat([Buffer.from(`hosted-lock-${role}-v1\0`), subject, payload]);
  if (!verifySignature(null, signed, policy.publicKey, signature)) {
    throw new Error(`${label} signature is unsigned, forged, or from a foreign key`);
  }
}
function collectDeclaredDigests(value) {
  const result = {};
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const current = prefix ? `${prefix}.${key}` : key;
      if ((key.endsWith('Sha256') || key === 'sha256' || key === 'digest' || key.endsWith('Digest')) && typeof child === 'string' && digestPattern.test(child)) result[current] = child;
      walk(child, current);
    }
  };
  walk(value, '');
  return result;
}
function recomputeDeclaredDigests(pair, evidence) {
  const result = {};
  addIdentityDigests(result, 'owner', pair.owner, evidence.owner);
  addIdentityDigests(result, 'stack.product', pair.stack.product, evidence.product);
  addIdentityDigests(result, 'stack.owner', pair.stack.owner, evidence.owner);
  addIdentityDigests(result, 'stack.openCode', pair.stack.openCode, evidence.openCode);
  result['stack.owner.lockSha256'] = sha256Digest(canonicalJsonBytes(pair.owner));
  result['stack.contracts.hostedProducerProvenanceV2Sha256'] = sha256Digest(requireBytes(evidence.contracts?.hostedProducerProvenanceV2Bytes, 'hosted producer provenance contract'));
  result['stack.contracts.actualOwnerContractV2Sha256'] = sha256Digest(requireBytes(evidence.contracts?.actualOwnerContractV2Bytes, 'actual-owner contract'));
  result['stack.contracts.stackContractSha256'] = sha256Digest(requireBytes(evidence.contracts?.stackContractBytes, 'stack contract'));
  result['stack.toolchains.productSha256'] = sha256Digest(canonicalJsonBytes(pair.stack.product.toolchain));
  result['stack.toolchains.ownerSha256'] = sha256Digest(canonicalJsonBytes(pair.owner.toolchain));
  result['stack.toolchains.openCodeSha256'] = sha256Digest(canonicalJsonBytes(pair.stack.openCode.toolchain));
  result['stack.deploymentRecipe.sha256'] = sha256Digest(requireBytes(evidence.deploymentRecipeBytes, 'deployment recipe'));
  return result;
}
function addIdentityDigests(result, prefix, identity, facts) {
  if (identity.toolchain.pnpmLockSha256) result[`${prefix}.toolchain.pnpmLockSha256`] = digestBytes(facts.toolchain.pnpmLockBytes);
  if (identity.toolchain.bunLockSha256) result[`${prefix}.toolchain.bunLockSha256`] = digestBytes(facts.toolchain.bunLockBytes);
  result[`${prefix}.build.entrySha256`] = digestBytes(facts.build.entryBytes);
  result[`${prefix}.build.closureManifestSha256`] = digestBytes(facts.build.closureManifestBytes);
  result[`${prefix}.build.closureSha256`] = digestBytes(facts.build.closureBytes);
  result[`${prefix}.artifact.sha256`] = digestBytes(facts.artifact.bytes);
  result[`${prefix}.artifact.signatureSha256`] = digestBytes(facts.artifact.signatureBytes);
  result[`${prefix}.image.digest`] = digestBytes(facts.image.manifestBytes);
  for (const document of ['sbom', 'attestation']) {
    if (!identity[document]) continue;
    result[`${prefix}.${document}.sha256`] = digestBytes(facts[document].bytes);
    result[`${prefix}.${document}.signatureSha256`] = digestBytes(facts[document].signatureBytes);
  }
  if (identity.protocol) {
    result[`${prefix}.protocol.digest`] = digestBytes(facts.protocol.bytes);
    result[`${prefix}.protocol.capabilityDigest`] = digestBytes(facts.protocol.capabilityBytes);
  }
  if (identity.durableState) result[`${prefix}.durableState.compatibilityDigest`] = digestBytes(facts.durableState.bytes);
}
function digestBytes(bytes) {
  return sha256Digest(requireBytes(bytes, 'declared digest'));
}
function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
function verifySource(identity, facts, kind) {
  if (!facts) throw new Error(`${kind}.source evidence is unavailable`);
  const commitBytes = requireBytes(facts.commitBytes, `${kind}.source.commit`);
  const treeBytes = requireBytes(facts.treeBytes, `${kind}.source.tree`);
  if (gitObjectDigest('commit', commitBytes) !== identity.commit) throw new Error(`${kind}.source.commit does not match underlying bytes`);
  if (gitObjectDigest('tree', treeBytes) !== identity.tree) throw new Error(`${kind}.source.tree does not match underlying bytes`);
  validateGitCommit(commitBytes, identity.tree, kind);
  if (facts.repository !== identity.repository || facts.tag !== identity.tag) throw new Error(`${kind}.source evidence is mixed or stale or malformed`);
  validateGitTree(treeBytes, kind);
}
function validateGitCommit(bytes, expectedTree, kind) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${kind}.source.commit is malformed`);
  }
  const separator = text.indexOf('\n\n');
  if (separator <= 0 || text.includes('\0')) {
    throw new Error(`${kind}.source.commit is malformed`);
  }
  const lines = text.slice(0, separator).split('\n');
  if (lines[0] !== `tree ${expectedTree}`) throw new Error(`${kind}.source.commit is malformed`);
  let phase = 'parents';
  let authorCount = 0;
  let committerCount = 0;
  let previousHeader = '';
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith(' ')) {
      if (!previousHeader || !['gpgsig', 'mergetag'].includes(previousHeader)) throw new Error(`${kind}.source.commit is malformed`);
      continue;
    }
    const space = line.indexOf(' ');
    if (space <= 0 || !/^[a-z][a-z0-9-]*$/u.test(line.slice(0, space))) throw new Error(`${kind}.source.commit is malformed`);
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    previousHeader = key;
    if (key === 'tree') throw new Error(`${kind}.source.commit is malformed`);
    if (key === 'parent') {
      if (phase !== 'parents' || !/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${kind}.source.commit is malformed`);
    } else if (key === 'author') {
      if (phase !== 'parents' || authorCount++ !== 0 || !isCanonicalGitIdentity(value)) throw new Error(`${kind}.source.commit is malformed`);
      phase = 'author';
    } else if (key === 'committer') {
      if (phase !== 'author' || committerCount++ !== 0 || !isCanonicalGitIdentity(value)) throw new Error(`${kind}.source.commit is malformed`);
      phase = 'extras';
    } else if (phase !== 'extras' || value.length === 0) {
      throw new Error(`${kind}.source.commit is malformed`);
    }
  }
  if (authorCount !== 1 || committerCount !== 1) throw new Error(`${kind}.source.commit is malformed`);
}
function isCanonicalGitIdentity(value) {
  const match = /^([^<>\n]+) <([^<>\n]+)> ([0-9]+) ([+-])([0-9]{2})([0-9]{2})$/u.exec(value);
  if (!match) return false;
  const hours = Number(match[5]);
  const minutes = Number(match[6]);
  return hours <= 14 && minutes <= 59 && !(hours === 14 && minutes !== 0);
}
function validateGitTree(bytes, kind) {
  let offset = 0;
  let previous;
  const names = new Set();
  while (offset < bytes.length) {
    const nul = bytes.indexOf(0, offset);
    if (nul < 0) throw new Error(`${kind}.source.tree is malformed`);
    const entry = bytes.subarray(offset, nul);
    const separator = entry.indexOf(0x20);
    const mode = entry.subarray(0, separator).toString('ascii');
    const name = entry.subarray(separator + 1);
    if (separator <= 0 || !['100644', '100755', '120000', '160000', '40000'].includes(mode) || name.length === 0 || name.includes(0x2f) || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) throw new Error(`${kind}.source.tree is malformed`);
    const nameKey = name.toString('hex');
    if (names.has(nameKey) || (previous && compareGitTreeEntries(previous, { name, mode }) >= 0)) throw new Error(`${kind}.source.tree is not canonically ordered`);
    names.add(nameKey);
    previous = { name, mode };
    offset = nul + 1 + 20;
    if (offset > bytes.length) throw new Error(`${kind}.source.tree is malformed`);
  }
  if (offset === 0) throw new Error(`${kind}.source.tree is empty`);
}
function compareGitTreeEntries(left, right) {
  const leftKey = Buffer.concat([left.name, Buffer.from(left.mode === '40000' ? '/' : '\0')]);
  const rightKey = Buffer.concat([right.name, Buffer.from(right.mode === '40000' ? '/' : '\0')]);
  return Buffer.compare(leftKey, rightKey);
}
function expectEvidence(declared, observed, fields, label) {
  if (!observed || typeof observed !== 'object') throw new Error(`${label} evidence is unavailable`);
  for (const field of fields) if (observed[field] !== declared[field]) throw new Error(`${label}.${field} evidence is mixed or stale`);
}
async function verifyBuild(identity, facts, artifactFacts, kind) {
  if (!facts) throw new Error(`${kind}.build evidence is unavailable`);
  if (facts.entryPath !== identity.entryPath || facts.closureManifestPath !== identity.closureManifestPath) throw new Error(`${kind}.build paths do not match declared build`);
  verifyDigest(identity.entrySha256, facts.entryBytes, `${kind}.build entry`);
  verifyDigest(identity.closureManifestSha256, facts.closureManifestBytes, `${kind}.build closure manifest`);
  verifyDigest(identity.closureSha256, facts.closureBytes, `${kind}.build closure`);
  const manifest = parseCanonicalClosure(facts.closureManifestBytes, `${kind}.build closure manifest`);
  const closure = parseCanonicalClosure(facts.closureBytes, `${kind}.build closure`);
  if (manifest.entryPath !== identity.entryPath || closure.entryPath !== manifest.entryPath || manifest.members.length === 0 || !sameCanonical(manifest.members, closure.members)) {
    throw new Error(`${kind}.build closure is incomplete or unrelated to the declared entry`);
  }
  const artifactMembers = await parseGzipTarMembers(artifactFacts?.bytes, `${kind}.artifact`, identity.entryPath);
  const declaredMembers = manifest.members;
  if (!sameCanonical(declaredMembers, artifactMembers.members)) {
    throw new Error(`${kind}.artifact does not contain the complete declared closure`);
  }
  if (!artifactMembers.entryBytes || !artifactMembers.entryBytes.equals(requireBytes(facts.entryBytes, `${kind}.build entry`))) {
    throw new Error(`${kind}.build entry is absent from the declared closure`);
  }
}
function parseCanonicalClosure(bytes, label) {
  let parsed;
  const source = requireBytes(bytes, label);
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)); } catch {
    throw new Error(`${label} is not a canonical closure manifest`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !canonicalJsonBytes(parsed).equals(source)) {
    throw new Error(`${label} is not a canonical closure manifest`);
  }
  if (Object.keys(parsed).sort().join(',') !== 'entryPath,members' || typeof parsed.entryPath !== 'string' || !Array.isArray(parsed.members)) {
    throw new Error(`${label} is not a complete closure manifest`);
  }
  const members = parsed.members.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member) || Object.keys(member).sort().join(',') !== 'path,sha256' || typeof member.path !== 'string' || !safeArchivePath(member.path) || !digestPattern.test(member.sha256)) {
      throw new Error(`${label}.members[${index}] is malformed`);
    }
    return { path: member.path, sha256: member.sha256 };
  });
  if (members.some((member, index) => index && Buffer.compare(Buffer.from(members[index - 1].path), Buffer.from(member.path)) >= 0)) {
    throw new Error(`${label}.members is not canonically ordered`);
  }
  return { entryPath: parsed.entryPath, members };
}
function safeArchivePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
async function parseGzipTarMembers(value, label, entryPath) {
  const compressed = requireBytes(value, label);
  if (compressed.byteLength > MAX_COMPRESSED_ARTIFACT_BYTES) throw new Error(`${label} compressed artifact exceeds limit`);
  const gunzip = createGunzip();
  let carry = Buffer.alloc(0), output = 0, zeroBlocks = 0, ended = false, remaining = 0, padding = 0, current;
  const names = new Set(), members = []; let entryBytes;
  const finish = () => {
    if (!current) return;
    members.push({ path: current.path, sha256: `sha256:${current.hash.digest('hex')}` });
    if (current.path === entryPath) entryBytes = Buffer.concat(current.chunks, current.size);
    current = undefined;
  };
  const consume = (chunk) => {
    output += chunk.byteLength;
    if (output > MAX_DECOMPRESSED_ARTIFACT_BYTES) throw new Error(`${label} decompressed artifact exceeds limit`);
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length) {
      if (ended) { if (carry.some((byte) => byte !== 0)) throw new Error(`${label} tar archive is malformed`); carry = Buffer.alloc(0); continue; }
      if (remaining) {
        const part = carry.subarray(0, Math.min(remaining, carry.length));
        current.hash.update(part); if (current.path === entryPath) current.chunks.push(Buffer.from(part));
        remaining -= part.length; carry = carry.subarray(part.length); if (remaining) continue; finish(); continue;
      }
      if (padding) { const size = Math.min(padding, carry.length); if (carry.subarray(0, size).some((byte) => byte !== 0)) throw new Error(`${label} tar member padding is malformed`); padding -= size; carry = carry.subarray(size); continue; }
      if (carry.length < 512) return;
      const header = carry.subarray(0, 512); carry = carry.subarray(512);
      if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks >= 2) ended = true; continue; }
      if (zeroBlocks) throw new Error(`${label} tar archive is malformed`);
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (parseTarNumber(header.subarray(148, 156), label) !== checksum) throw new Error(`${label} tar header checksum is invalid`);
      if (header[156] !== 0 && header[156] !== 48) throw new Error(`${label} tar archive contains a non-regular member`);
      const name = tarPath(header, label), size = parseTarNumber(header.subarray(124, 136), label);
      if (!safeArchivePath(name) || Buffer.byteLength(name) > MAX_ARTIFACT_PATH_BYTES || size > MAX_ARTIFACT_MEMBER_BYTES || names.has(name) || members.length >= MAX_ARTIFACT_MEMBERS) throw new Error(`${label} tar archive has a duplicate, traversal, or oversized member`);
      names.add(name); current = { path: name, size, hash: createHash('sha256'), chunks: [] }; remaining = size; padding = (512 - (size % 512)) % 512;
      if (!remaining) finish();
    }
  };
  try {
    const input = (async function* () { for (let offset = 0; offset < compressed.length; offset += 64 * 1024) yield compressed.subarray(offset, offset + 64 * 1024); })();
    Readable.from(input).pipe(gunzip);
    for await (const chunk of gunzip) consume(chunk);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not a valid gzip tar archive`);
  }
  if (!ended || remaining || padding || carry.length || !members.length) throw new Error(`${label} tar archive is truncated or malformed`);
  members.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { members, entryBytes };
}
function tarPath(header, label) {
  const field = (start, length) => { const bytes = header.subarray(start, start + length); const nul = bytes.indexOf(0); return bytes.subarray(0, nul < 0 ? length : nul); };
  try { const name = new TextDecoder('utf-8', { fatal: true }).decode(field(0, 100)); const prefix = new TextDecoder('utf-8', { fatal: true }).decode(field(345, 155)); return prefix ? `${prefix}/${name}` : name; } catch { throw new Error(`${label} tar path is malformed`); }
}
function parseTarNumber(field, label) {
  const text = field.toString('ascii').replace(/\0+$/u, '').trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`${label} tar numeric field is malformed`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} tar numeric field is out of range`);
  return value;
}
function verifyActualOwner(inputOwner, declaredOwner, observed, observedSocket) {
  if (!observed || !observedSocket || !actualOwnersEqual(inputOwner, declaredOwner) || !actualOwnersEqual(inputOwner, observed)) throw new Error('actual-owner evidence is unavailable or mismatched');
  if (!actualOwnersEqual(inputOwner.socketIdentity, observedSocket)) throw new Error('owner/socket binding evidence does not match');
}
function verifyDigest(expected, bytes, label) {
  if (!expected || !digestPattern.test(expected)) throw new Error(`${label} declaration is invalid`);
  const actual = sha256Digest(requireBytes(bytes, label));
  if (actual !== expected) throw new Error(`${label} digest does not match underlying bytes`);
}
function verifyOptionalDigest(expected, bytes, label) {
  if (expected === undefined) return;
  verifyDigest(expected, bytes, label);
}
function requireBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${label} evidence is unavailable`);
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function gitObjectDigest(type, bytes) {
  const header = Buffer.from(`${type} ${bytes.byteLength}\0`);
  return createHash('sha1').update(header).update(bytes).digest('hex');
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) { process.stderr.write('materialize-locks.mjs is a library; call materializeHostedLocksAtRoot from a release adapter\n'); process.exitCode = 2; }
