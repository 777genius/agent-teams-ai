#!/usr/bin/env node
// One-shot, descriptor-anchored recovery proof. This is deliberately not a
// general deployment launcher: every writable path is inside one disposable root.
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStoppedStackArchive, restoreStoppedStackArchive, verifyStoppedStackArchive } from '../state-compatibility/stopped-stack-recovery.mjs';
import { descriptorChildPath, descriptorIdentity, descriptorPath, openChildDirectory, openDirectoryBound, openOrCreateChildDirectory, writeExclusiveDurableFileAt } from '../state-compatibility/recovery-descriptor-io.mjs';

import * as shared from './run-phase10-shared.mjs';
const { FORMAT, MANIFEST, DIGEST, MAX_CONTROL_BYTES, MAX_EXECUTABLE_BYTES, EXECUTABLE_HASH_CHUNK_BYTES, MAX_HTTP_BYTES, CONTROL_DEADLINE_MS, LOCKS, fail, ownedProcessWatches, sha256Bytes } = shared;
import { parseLinuxProcStat, isLiveLinuxProcessStat, lifecycleLockHolderArguments, parseLifecycleLockHolderArguments, text, digest, plain, canonical, validateArtifact, validateDeployment, validateLockSet, validateEvidenceAuthority, validateRuntimeMountAdmissionAuthority, validateTrustedRuntimeMountAuthority, receiptEpoch, validateRuntimeMountCurrentOperation, validateRuntimeMountSettlement, runtimeMountReceiptPayload, verifyRuntimeMountAdmissionReceipt, validatePhase10Manifest, components, relativeParts, readHandle, openRelativeDirectory, bindFile, assertFile, bindDirectory, assertDirectory, assertOwnedFile, assertOwnedDirectory, assertPrivateSandbox, assertAbsentAt, deadlineAfter } from './run-phase10-manifest.mjs';
import { assertBefore, childExitCode, assertWriterLease, acquireWriter, releaseWriter, runLifecycleLockHolder, parseLifecycleOwnership, drainLifecycleOwnership, delay, readLinuxProcStat, watchOwnedProcess, groupHasLiveMember, signalOwnedGroup, waitGroup, waitChildExit, endOwnedGroup, createOwnershipBoundary, assertOwnershipBoundary, awaitOwnershipEnrollment, drainOwnershipBoundary, drainAndVerifyOwnershipBoundary, releaseOwnershipBoundary } from './run-phase10-lifecycle.mjs';

export async function boundedJson(url, label, options = {}) {
  const deadline = options.deadline ?? deadlineAfter();
  assertBefore(deadline, `${label}_http`, options.signal);
  const body = await new Promise((resolveBody, rejectBody) => {
    const abort = () => request.destroy(new Error(`phase10_${label}_http_cancelled`));
    const timer = setTimeout(() => request.destroy(new Error(`phase10_${label}_http_deadline_exceeded`)), Math.max(1, deadline - Date.now()));
    const request = httpRequest(url, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(options.body) } : undefined,
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); rejectBody(new Error(`phase10_${label}_http_invalid`)); return; }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.byteLength;
        if (size > MAX_HTTP_BYTES) { request.destroy(new Error(`phase10_${label}_http_too_large`)); return; }
        chunks.push(chunk);
      });
      response.once('end', finish(() => resolveBody(Buffer.concat(chunks))));
      response.once('error', finish(rejectBody));
    });
    const finish = (callback) => (value) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); callback(value); };
    request.once('error', finish(rejectBody));
    request.once('close', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); });
    options.signal?.addEventListener('abort', abort, { once: true }); request.end(options.body);
  });
  try { return JSON.parse(body.toString('utf8')); } catch { fail(`${label}_http_json_invalid`); }
}
export function combineErrors(primary, cleanupErrors) {
  if (cleanupErrors.length === 0) return primary;
  return new AggregateError([primary, ...cleanupErrors], 'phase10_cleanup_failed');
}

