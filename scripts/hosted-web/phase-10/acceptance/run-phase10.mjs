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
import { parseLinuxProcStat, isLiveLinuxProcessStat, lifecycleLockHolderArguments, parseLifecycleLockHolderArguments, text, digest, plain, canonical, validateArtifact, validateDeployment, validateLockSet, validateEvidenceAuthority, validateReleaseLockAuthority, validateRuntimeMountAdmissionAuthority, validateTrustedRuntimeMountAuthority, validateTrustedReleaseLockAuthority, verifyReleaseLockProvenance, receiptEpoch, validateRuntimeMountCurrentOperation, validateRuntimeMountSettlement, runtimeMountReceiptPayload, verifyRuntimeMountAdmissionReceipt, validatePhase10Manifest, components, relativeParts, readHandle, openRelativeDirectory, bindFile, assertFile, bindDirectory, assertDirectory, assertOwnedFile, assertOwnedDirectory, assertPrivateSandbox, assertAbsentAt, deadlineAfter } from './run-phase10-manifest.mjs';
import { assertBefore, childExitCode, assertWriterLease, acquireWriter, releaseWriter, runLifecycleLockHolder, parseLifecycleOwnership, drainLifecycleOwnership, delay, readLinuxProcStat, watchOwnedProcess, groupHasLiveMember, signalOwnedGroup, waitGroup, waitChildExit, endOwnedGroup, createOwnershipBoundary, assertOwnershipBoundary, awaitOwnershipEnrollment, drainOwnershipBoundary, drainAndVerifyOwnershipBoundary, releaseOwnershipBoundary } from './run-phase10-lifecycle.mjs';
import { boundedJson, combineErrors, prepareExecutionBinding, createRuntimeStateProof, assertPersistedRuntimeStateProof, scalarString, exactKeys, healthAdmission, validateHealth, evidenceHealth, sameExecutableState, hashExecutableDescriptor, bindControllerExecutables, cleanControllerEnvironment } from './run-phase10-runtime.mjs';
import { startDeployment, verifyProductionRestoreAdmission, assertRestoredStateAdmitted, atomicRollbackSelection, consumeRollbackSelection, publishTerminalEvidence, clearRuntime } from './run-phase10-deployment.mjs';

export { sha256Bytes } from './run-phase10-shared.mjs';
export {
  isLiveLinuxProcessStat,
  lifecycleLockHolderArguments,
  parseLinuxProcStat,
  validatePhase10Manifest,
} from './run-phase10-manifest.mjs';

