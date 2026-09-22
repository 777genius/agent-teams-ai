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
import { boundedJson, combineErrors, prepareExecutionBinding, createRuntimeStateProof, assertPersistedRuntimeStateProof, scalarString, exactKeys, healthAdmission, validateHealth, evidenceHealth, sameExecutableState, hashExecutableDescriptor, bindControllerExecutables, cleanControllerEnvironment } from './run-phase10-runtime.mjs';

export async function startDeployment({ artifact, deployment, runtime, state, writer, label, executionBinding, signal, restoreAdmission, runtimeMountAuthority, restoreArchiveAuthority, stateProof }) {
  const readyName = `${label}.ready.json`;
  const sealedName = `${label}.controller.sealed`;
  await assertFile(artifact);
  await assertAbsentAt(runtime.handle, readyName, `${label}_ready`);
  await assertAbsentAt(runtime.handle, sealedName, `${label}_sealed`);
  await writeExclusiveDurableFileAt(runtime.handle, sealedName, artifact.sealed.body, 0o400);
  const sealed = await bindFile(runtime.handle, [sealedName], `${label}_sealed`, artifact.sealed.sha256);
  let child;
  let executables;
  let enrollmentHandle;
  try {
    // The controller runs from an immutable, private copy.  The two inherited
    // descriptors let it read only the copy and the held state tree, rather
    // than re-resolving attacker-controlled source pathnames.
    await assertFile(artifact); await assertDirectory(state); await assertWriterLease(writer); await assertOwnershipBoundary(runtime.boundary);
    const expectedStateProof = await assertPersistedRuntimeStateProof(state, stateProof, label);
    // This is runtime-owned evidence of the bytes Node will execute, not a
    // controller-provided echo of an environment value.
    const executedArtifact = await readHandle(sealed.handle, `${label}_sealed`);
    if (executedArtifact.sha256 !== artifact.sealed.sha256) fail(`${label}_sealed_digest_mismatch`);
    executables = await bindControllerExecutables();
    enrollmentHandle = await open(
      runtime.boundary.procs,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const deadline = deadlineAfter();
    // The launcher cannot exec the controller until the parent has observed
    // its cgroup membership. Enrollment failure therefore cannot race with
    // controller execution.
    child = spawn(`/proc/self/fd/${executables.shell.handle.fd}`, [
      '-c',
      'printf "%s\\n" "$$" > "$PHASE10_CGROUP_PROCS" || exit 125; IFS= read -r phase10_ack || exit 126; [ "$phase10_ack" = proceed ] || exit 127; exec "/proc/self/fd/$PHASE10_NODE_FD" /proc/self/fd/3 "$@"',
      'phase10-controller',
      ...(deployment.controllerArtifact.argv ?? []),
    ], {
      detached: true,
      // FDs 11 and 12 are a sealed restore plan and the independently held
      // archive scope. They are intentionally never encoded in the controller
      // environment or its stdout protocol.
      stdio: ['pipe', 'ignore', 'ignore', sealed.handle.fd, state.handle.fd, runtime.handle.fd, writer.anchor.handle.fd, executionBinding.handle.fd, enrollmentHandle.fd, 'ignore', executables.node.handle.fd, restoreArchiveAuthority?.plan.handle.fd ?? 'ignore', restoreArchiveAuthority?.archive.handle.fd ?? 'ignore'],
      env: cleanControllerEnvironment(deployment, readyName, runtimeMountAuthority),
    });
    // A successful spawn receives its PID synchronously. Do not await the
    // `spawn` event after an asynchronous descriptor close: a very fast shell
    // can emit it in that gap and leave this lifecycle waiting forever.
    if (!child.pid) fail(`${label}_spawn_failed`);
    await watchOwnedProcess(child, label);
    await enrollmentHandle.close(); enrollmentHandle = undefined;
    // Register synchronously, before waiting for spawn, readiness, HTTP, or JSON.
    runtime.controllers.set(child.pid, child);
    await awaitOwnershipEnrollment(runtime.boundary, child.pid, deadline); await assertWriterLease(writer);
    child.stdin.end('proceed\n');
    let readiness;
    while (Date.now() < deadline) {
      assertBefore(deadline, `${label}_ready`, signal); await assertWriterLease(writer); await assertOwnershipBoundary(runtime.boundary, child.pid);
      try { const file = await bindFile(runtime.handle, [readyName], `${label}_ready`); try { readiness = JSON.parse(file.sealed.body.toString('utf8')); } finally { await file.handle.close(); } if (readiness?.deploymentId === deployment.deploymentId && Number.isSafeInteger(readiness.port) && readiness.port > 0) break; } catch (error) { if (String(error?.message ?? error).includes('_cancelled')) throw error; }
      await delay(20);
    }
    if (!readiness) fail(`${label}_not_ready`);
    let health = await boundedJson(`http://127.0.0.1:${readiness.port}/health`, `${label}_health`, { deadline, signal });
    validateHealth(health, deployment, writer, expectedStateProof, undefined, label);
    if (restoreAdmission) {
      if (typeof runtimeMountAuthority?.rotateAndAdmit !== 'function') fail(`${label}_runtime_mount_admission_authority_unavailable`);
      // Observe the authority's operation cursor first. Receipt fields are
      // fresh only when they equal this independently owned current operation,
      // never merely when their signature validates for the restore scope.
      const currentOperation = validateRuntimeMountCurrentOperation(
        await runtimeMountAuthority.readCurrentOperation(restoreAdmission),
        restoreAdmission,
        runtimeMountAuthority.definition,
        label
      );
      const runtimeMountAdmission = verifyRuntimeMountAdmissionReceipt(
        await runtimeMountAuthority.rotateAndAdmit(restoreAdmission, currentOperation),
        restoreAdmission,
        runtimeMountAuthority.definition,
        label
      );
      if (runtimeMountAdmission.operationId !== currentOperation.operationId ||
        runtimeMountAdmission.admissionEpoch !== currentOperation.admissionEpoch) {
        fail(`${label}_runtime_mount_receipt_not_current`);
      }
      // Settlement is an atomic operation in the external authority: it both
      // rejects duplicate operation IDs / rollback epochs and advances the
      // durable replay high-water ledger before a controller sees the receipt.
      const runtimeMountSettlement = validateRuntimeMountSettlement(
        await runtimeMountAuthority.settleReceipt(runtimeMountAdmission, currentOperation),
        runtimeMountAdmission,
        currentOperation,
        runtimeMountAuthority.definition,
        label
      );
      const admission = await boundedJson(
        `http://127.0.0.1:${readiness.port}/restore-admission`,
        `${label}_restore_admission`,
        { deadline, signal, method: 'POST', body: canonical({ rotation: restoreAdmission, runtimeMountAdmission, runtimeMountSettlement }) }
      );
      if (
        admission?.status !== 'admitted' || admission.deploymentId !== deployment.deploymentId ||
        admission.sourceManifestHash !== restoreAdmission.sourceManifestHash ||
        admission.restoreGeneration !== restoreAdmission.restoreGeneration ||
        admission.browserSessionsRevoked !== true || admission.runtimeAuthorityRotated !== true ||
        admission.mountBindingsRotated !== true ||
        admission.pendingAdmission?.diagnostic !== 'offline_restore_rotation_pending' ||
        admission.startupAdmission?.status !== 'read_write'
      ) fail(`${label}_restore_admission_invalid`);
      // The controller's response is only a transport acknowledgement.  Read
      // the durable effects ourselves through the held restored-state
      // descriptor.  This rejects a fixture (or a controller) that merely
      // deletes markers and returns true, and makes database query errors
      // admission failures rather than a permissive fallback.
      await verifyProductionRestoreAdmission(
        state,
        deployment,
        restoreAdmission,
        runtimeMountAuthority.definition,
        runtimeMountSettlement,
        label
      );
      health = await boundedJson(`http://127.0.0.1:${readiness.port}/health`, `${label}_health`, { deadline, signal });
      // This is a second top-level health response, not merely an admission
      // fragment: validate its complete closed schema again for rollback.
      validateHealth(health, deployment, writer, expectedStateProof, restoreAdmission, label);
    }
    // Re-read after controller startup/admission. A health response can prove
    // what the controller saw at request time; this descriptor-bound read
    // proves that the pre-crash record remains in the authoritative database.
    await assertPersistedRuntimeStateProof(state, stateProof, label);
    await assertWriterLease(writer); await assertOwnershipBoundary(runtime.boundary, child.pid);
    const stop = async (signal = 'SIGTERM') => {
      const result = await endOwnedGroup(child, signal);
      await drainOwnershipBoundary(runtime.boundary);
      runtime.controllers.delete(child.pid);
      await unlink(descriptorChildPath(runtime.handle, readyName)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      await unlink(descriptorChildPath(runtime.handle, sealedName)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      await unlink(descriptorChildPath(runtime.handle, executionBinding.name)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      return result;
    };
    return {
      child, readiness, health: evidenceHealth(health),
      executed: Object.freeze({
        artifactSha256: executedArtifact.sha256,
        imageDigest: deployment.image.digest,
        stateProof: Object.freeze({
          proofId: expectedStateProof.proofId,
          deploymentId: expectedStateProof.deploymentId,
          databaseIdentity: expectedStateProof.databaseIdentity,
        }),
      }),
      stop, crash: () => stop('SIGKILL'),
    };
  } catch (error) {
    const cleanupErrors = [];
    if (child) {
      try { await endOwnedGroup(child, 'SIGKILL'); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      runtime.controllers.delete(child.pid);
    }
    await sealed.handle.close();
    await enrollmentHandle?.close();
    await executables?.shell.handle.close(); await executables?.node.handle.close();
    await unlink(descriptorChildPath(runtime.handle, readyName)).catch((cleanupError) => { if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError); });
    await unlink(descriptorChildPath(runtime.handle, sealedName)).catch((cleanupError) => { if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError); });
    await unlink(descriptorChildPath(runtime.handle, executionBinding.name)).catch((cleanupError) => { if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError); });
    throw combineErrors(error, cleanupErrors);
  } finally {
    await sealed.handle.close().catch(() => {});
    await enrollmentHandle?.close().catch(() => {});
    await executables?.shell.handle.close().catch(() => {});
    await executables?.node.handle.close().catch(() => {});
  }
}

export async function verifyProductionRestoreAdmission(state, deployment, rotation, runtimeMountAuthority, settlement, label) {
  const data = await openChildDirectory(state.handle, 'data');
  let storage;
  let secrets;
  let databaseHandle;
  let database;
  try {
    const header = await bindFile(data, ['hosted-state-header.v1.json'], `${label}_restore_admission_header`);
    let keyring;
    let identity;
    let binding;
    try {
      secrets = await openChildDirectory(data, 'hosted-auth-secrets');
      keyring = await bindFile(secrets, ['personal-keyring.json'], `${label}_restore_admission_keyring`);
      identity = await bindFile(secrets, ['identity.key'], `${label}_restore_admission_identity`);
      try {
        binding = await bindFile(
          data,
          [`hosted-restored-runtime-mount-binding.v1.${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}.json`],
          `${label}_restore_admission_runtime_mount_binding`
        );
      } catch {
        fail(`${label}_restore_admission_invalid`);
      }
      let persistedBinding;
      try { persistedBinding = JSON.parse(binding.sealed.body.toString('utf8')); } catch { fail(`${label}_restore_admission_runtime_mount_binding_invalid`); }
      const hash = (body) => createHash('sha256').update(body).digest('hex');
      if (
        persistedBinding?.format !== 'hosted-restored-runtime-mount-binding/v1' ||
        persistedBinding.schemaVersion !== 1 ||
        persistedBinding.deploymentId !== deployment.deploymentId ||
        persistedBinding.sourceManifestHash !== rotation.sourceManifestHash ||
        persistedBinding.restoreGeneration !== rotation.restoreGeneration ||
        persistedBinding.bootId !== rotation.bootId ||
        persistedBinding.eventEpoch !== rotation.eventEpoch ||
        persistedBinding.stateHeaderSha256 !== hash(header.sealed.body) ||
        persistedBinding.runtimeAuthorityKeyringSha256 !== hash(keyring.sealed.body) ||
        persistedBinding.runtimeIdentitySha256 !== hash(identity.sealed.body) ||
        persistedBinding.runtimeMountAuthorityId !== runtimeMountAuthority.authorityId ||
        typeof persistedBinding.runtimeMountOperationId !== 'string' ||
        typeof persistedBinding.runtimeMountAdmissionEpoch !== 'string' ||
        persistedBinding.runtimeMountAdmissionReceiptSha256 !== settlement.receiptSha256.slice('sha256:'.length) ||
        persistedBinding.runtimeMountCurrentOperationId !== persistedBinding.runtimeMountOperationId ||
        persistedBinding.runtimeMountCurrentAdmissionEpoch !== persistedBinding.runtimeMountAdmissionEpoch ||
        persistedBinding.runtimeMountReplayHighWaterAdmissionEpoch !== persistedBinding.runtimeMountAdmissionEpoch
      ) fail(`${label}_restore_admission_runtime_mount_binding_invalid`);
      const receipt = verifyRuntimeMountAdmissionReceipt(
        persistedBinding.runtimeMountAdmissionReceipt,
        rotation,
        runtimeMountAuthority,
        label
      );
      if (receipt.operationId !== persistedBinding.runtimeMountOperationId || receipt.admissionEpoch !== persistedBinding.runtimeMountAdmissionEpoch) {
        fail(`${label}_restore_admission_runtime_mount_binding_invalid`);
      }
      if (settlement.operationId !== receipt.operationId || settlement.admissionEpoch !== receipt.admissionEpoch ||
        settlement.receiptSha256 !== sha256Bytes(Buffer.from(canonical(receipt)))) {
        fail(`${label}_restore_admission_runtime_mount_binding_invalid`);
      }
    } finally {
      await binding?.handle.close();
      await identity?.handle.close();
      await keyring?.handle.close();
      await secrets?.close();
      secrets = undefined;
      await header.handle.close();
    }
    storage = await openChildDirectory(data, 'storage');
    databaseHandle = await open(
      descriptorChildPath(storage, 'app.db'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = await databaseHandle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label}_restore_admission_database_invalid`);
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(`/proc/self/fd/${databaseHandle.fd}`, { readOnly: true });
    const scope = `${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}`;
    let durableRotation;
    let activeSessions;
    let authority;
    try {
      durableRotation = database.prepare(
        'SELECT rotation_json AS rotationJson FROM phase10_restore_rotation WHERE rotation_scope = ?'
      ).get(scope);
      activeSessions = database.prepare(
        "SELECT count(*) AS count FROM operator_sessions WHERE status = 'active'"
      ).get();
      authority = database.prepare(
        'SELECT state_json AS stateJson FROM hosted_access_authority WHERE singleton = 1'
      ).get();
    } catch {
      fail(`${label}_restore_admission_database_query_failed`);
    }
    let recordedRotation;
    let authorityState;
    try {
      recordedRotation = JSON.parse(durableRotation?.rotationJson ?? '').rotation;
      authorityState = JSON.parse(authority?.stateJson ?? '');
    } catch {
      fail(`${label}_restore_admission_database_invalid`);
    }
    if (
      canonical(recordedRotation) !== canonical(rotation) ||
      Number(activeSessions?.count) !== 0 ||
      authorityState?.binding?.deploymentId !== deployment.deploymentId ||
      authorityState.binding?.restoreGeneration !== rotation.restoreGeneration ||
      !Array.isArray(authorityState.sessions) || authorityState.sessions.length !== 0 ||
      !Array.isArray(authorityState.deviceFamilies) || authorityState.deviceFamilies.length !== 0 ||
      !Array.isArray(authorityState.deviceGrants) || authorityState.deviceGrants.length !== 0 ||
      authorityState.expectedKeyringId === 'old-keyring'
    ) fail(`${label}_restore_admission_effects_invalid`);
    database.close(); database = undefined;
    const after = await databaseHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail(`${label}_restore_admission_database_replaced`);
    }
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storage?.close();
    await secrets?.close();
    await data.close();
  }
}

export async function assertRestoredStateAdmitted(state, deployment, rotation) {
  const data = await openChildDirectory(state.handle, 'data');
  const pending = `hosted-restore-rotation.v1.${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}.json`;
  const completed = `hosted-restore-rotation.completed.v1.${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}.json`;
  try {
    await assertAbsentAt(data, pending, 'rollback_restore_pending');
    await assertAbsentAt(data, 'hosted-restore-journal.v1.json', 'rollback_restore_journal');
    const completion = await bindFile(data, [completed], 'rollback_restore_completion');
    try {
      const observed = JSON.parse(completion.sealed.body.toString('utf8'));
      if (
        observed?.deploymentId !== deployment.deploymentId ||
        observed.sourceManifestHash !== rotation.sourceManifestHash ||
        observed.restoreGeneration !== rotation.restoreGeneration ||
        observed.bootId !== rotation.bootId || observed.eventEpoch !== rotation.eventEpoch
      ) fail('rollback_restore_completion_invalid');
    } finally { await completion.handle.close(); }
  } finally { await data.close(); }
}
export async function atomicRollbackSelection(runtime, preceding, deployment) {
  const staging = 'rollback-selection.staging.json'; const selected = 'rollback-selection.json';
  await assertAbsentAt(runtime.handle, staging, 'rollback_staging'); await assertAbsentAt(runtime.handle, selected, 'rollback_selection');
  await writeExclusiveDurableFileAt(runtime.handle, staging, preceding.sealed.body, 0o400);
  await rename(descriptorChildPath(runtime.handle, staging), descriptorChildPath(runtime.handle, selected)); await runtime.handle.sync();
  const bound = await bindFile(runtime.handle, [selected], 'rollback_selection', preceding.sealed.sha256);
  try { return { selectedArtifact: selected, selectedArtifactSha256: bound.sealed.sha256, selectedDeploymentId: deployment.deploymentId }; }
  finally { await bound.handle.close(); }
}
export async function consumeRollbackSelection(runtime, sandbox, expectedDeployment) {
  const selected = await bindFile(runtime.handle, ['rollback-selection.json'], 'rollback_selection');
  try {
    const deployment = validateDeployment(JSON.parse(selected.sealed.body), 'rollback_selected');
    if (canonical(deployment) !== canonical(expectedDeployment)) fail('rollback_selection_not_consumed');
    const artifact = await bindFile(sandbox, relativeParts(deployment.controllerArtifact.path, 'rollback_selected_artifact_path'), 'rollback_selected_artifact', deployment.controllerArtifact.sha256);
    return { deployment, artifact };
  } finally { await selected.handle.close(); }
}
export async function publishTerminalEvidence(evidence, outcome, authority, onStage) {
  const body = Buffer.from(`${canonical(outcome)}\n`); const generation = `generation-${randomUUID()}`; const staging = `.${generation}.staging`; const marker = 'phase10-commit.json'; const receiptName = 'phase10-authority-receipt.json';
  await assertAbsentAt(evidence.handle, marker, 'evidence_commit'); await assertAbsentAt(evidence.handle, receiptName, 'evidence_authority_receipt'); await assertAbsentAt(evidence.handle, staging, 'evidence_staging');
  try {
    const stage = await openOrCreateChildDirectory(evidence.handle, staging);
    try {
      const hash = sha256Bytes(body);
      await writeExclusiveDurableFileAt(stage, 'phase10-evidence.json', body, 0o400);
      await writeExclusiveDurableFileAt(stage, 'phase10-evidence.sha256', `${hash}\n`, 0o400);
      await stage.sync();
      await rename(descriptorChildPath(evidence.handle, staging), descriptorChildPath(evidence.handle, generation));
      await evidence.handle.sync();
      await onStage?.('generation_durable');
      // The external authority is deliberately outside this writable sandbox.
      // A local mode-0400 sidecar can be rewritten by the same owner and is not
      // evidence authority.  Do not publish a commit marker until the authority
      // returns a receipt binding this exact immutable generation and digest.
      if (typeof authority?.pin !== 'function') fail('evidence_authority_unavailable');
      const receipt = await authority.pin({ generation, sha256: hash, evidenceDirectory: evidence.absolutePath });
      const authorityDefinition = authority.definition;
      if (!plain(receipt) || receipt.authorityId !== authorityDefinition.authorityId || receipt.generation !== generation || receipt.sha256 !== hash || typeof receipt.receiptId !== 'string' || typeof receipt.signature !== 'string') fail('evidence_authority_receipt_invalid');
      const receiptPayload = Buffer.from(canonical({ authorityId: receipt.authorityId, generation: receipt.generation, receiptId: receipt.receiptId, sha256: receipt.sha256 }));
      if (!verifySignature(null, receiptPayload, createPublicKey(authorityDefinition.publicKeyPem), Buffer.from(receipt.signature, 'base64'))) fail('evidence_authority_receipt_invalid');
      await writeExclusiveDurableFileAt(evidence.handle, receiptName, `${canonical(receipt)}\n`, 0o400);
      // A terminal marker is publication, not merely a durable file write.
      // Sync a private temp inode, atomically rename it into the marker name,
      // then sync the directory so a crash cannot expose a torn success.
      const markerStaging = `.${marker}.${generation}.staging`;
      await assertAbsentAt(evidence.handle, markerStaging, 'evidence_commit_staging');
      await writeExclusiveDurableFileAt(
        evidence.handle,
        markerStaging,
        `${canonical({ format: 'phase10-evidence-commit/v1', generation, sha256: hash })}\n`,
        0o400
      );
      await rename(descriptorChildPath(evidence.handle, markerStaging), descriptorChildPath(evidence.handle, marker));
      await evidence.handle.sync();
      return { path: join(evidence.absolutePath, generation, 'phase10-evidence.json'), sha256: hash, generation, marker: join(evidence.absolutePath, marker), authorityReceipt: join(evidence.absolutePath, receiptName) };
    } finally { await stage.close(); }
  } catch (error) { await unlink(descriptorChildPath(evidence.handle, staging)).catch(() => {}); throw error; }
}
export async function clearRuntime(runtime) {
  const errors = [];
  const runtimePath = descriptorChildPath(runtime.root, runtime.pathParts.at(-1));
  try {
    if (runtime.controllers.size > 0) fail('runtime_cleanup_controllers_live');
    const entries = await readdir(descriptorPath(runtime.handle));
    for (const name of entries) {
      if (name.endsWith('.ready.json') || name === 'rollback-selection.json') {
        await unlink(descriptorChildPath(runtime.handle, name));
      } else {
        fail('runtime_cleanup_unexpected_entry');
      }
    }
  } catch (error) { errors.push(error); } finally {
    // Ownership containment is the cleanup boundary.  Always drain it before
    // reporting unrelated runtime filesystem cleanup errors.
    try { await releaseOwnershipBoundary(runtime.boundary); } catch (error) { errors.push(error); }
    try { await runtime.handle.close(); } catch (error) { errors.push(error); }
    try { await rmdir(runtimePath); await runtime.root.sync(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'phase10_runtime_cleanup_failed');
}