export async function prepareExecutionBinding({ runtime, state, deployment, artifact, manifest, locks, label }) {
  const name = `${label}.execution-binding.json`;
  await assertAbsentAt(runtime.handle, name, `${label}_execution_binding`);
  const header = await bindFile(state.handle, ['data', 'hosted-state-header.v1.json'], `${label}_state_header`);
  try {
    const stateIdentity = JSON.parse(header.sealed.body.toString('utf8'));
    if (stateIdentity?.format !== 'hosted-state-header/v1' || stateIdentity.deploymentId !== deployment.deploymentId) {
      fail(`${label}_state_identity_invalid`);
    }
    for (const lock of locks) await assertFile(lock.binding);
    const body = Buffer.from(`${canonical({
      format: 'phase10-executed-deployment-binding/v1',
      deployment: {
        deploymentId: deployment.deploymentId,
        imageDigest: deployment.image.digest,
        controllerArtifactSha256: artifact.sealed.sha256,
        manifestSha256: manifest.sealed.sha256,
      },
      locks: locks.map((lock) => ({ name: lock.name, sha256: lock.binding.sealed.sha256, contentsSha256: sha256Bytes(lock.binding.sealed.body) })),
      state: { deploymentId: stateIdentity.deploymentId, sha256: header.sealed.sha256 },
    })}\n`);
    await writeExclusiveDurableFileAt(runtime.handle, name, body, 0o400);
    const binding = await bindFile(runtime.handle, [name], `${label}_execution_binding`, sha256Bytes(body));
    return { ...binding, name, execution: JSON.parse(body.toString('utf8')) };
  } finally { await header.handle.close(); }
}

export async function createRuntimeStateProof(state, deployment, label) {
  // This record is deliberately not placed in an environment variable or the
  // execution binding.  A controller can report its unpredictable value only
  // by opening the persisted SQLite database through its inherited state-root
  // production path.  It also binds that read to the durable state header.
  const data = await openChildDirectory(state.handle, 'data');
  let storage;
  let databaseHandle;
  let database;
  try {
    storage = await openChildDirectory(data, 'storage');
    databaseHandle = await open(
      descriptorChildPath(storage, 'app.db'),
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = await databaseHandle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label}_state_database_invalid`);
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(`/proc/self/fd/${databaseHandle.fd}`);
    database.exec(
      'CREATE TABLE IF NOT EXISTS phase10_runtime_state_proof (' +
      'proof_id TEXT PRIMARY KEY, sentinel TEXT NOT NULL, deployment_id TEXT NOT NULL)'
    );
    const proof = Object.freeze({
      proofId: `proof_${randomUUID()}`,
      sentinel: randomUUID(),
      deploymentId: deployment.deploymentId,
    });
    database
      .prepare('INSERT INTO phase10_runtime_state_proof(proof_id, sentinel, deployment_id) VALUES (?, ?, ?)')
      .run(proof.proofId, proof.sentinel, proof.deploymentId);
    database.close(); database = undefined;
    const after = await databaseHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) fail(`${label}_state_database_replaced`);
    return proof;
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storage?.close();
    await data.close();
  }
}

export async function assertPersistedRuntimeStateProof(state, proof, label) {
  // The proof is created once before the crash. Each later lifecycle boundary
  // reads this exact row from its descriptor-bound database; a fresh row from
  // a restarted controller cannot become acceptance evidence.
  const data = await openChildDirectory(state.handle, 'data');
  let storage;
  let databaseHandle;
  let database;
  try {
    storage = await openChildDirectory(data, 'storage');
    databaseHandle = await open(
      descriptorChildPath(storage, 'app.db'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = await databaseHandle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label}_state_database_invalid`);
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(`/proc/self/fd/${databaseHandle.fd}`, { readOnly: true });
    let observed;
    try {
      observed = database.prepare(
        'SELECT proof_id AS proofId, sentinel, deployment_id AS deploymentId FROM phase10_runtime_state_proof WHERE proof_id = ?'
      ).get(proof.proofId);
    } catch {
      fail(`${label}_state_proof_query_failed`);
    }
    if (observed?.proofId !== proof.proofId || observed.sentinel !== proof.sentinel || observed.deploymentId !== proof.deploymentId) {
      fail(`${label}_state_proof_missing`);
    }
    database.close(); database = undefined;
    const after = await databaseHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) fail(`${label}_state_database_replaced`);
    return Object.freeze({ ...proof, databaseIdentity: `${before.dev}:${before.ino}` });
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storage?.close();
    await data.close();
  }
}