export async function runPhase10Acceptance(options = {}) {
  assertBefore(Number.MAX_SAFE_INTEGER, 'acceptance', options.signal);
  const supplied = validatePhase10Manifest(options.manifest);
  const manifestRoot = resolve(options.manifestDirectory ?? dirname(text(options.manifestPath, 'manifest_path')));
  const manifestHandle = await openDirectoryBound(manifestRoot); const bindings = [];
  let sandbox; let runtime; let evidence; let writer; let running; let target; let selectedRollback; let restoreArchiveAuthority; let failure; let outcome; let evidenceAuthority; let runtimeMountAuthority; let releaseLockAuthority;
  try {
    const manifest = await bindFile(manifestHandle, components(manifestRoot, resolve(options.manifestPath), 'manifest'), 'manifest', options.manifestSha256); bindings.push(manifest);
    const sealed = validatePhase10Manifest(JSON.parse(manifest.sealed.body));
    if (canonical(sealed) !== canonical(supplied)) fail('manifest_supplied_identity_mismatch');
    const sandboxPath = resolve(text(options.sandboxRoot, 'sandbox_root')); sandbox = await assertPrivateSandbox(sandboxPath);
    const marker = await bindFile(sandbox, components(sandboxPath, resolve(sandboxPath, sealed.disposableSandbox.markerPath), 'sandbox_marker'), 'sandbox_marker', sealed.disposableSandbox.markerSha256); bindings.push(marker);
    const source = await bindDirectory(sandbox, components(sandboxPath, resolve(sandboxPath, options.sourceRoot ?? 'state'), 'source'), 'source'); bindings.push(source);
    await assertOwnedFile(marker, 'sandbox_marker'); await assertOwnedDirectory(source, 'source');
    const runtimeParts = ['.phase10-runtime']; const evidenceParts = ['evidence']; const archiveParts = ['stopped-stack.archive']; const targetParts = ['restored-state'];
    for (const [name, label] of [[runtimeParts[0], 'runtime'], [evidenceParts[0], 'evidence'], [archiveParts[0], 'archive'], [targetParts[0], 'target']]) await assertAbsentAt(sandbox, name, label);
    const currentArtifact = await bindFile(sandbox, components(sandboxPath, resolve(sandboxPath, sealed.deployment.controllerArtifact.path), 'current_artifact'), 'current_artifact', sealed.deployment.controllerArtifact.sha256); bindings.push(currentArtifact);
    await assertOwnedFile(currentArtifact, 'current_artifact');
    const lockBindings = [];
    for (const lock of sealed.locks) { const binding = await bindFile(manifestHandle, components(manifestRoot, resolve(manifestRoot, lock.path), 'lock'), 'lock', lock.sha256); bindings.push(binding); lockBindings.push({ name: lock.name, lock, binding }); }
    const preceding = await bindFile(manifestHandle, components(manifestRoot, resolve(manifestRoot, sealed.precedingManifest.path), 'preceding_manifest'), 'preceding_manifest', sealed.precedingManifest.sha256); bindings.push(preceding);
    const prior = validateDeployment(JSON.parse(preceding.sealed.body), 'preceding');
    if (prior.deploymentId === sealed.deployment.deploymentId || prior.image.digest === sealed.deployment.image.digest || prior.controllerArtifact.sha256 === sealed.deployment.controllerArtifact.sha256) fail('preceding_deployment_not_distinct');
    for (const key of ['stackId', 'teamId', 'workspaceId', 'ownerId']) if (prior[key] !== sealed.deployment[key]) fail('preceding_deployment_identity_mismatch');
    const priorArtifact = await bindFile(sandbox, components(sandboxPath, resolve(sandboxPath, prior.controllerArtifact.path), 'preceding_artifact'), 'preceding_artifact', prior.controllerArtifact.sha256); bindings.push(priorArtifact);
    await assertOwnedFile(priorArtifact, 'preceding_artifact');
    runtime = await bindDirectory(sandbox, runtimeParts, 'runtime', true); runtime.controllers = new Map(); runtime.boundary = await createOwnershipBoundary(options.createOwnershipBoundary); evidence = await bindDirectory(sandbox, evidenceParts, 'evidence', true); evidence.absolutePath = join(sandboxPath, evidenceParts[0]);
    if (options.digestAuthority?.authorityId !== sealed.evidenceAuthority.authorityId) fail('evidence_authority_identity_mismatch');
    evidenceAuthority = { ...options.digestAuthority, definition: sealed.evidenceAuthority };
    if (options.releaseLockAuthority?.authorityId !== sealed.releaseLockAuthority.authorityId ||
      typeof options.releaseLockAuthority?.readTrustedIdentity !== 'function') {
      fail('release_lock_authority_identity_mismatch');
    }
    const trustedReleaseLockAuthority = validateTrustedReleaseLockAuthority(
      await options.releaseLockAuthority.readTrustedIdentity()
    );
    if (trustedReleaseLockAuthority.authorityId !== sealed.releaseLockAuthority.authorityId) {
      fail('release_lock_authority_identity_mismatch');
    }
    releaseLockAuthority = { ...options.releaseLockAuthority, definition: trustedReleaseLockAuthority };
    if (options.runtimeMountAuthority?.authorityId !== sealed.runtimeMountAdmissionAuthority.authorityId ||
      typeof options.runtimeMountAuthority?.readTrustedIdentity !== 'function' ||
      typeof options.runtimeMountAuthority?.readCurrentOperation !== 'function' ||
      typeof options.runtimeMountAuthority?.settleReceipt !== 'function') {
      fail('runtime_mount_admission_authority_identity_mismatch');
    }
    // This call is made over the pre-provisioned authority channel before any
    // controller is launched. Its identity is intentionally not read from the
    // manifest, its digest, controller environment, or a controller response.
    const trustedIdentity = validateTrustedRuntimeMountAuthority(
      await options.runtimeMountAuthority.readTrustedIdentity()
    );
    if (trustedIdentity.authorityId !== sealed.runtimeMountAdmissionAuthority.authorityId) {
      fail('runtime_mount_admission_authority_identity_mismatch');
    }
    runtimeMountAuthority = { ...options.runtimeMountAuthority, definition: trustedIdentity };
    for (const lock of lockBindings) {
      verifyReleaseLockProvenance({ ...lock.lock, sha256: lock.binding.sealed.sha256 }, releaseLockAuthority.definition);
    }
    writer = await acquireWriter(source, sealed.deployment.ownerId, runtime.boundary);
    await options.onStage?.('writer_acquired');
    assertBefore(Number.MAX_SAFE_INTEGER, 'acceptance', options.signal);
    for (const binding of [manifest, marker, currentArtifact, priorArtifact, preceding, ...lockBindings.map((lock) => lock.binding)]) await assertFile(binding); await assertDirectory(source); await assertDirectory(runtime); await assertWriterLease(writer);
    // Create this record before the first controller exists.  It is the one
    // continuity witness used by crash/restart, archive, restore, and rollback.
    const preCrashStateProof = await createRuntimeStateProof(source, sealed.deployment, 'pre_crash');
    let currentExecution = await prepareExecutionBinding({ runtime, state: source, deployment: sealed.deployment, artifact: currentArtifact, manifest, locks: lockBindings, label: 'current' });
    try { running = await startDeployment({ artifact: currentArtifact, deployment: sealed.deployment, runtime, state: source, writer, label: 'current', executionBinding: currentExecution, signal: options.signal, runtimeMountAuthority, stateProof: preCrashStateProof }); }
    finally { await currentExecution.handle.close().catch(() => {}); }
    const first = { ...(await running.crash()), execution: currentExecution.execution, executed: running.executed }; running = undefined;
    currentExecution = await prepareExecutionBinding({ runtime, state: source, deployment: sealed.deployment, artifact: currentArtifact, manifest, locks: lockBindings, label: 'current-restart' });
    let restart;
    try { restart = await startDeployment({ artifact: currentArtifact, deployment: sealed.deployment, runtime, state: source, writer, label: 'current-restart', executionBinding: currentExecution, signal: options.signal, runtimeMountAuthority, stateProof: preCrashStateProof }); }
    finally { await currentExecution.handle.close().catch(() => {}); }
    const restartHealth = restart.health; const restartStop = { ...(await restart.stop()), execution: currentExecution.execution, executed: restart.executed };
    const sourceDeploymentIdentity = { deploymentId: sealed.deployment.deploymentId, imageDigest: sealed.deployment.image.digest, deploymentManifestSha256: manifest.sealed.sha256, controllerArtifactSha256: currentArtifact.sealed.sha256 };
    await options.onStage?.('quiescent_before_backup'); await assertDirectory(source); await assertWriterLease(writer);
    assertBefore(Number.MAX_SAFE_INTEGER, 'acceptance', options.signal);
    const archivePath = descriptorChildPath(sandbox, archiveParts[0]);
    const backup = await createStoppedStackArchive({ sourceRoot: descriptorPath(source.handle), sourceRootHandle: source.handle, archiveRoot: archivePath, sourceDeploymentIdentity });
    await assertDirectory(source); await assertWriterLease(writer);
    const backupContinuity = await assertPersistedRuntimeStateProof(source, preCrashStateProof, 'backup');
    assertBefore(Number.MAX_SAFE_INTEGER, 'acceptance', options.signal);
    const verification = await verifyStoppedStackArchive({ archiveRoot: archivePath, expectedManifestHash: backup.manifestHash, expectedSourceDeploymentIdentity: sourceDeploymentIdentity });
    target = await bindDirectory(sandbox, targetParts, 'target', true);
    const restorePlan = Object.freeze({
      rotation: Object.freeze({
        format: 'hosted-restored-authority-rotation/v1', schemaVersion: 1,
        deploymentId: prior.deploymentId, sourceManifestHash: backup.manifestHash,
        restoreGeneration: 1, bootId: `boot_x${randomUUID().replace(/-/gu, '')}`,
        eventEpoch: `epoch_x${randomUUID().replace(/-/gu, '')}`,
        browserAuthorityRotated: true, runtimeAuthorityRotationRequired: true,
        freshMountBindingsRequired: true,
      }),
      secretPlan: Object.freeze({
        identityKey: `${randomUUID().replace(/-/gu, '')}${randomUUID().replace(/-/gu, '')}`,
        keyring: Object.freeze({
          binding: Object.freeze({ deploymentId: prior.deploymentId, restoreGeneration: 1 }),
          createdAt: 0,
          csrfKey: `${randomUUID().replace(/-/gu, '')}${randomUUID().replace(/-/gu, '')}`,
          format: 'hosted-access-keyring/v1',
          hashKey: `${randomUUID().replace(/-/gu, '')}${randomUUID().replace(/-/gu, '')}`,
          keyringId: `akr_x${randomUUID().replace(/-/gu, '')}`,
        }),
      }),
      runtimeMountAuthorityPublicKey: runtimeMountAuthority.definition.publicKeyPem,
    });
    let restored;
    restored = await restoreStoppedStackArchive({ archiveRoot: archivePath, targetRoot: descriptorPath(target.handle), targetRootHandle: target.handle, restoreGeneration: 1, restoreDeploymentId: prior.deploymentId, expectedManifestHash: backup.manifestHash, expectedSourceDeploymentIdentity: sourceDeploymentIdentity, restoreAuthorityPlan: restorePlan }); await assertWriterLease(writer); assertBefore(Number.MAX_SAFE_INTEGER, 'acceptance', options.signal);
    const restoredContinuity = await assertPersistedRuntimeStateProof(target, preCrashStateProof, 'restore');
    await options.onStage?.('restored_state_proof_verified');
    const rollback = await atomicRollbackSelection(runtime, preceding, prior);
    selectedRollback = await consumeRollbackSelection(runtime, sandbox, prior);
    const rollbackExecution = await prepareExecutionBinding({ runtime, state: target, deployment: selectedRollback.deployment, artifact: selectedRollback.artifact, manifest, locks: lockBindings, label: 'rollback' });
    const restorePlanName = 'rollback.restore-authority-plan.json';
    await assertAbsentAt(runtime.handle, restorePlanName, 'rollback_restore_authority_plan');
    await writeExclusiveDurableFileAt(runtime.handle, restorePlanName, `${canonical(restorePlan)}\n`, 0o400);
    restoreArchiveAuthority = {
      plan: await bindFile(runtime.handle, [restorePlanName], 'rollback_restore_authority_plan'),
      archive: await bindDirectory(sandbox, archiveParts, 'rollback_restore_archive'),
    };
    let rolledBack;
    try { rolledBack = await startDeployment({ artifact: selectedRollback.artifact, deployment: selectedRollback.deployment, runtime, state: target, writer, label: 'rollback', executionBinding: rollbackExecution, signal: options.signal, restoreAdmission: restored.rotation, runtimeMountAuthority, restoreArchiveAuthority, stateProof: preCrashStateProof }); }
    finally { await rollbackExecution.handle.close().catch(() => {}); }
    const rollbackHealth = rolledBack.health; const rollbackStop = { ...(await rolledBack.stop()), execution: rollbackExecution.execution, executed: rolledBack.executed };
    await assertRestoredStateAdmitted(target, selectedRollback.deployment, restored.rotation);
    await selectedRollback.artifact.handle.close(); selectedRollback = undefined;
    await restoreArchiveAuthority.plan.handle.close(); await restoreArchiveAuthority.archive.handle.close();
    await unlink(descriptorChildPath(runtime.handle, restorePlanName)); await runtime.handle.sync();
    restoreArchiveAuthority = undefined;
    await target.handle.close(); target = undefined;
    // A writer hand-off is safe only after the whole cgroup has been drained;
    // process groups alone do not contain a descendant that called setsid().
    await drainAndVerifyOwnershipBoundary(runtime.boundary);
    await clearRuntime(runtime); runtime = undefined;
    await releaseWriter(writer); writer = undefined;
    outcome = { format: FORMAT, schemaVersion: 5, status: 'passed', current: { deploymentId: sealed.deployment.deploymentId, artifactSha256: currentArtifact.sealed.sha256, first, restart: { health: restartHealth, cleanup: restartStop } }, continuity: { proofId: preCrashStateProof.proofId, deploymentId: preCrashStateProof.deploymentId, backupDatabaseIdentity: backupContinuity.databaseIdentity, restoredDatabaseIdentity: restoredContinuity.databaseIdentity }, backup: { backup, verification, restored, sourceDeploymentIdentity }, rollback: { ...rollback, health: rollbackHealth, cleanup: rollbackStop }, cleanup: { quiescent: true, lifecycleWriterReleased: true, controllerRunning: false, ownerRunning: false, concurrentOwner: false } };
  } catch (error) {
    failure = error;
    const cleanupErrors = [];
    if (restoreArchiveAuthority) {
      try { await restoreArchiveAuthority.plan.handle.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await restoreArchiveAuthority.archive.handle.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await unlink(descriptorChildPath(runtime.handle, 'rollback.restore-authority-plan.json')); await runtime.handle.sync(); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError); }
      restoreArchiveAuthority = undefined;
    }
    if (running) { try { await running.crash(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } running = undefined; }
    if (runtime) for (const child of runtime.controllers.values()) { try { await endOwnedGroup(child, 'SIGKILL'); runtime.controllers.delete(child.pid); } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    let ownershipDrained = !runtime;
    if (runtime) {
      try { await drainAndVerifyOwnershipBoundary(runtime.boundary); ownershipDrained = true; }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    // Never make a successor writer possible while a detached cgroup member
    // remains. If the drain cannot be proved, retain the lease until process
    // termination rather than converting the failure into overlapping owners.
    if (writer && ownershipDrained) { try { await releaseWriter(writer, true); writer = undefined; } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    else if (writer) cleanupErrors.push(new Error('phase10_writer_retained_until_ownership_drain'));
    if (runtime) { try { await clearRuntime(runtime); } catch (cleanupError) { cleanupErrors.push(cleanupError); } runtime = undefined; }
    const cleanup = { quiescent: cleanupErrors.length === 0, lifecycleWriterReleased: cleanupErrors.length === 0, controllerRunning: cleanupErrors.length !== 0, ownerRunning: false, concurrentOwner: false, errors: cleanupErrors.map((cleanupError) => String(cleanupError?.message ?? cleanupError)) };
    outcome = { format: FORMAT, schemaVersion: 5, status: 'failed', failure: { message: error instanceof Error ? error.message : String(error) }, cleanup };
    failure = combineErrors(error, cleanupErrors);
  } finally {
    // Restore and rollback bindings can be acquired before admission, health,
    // or shutdown fails. Close them here as well as on the success path so no
    // failed acceptance retains a descriptor into the restored tree.
    await selectedRollback?.artifact?.handle.close().catch(() => {});
    await restoreArchiveAuthority?.plan?.handle.close().catch(() => {});
    await restoreArchiveAuthority?.archive?.handle.close().catch(() => {});
    await target?.handle.close().catch(() => {});
    if (evidence && outcome) { try { await assertDirectory(evidence); outcome.terminalEvidence = await publishTerminalEvidence(evidence, outcome, evidenceAuthority, options.onEvidenceStage); } catch (publishError) { failure ??= publishError; } }
    await evidence?.handle.close().catch(() => {}); await sandbox?.close().catch(() => {});
    for (const binding of bindings.reverse()) await binding.handle.close().catch(() => {}); await manifestHandle.close();
  }
  if (failure) throw failure;
  return Object.freeze({ status: 'passed', evidencePath: outcome.terminalEvidence.path, evidenceSha256: outcome.terminalEvidence.sha256, evidence: outcome, cleanup: outcome.cleanup });
}

function parseArgs(argv) { const result = {}; for (let index = 0; index < argv.length; index += 2) { if (!argv[index]?.startsWith('--') || !argv[index + 1]) fail('arguments_invalid'); result[argv[index].slice(2)] = argv[index + 1]; } return result; }
function cliDigestAuthority(authorityId) {
  const fd = Number(process.env.PHASE10_DIGEST_AUTHORITY_FD);
  if (!Number.isInteger(fd) || fd < 3) fail('evidence_authority_fd_invalid');
  return {
    authorityId,
    async pin(payload) {
      const socket = new Socket({ fd, readable: true, writable: true });
      const deadline = deadlineAfter();
      return await new Promise((resolveReceipt, rejectReceipt) => {
        const chunks = []; let size = 0;
        const timer = setTimeout(() => { socket.destroy(); rejectReceipt(new Error('phase10_evidence_authority_deadline_exceeded')); }, Math.max(1, deadline - Date.now()));
        socket.on('data', (chunk) => { size += chunk.byteLength; if (size > MAX_CONTROL_BYTES) { socket.destroy(); rejectReceipt(new Error('phase10_evidence_authority_response_too_large')); return; } chunks.push(chunk); });
        socket.once('end', () => { clearTimeout(timer); try { resolveReceipt(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { rejectReceipt(new Error('phase10_evidence_authority_response_invalid')); } });
        socket.once('error', (error) => { clearTimeout(timer); rejectReceipt(error); });
        socket.end(`${canonical({ format: 'phase10-digest-pin-request/v1', ...payload })}\n`);
      });
    },
  };
}
function cliReleaseLockAuthority(authorityId) {
  const fd = Number(process.env.PHASE10_RELEASE_LOCK_TRUSTED_IDENTITY_FD);
  if (!Number.isInteger(fd) || fd < 3) fail('release_lock_authority_fd_invalid');
  return {
    authorityId,
    async readTrustedIdentity() {
      const socket = new Socket({ fd, readable: true, writable: true });
      const deadline = deadlineAfter();
      return await new Promise((resolveIdentity, rejectIdentity) => {
        const chunks = []; let size = 0;
        const timer = setTimeout(() => { socket.destroy(); rejectIdentity(new Error('phase10_release_lock_authority_deadline_exceeded')); }, Math.max(1, deadline - Date.now()));
        socket.on('data', (chunk) => { size += chunk.byteLength; if (size > MAX_CONTROL_BYTES) { socket.destroy(); rejectIdentity(new Error('phase10_release_lock_authority_response_too_large')); return; } chunks.push(chunk); });
        socket.once('end', () => { clearTimeout(timer); try { resolveIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { rejectIdentity(new Error('phase10_release_lock_authority_response_invalid')); } });
        socket.once('error', (error) => { clearTimeout(timer); rejectIdentity(error); });
        socket.end(`${canonical({ format: 'phase10-release-lock-trusted-identity-request/v1', authorityId })}\n`);
      });
    },
  };
}
function cliRuntimeMountAuthority(authorityId) {
  const receiptFd = Number(process.env.PHASE10_RUNTIME_MOUNT_ADMISSION_AUTHORITY_FD);
  const identityFd = Number(process.env.PHASE10_RUNTIME_MOUNT_TRUSTED_IDENTITY_FD);
  const currentFd = Number(process.env.PHASE10_RUNTIME_MOUNT_CURRENT_OPERATION_FD);
  const settlementFd = Number(process.env.PHASE10_RUNTIME_MOUNT_SETTLEMENT_FD);
  for (const fd of [receiptFd, identityFd, currentFd, settlementFd]) {
    if (!Number.isInteger(fd) || fd < 3) fail('runtime_mount_admission_authority_fd_invalid');
  }
  const request = async (fd, payload) => {
    const socket = new Socket({ fd, readable: true, writable: true });
    const deadline = deadlineAfter();
    return await new Promise((resolveReceipt, rejectReceipt) => {
      const chunks = []; let size = 0;
      const timer = setTimeout(() => { socket.destroy(); rejectReceipt(new Error('phase10_runtime_mount_admission_authority_deadline_exceeded')); }, Math.max(1, deadline - Date.now()));
      socket.on('data', (chunk) => { size += chunk.byteLength; if (size > MAX_CONTROL_BYTES) { socket.destroy(); rejectReceipt(new Error('phase10_runtime_mount_admission_authority_response_too_large')); return; } chunks.push(chunk); });
      socket.once('end', () => { clearTimeout(timer); try { resolveReceipt(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { rejectReceipt(new Error('phase10_runtime_mount_admission_authority_response_invalid')); } });
      socket.once('error', (error) => { clearTimeout(timer); rejectReceipt(error); });
      socket.end(`${canonical(payload)}\n`);
    });
  };
  return {
    authorityId,
    async readTrustedIdentity() { return await request(identityFd, { format: 'phase10-runtime-mount-trusted-identity-request/v1', authorityId }); },
    async readCurrentOperation(rotation) { return await request(currentFd, { format: 'phase10-runtime-mount-current-operation-request/v1', authorityId, rotation }); },
    async rotateAndAdmit(rotation, currentOperation) { return await request(receiptFd, { format: 'phase10-runtime-mount-admission-request/v1', authorityId, rotation, currentOperation }); },
    async settleReceipt(receipt, currentOperation) { return await request(settlementFd, { format: 'phase10-runtime-mount-settlement-request/v1', authorityId, receipt, currentOperation }); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--phase10-lifecycle-lock-holder') {
    await runLifecycleLockHolder(parseLifecycleLockHolderArguments(process.argv.slice(3)));
  } else {
  const args = parseArgs(process.argv.slice(2)); const manifestPath = resolve(text(args.manifest, 'manifest')); const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let manifestBytes; try { manifestBytes = (await readHandle(handle, 'manifest')).body; } finally { await handle.close(); }
  const cliManifest = JSON.parse(manifestBytes);
  const result = await runPhase10Acceptance({ manifest: cliManifest, manifestPath, manifestDirectory: dirname(manifestPath), manifestSha256: sha256Bytes(manifestBytes), sandboxRoot: args['sandbox-root'], sourceRoot: args['source-root'], digestAuthority: cliDigestAuthority(validateEvidenceAuthority(cliManifest.evidenceAuthority).authorityId), releaseLockAuthority: cliReleaseLockAuthority(validateReleaseLockAuthority(cliManifest.releaseLockAuthority).authorityId), runtimeMountAuthority: cliRuntimeMountAuthority(validateRuntimeMountAdmissionAuthority(cliManifest.runtimeMountAdmissionAuthority).authorityId) }); process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