export function scalarString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function healthAdmission(health, restoreAdmission, label) {
  if (health.restoreAdmission === undefined) return undefined;
  const admission = health.restoreAdmission;
  if (!exactKeys(admission, [
    'status', 'deploymentId', 'sourceManifestHash', 'restoreGeneration',
    'browserSessionsRevoked', 'runtimeAuthorityRotated', 'mountBindingsRotated',
    'pendingAdmission', 'startupAdmission',
  ]) ||
    admission.status !== 'admitted' ||
    admission.deploymentId !== restoreAdmission?.deploymentId ||
    admission.sourceManifestHash !== restoreAdmission?.sourceManifestHash ||
    admission.restoreGeneration !== restoreAdmission?.restoreGeneration ||
    admission.browserSessionsRevoked !== true ||
    admission.runtimeAuthorityRotated !== true ||
    admission.mountBindingsRotated !== true ||
    !exactKeys(admission.pendingAdmission, ['diagnostic']) ||
    admission.pendingAdmission.diagnostic !== 'offline_restore_rotation_pending' ||
    !exactKeys(admission.startupAdmission, ['status']) ||
    admission.startupAdmission.status !== 'read_write'
  ) fail(`${label}_restore_admission_invalid`);
  return admission;
}

export function validateHealth(health, deployment, writer, expectedStateProof, restoreAdmission, label) {
  const allowed = ['deploymentId', 'status', 'leaseDescriptorIdentity', 'runtimeStateProof'];
  if (health?.restoreAdmission !== undefined) allowed.push('restoreAdmission');
  // Health is an evidence boundary. Reject, rather than silently strip,
  // controller-supplied diagnostics, tokens, arrays, or nested objects.
  if (!exactKeys(health, allowed) ||
    health.deploymentId !== deployment.deploymentId ||
    health.status !== 'healthy' ||
    health.leaseDescriptorIdentity !== `${writer.identity.dev}:${writer.identity.ino}` ||
    !exactKeys(health.runtimeStateProof, ['proofId', 'sentinel', 'deploymentId', 'databaseIdentity']) ||
    !scalarString(health.runtimeStateProof.proofId) ||
    !scalarString(health.runtimeStateProof.sentinel) ||
    !scalarString(health.runtimeStateProof.deploymentId) ||
    !scalarString(health.runtimeStateProof.databaseIdentity) ||
    health.runtimeStateProof.proofId !== expectedStateProof.proofId ||
    health.runtimeStateProof.sentinel !== expectedStateProof.sentinel ||
    health.runtimeStateProof.deploymentId !== expectedStateProof.deploymentId ||
    health.runtimeStateProof.databaseIdentity !== expectedStateProof.databaseIdentity
  ) fail(`${label}_health_invalid`);
  const admission = healthAdmission(health, restoreAdmission, label);
  if (restoreAdmission && admission === undefined) fail(`${label}_restore_admission_invalid`);
  if (!restoreAdmission && admission !== undefined) fail(`${label}_restore_admission_invalid`);
  return admission;
}

export function evidenceHealth(health) {
  // validateHealth has already applied the closed scalar schema. Preserve only
  // the proven fields and omit restore admission entirely when it was absent.
  const proof = health.runtimeStateProof;
  const result = {
    deploymentId: health.deploymentId,
    status: health.status,
    leaseDescriptorIdentity: health.leaseDescriptorIdentity,
    runtimeStateProof: {
      proofId: proof.proofId,
      deploymentId: proof.deploymentId,
      databaseIdentity: proof.databaseIdentity,
    },
  };
  if (health.restoreAdmission !== undefined) {
    result.restoreAdmission = {
      status: health.restoreAdmission.status,
      deploymentId: health.restoreAdmission.deploymentId,
      sourceManifestHash: health.restoreAdmission.sourceManifestHash,
      restoreGeneration: health.restoreAdmission.restoreGeneration,
      browserSessionsRevoked: health.restoreAdmission.browserSessionsRevoked,
      runtimeAuthorityRotated: health.restoreAdmission.runtimeAuthorityRotated,
      mountBindingsRotated: health.restoreAdmission.mountBindingsRotated,
      pendingAdmission: { diagnostic: health.restoreAdmission.pendingAdmission.diagnostic },
      startupAdmission: { status: health.restoreAdmission.startupAdmission.status },
    };
  }
  return Object.freeze(result);
}

export function sameExecutableState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function hashExecutableDescriptor(handle, label) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    fail(`${label}_invalid`);
  }
  if ((before.mode & 0o111n) === 0n) fail(`${label}_not_executable`);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(EXECUTABLE_HASH_CHUNK_BYTES);
  let offset = 0;
  const size = Number(before.size);
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
    if (bytesRead === 0) fail(`${label}_truncated`);
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!sameExecutableState(before, after)) fail(`${label}_changed`);
  return { stat: before, sha256: `sha256:${hash.digest('hex')}` };
}

export async function bindControllerExecutables() {
  // Do not resolve an executable through PATH after the acceptance inputs have
  // been sealed. The shell is only a short enrollment gate; Node loads the
  // sealed controller. Keeping both descriptors open binds their inodes until
  // the launcher has exec'd them.
  const bindExecutable = async (path, label, allowSymlink = false) => {
    const linkBefore = await lstat(path, { bigint: true });
    const target = allowSymlink ? await realpath(path) : path;
    // `realpath` handles the distro-provided /bin -> /usr/bin and sh -> dash
    // links.  Bind the final target with O_NOFOLLOW, then recheck the original
    // link and resolution so a changed link cannot select different bytes.
    if (!isAbsolute(target)) fail(`${label}_target_invalid`);
    const targetStat = await lstat(target, { bigint: true });
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) fail(`${label}_target_invalid`);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const sealed = await hashExecutableDescriptor(handle, label);
      const linkAfter = await lstat(path, { bigint: true });
      if (!sameExecutableState(linkBefore, linkAfter) || (allowSymlink && await realpath(path) !== target)) {
        fail(`${label}_link_changed`);
      }
      return { handle, sealed, label, target };
    } catch (error) { await handle.close(); throw error; }
  };
  const shell = await bindExecutable('/bin/sh', 'controller_enrollment_launcher', true);
  try {
    const node = await bindExecutable(process.execPath, 'controller_node');
    return { shell, node };
  } catch (error) { await shell.handle.close(); throw error; }
}

export function cleanControllerEnvironment(deployment, readyName, runtimeMountAuthority) {
  // This is intentionally a whitelist, not a filtered copy of process.env.
  // It excludes NODE_OPTIONS, NODE_PATH, preload/loader inputs, LD_PRELOAD,
  // and every inherited module-resolution setting. PATH is unnecessary: both
  // executable dependencies are bound descriptors.
  return Object.freeze({
    PHASE10_DEPLOYMENT_ID: deployment.deploymentId,
    PHASE10_READY_FILE: `/proc/self/fd/5/${readyName}`,
    PHASE10_STATE_ROOT: '/proc/self/fd/4',
    PHASE10_INSTANCE_LOCK_FD: '6',
    PHASE10_EXECUTION_BINDING_FD: '7',
    PHASE10_CGROUP_PROCS: '/proc/self/fd/8',
    PHASE10_NODE_FD: '10',
  });
}
