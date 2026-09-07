import type { SelectedControllerClient } from './selected-controller-client';
import { nativeActivationSocketIdentity, type NativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import type { NativeSuccessorHandle } from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { randomBytes, createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { decodeNativeActivationHandleSelection, NATIVE_ACTIVATION_HANDLE_CONTRACT, type NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { transferNativeActivationHandle } from './native-handle-transfer';
import { assertSelectedSupervisorObservation, type SelectedSupervisorProcessObservation } from './selected-process-observation';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { assertSelectedLaunchPreflightBound, encodeSelectedLaunchPhase, writeSelectedLaunchPhase, SELECTED_LAUNCH_PHASE } from './selected-launch-phase';
import { closeSync, createReadStream, fstatSync, openSync, constants } from 'node:fs';

import type { SupervisorPlan } from '../processes';
import { assertOwnerPlanV2 } from '../owner-plan';
import { observeOwnerWrapper, observeSelectedOwnerModule, type OwnerWrapperObservation } from '../owner-wrapper-observation';
import { OWNER_LAUNCH_EVIDENCE_V2, type OwnerLaunchEvidenceV2 } from '../owner-descriptor-v2';
import { canonicalJson, sha256 } from './canonical';
import { assembleOwnerBootstrap, type AssembleBootstrapInput, type AssembledBootstrap } from './bootstrap-v2';
import { launchNativeOwner, type NativeLaunchOptions, type NativeOwnerLaunch } from './native-launch';
import { descriptorMap, OWNER_ROLES, wrapperStartToken, type HeldOwner } from './native-protocol';
import { SERVER_AUTH_V2, validatePreparedProfileTransfer, type RetainedPreparedProfile } from './private-profile-transfer';

export { launchNativeOwner, OwnerLaunchError } from './native-launch';
export type { InheritedImage, NativeOwnerLaunch } from './native-launch';
export { assembleOwnerBootstrap } from './bootstrap-v2';
export type { BootstrapCommon, ExpectedSupervisedOpenCode, RawRetentionBinding } from './bootstrap-v2';

export interface LaunchOwnerFromPlanOptions {
  readonly retainedPreparedProfile?: RetainedPreparedProfile;
  readonly plan: SupervisorPlan;
  readonly handles: Pick<NativeLaunchOptions, 'helper' | 'executable' | 'cwdFd' | 'rawFd' | 'walFd'>;
  /** Lets the concrete input owner close only writers retained after preflight
   * rejection, never a transferred numeric slot that may already be reused. */
  readonly onWriterOwnershipTaken?: () => void;
  /** Comes from the selected supervisor start record, not from the Owner frame. */
  readonly supervisorProcessStartToken: string;
  /** Required by recipe-v3 plans; must be the entry's live retained observation. */
  readonly selectedSupervisorObservation?: SelectedSupervisorProcessObservation;
  readonly selectedPlanAdmission?: SelectedPlanAdmission;
  readonly recipeSha256: string;
  readonly harnessContractSha256: string;
  readonly bootstrap: Omit<AssembleBootstrapInput, 'held' | 'supervisorBinding'>;
  readonly invocation: { readonly kind: 'built-entry' } | {
    readonly kind: 'source-bun';
    /** Module in the already admitted, read-only mounted source closure. Never the Bun image path. */
    readonly modulePath: string;
    readonly moduleSha256: string;
  };
  readonly environment: Omit<NativeLaunchOptions['environment'], 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2'>;
  readonly signal?: AbortSignal;
  /** Explicit extension; old launch-only callers do not establish cross-process transfer. */
  readonly activationHandleIpc?: Readonly<{
    readonly nativeController: SelectedControllerClient;
    readonly authorizeSuccessorHandle?: (selection: NativeActivationHandleSelection, endpoint: NativeActivationSocketIdentity) => Promise<NativeSuccessorHandle>;
    contract: 'agent-teams.hosted-native-activation-transfer/v1';
    /** Initial Product starts after actual Owner exec; replacements reuse its live IPC child. */
    product: ChildProcess | ((selection: NativeActivationHandleSelection) => Promise<ChildProcess>);
    selectedArtifacts: Readonly<{
      contract: typeof SELECTED_LAUNCH_PHASE;
      /** Existing contract in the admitted readonly artifact mount. */
      harnessContractPath: string;
      /** Exact retained runtime-manifest bytes, including their existing LF. */
      runtimeManifestSha256: string;
    }>;
  }>;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`owner_plan_${reason}`);
}
async function observeExecutingSupervisor(plan: SupervisorPlan, signal?: AbortSignal): Promise<void> {
  const fd = openSync('/proc/self/exe', constants.O_RDONLY);
  try {
    const stat = fstatSync(fd, { bigint: true });
    check(stat.isFile() && stat.size > 0n && stat.size <= 1024n ** 3n &&
      String(stat.dev) === plan.expectedExecutableDevice.supervisor &&
      String(stat.ino) === plan.expectedExecutableInode.supervisor, 'supervisor_image_identity');
    const hash = createHash('sha256'); let count = 0;
    for await (const b of createReadStream('', { fd, autoClose: false, start: 0, end: Number(stat.size) - 1, signal })) {
      hash.update(b as Buffer); count += (b as Buffer).length;
    }
    const after = fstatSync(fd, { bigint: true });
    check(count === Number(stat.size) && after.size === stat.size && after.mtimeNs === stat.mtimeNs &&
      after.ctimeNs === stat.ctimeNs && hash.digest('hex') === plan.expectedExecutableSha256.supervisor, 'supervisor_image_digest');
  } finally { closeSync(fd); }
}
function parentCleanup(held: HeldOwner, ownerProcessStartToken: string) {
  return Object.freeze({ schemaVersion: 3 as const,
    contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v3' as const,
    wrapperPid: held.parentPid, wrapperStartTicks: held.parentStartTicks, wrapperStartToken: wrapperStartToken(held),
    ownerPid: held.ownerPid, ownerStartTicks: held.ownerStartTicks, ownerProcessStartToken,
    spawnNonce: held.spawnNonce, spawnBoundaryMonotonicNs: held.forkMonotonicNs,
    descriptors: Object.freeze(held.descriptors.map((d, i) => Object.freeze({ role: OWNER_ROLES[i][0], parentFd: d.sourceFd,
      beforeSpawn: Object.freeze({ method: 'proc-fd-identity' as const, observedMonotonicNs: held.beforeMonotonicNs,
        path: `/proc/${held.parentPid}/fd/${d.sourceFd}`, device: d.device, inode: d.inode, mode: d.mode }),
      afterSpawn: Object.freeze({ method: 'fstat-ebadf' as const, observedMonotonicNs: d.closedMonotonicNs, errno: 'EBADF' as const }) }))) });
}

/** Connect inside the selected supervisor AFTER admitIntegration, namespace setup and real OpenCode
 * readiness/profile observation. This stage does not grant that authority or mint OpenCode IDs.
 * On preflight failure writers remain with the caller; once launchNativeOwner is invoked they transfer.
 */
export async function launchOwnerFromPlan(options: LaunchOwnerFromPlanOptions) {
  const { plan, handles, bootstrap, invocation } = options;
  check(plan.schemaVersion === 2 && plan.protocol === 'agent-teams.p3c.supervisor-transcript/v1', 'version');
  check(plan.controllerNonce === bootstrap.expectedHost.activation.controllerNonce &&
    plan.runId === bootstrap.expectedHost.activation.runId &&
    plan.startSchedule.some(s => s.role === 'owner' && s.generation === bootstrap.common.ownerGeneration), 'launch_binding');
  for (const value of [options.supervisorProcessStartToken, options.recipeSha256, options.harnessContractSha256]) {
    check(/^[0-9a-f]{64}$/u.test(value), 'selected_digest');
  }
  const cwd = fstatSync(handles.cwdFd, { bigint: true });
  check(cwd.isDirectory() && String(cwd.dev) === plan.expectedCwd.owner.device && String(cwd.ino) === plan.expectedCwd.owner.inode, 'cwd');
  check(bootstrap.expectedHost.executable.sha256 === plan.expectedExecutableSha256.opencode &&
    bootstrap.expectedHost.executable.device === plan.expectedExecutableDevice.opencode &&
    bootstrap.expectedHost.executable.inode === plan.expectedExecutableInode.opencode &&
    bootstrap.expectedHost.executable.moduleSha256 === plan.expectedProducerModuleSha256.opencode &&
    bootstrap.expectedHost.executable.artifactManifestSha256 === plan.expectedProducerArtifactSha256.opencode, 'opencode_pins');
  check(handles.executable.pin.sha256 === plan.expectedExecutableSha256.owner &&
    handles.executable.pin.device === plan.expectedExecutableDevice.owner &&
    handles.executable.pin.inode === plan.expectedExecutableInode.owner, 'selected_owner_image');
  const entrySha256 = plan.expectedProducerModuleSha256.owner;
  if (invocation.kind === 'built-entry') {
    check(plan.ownerSourceInvocation === undefined && handles.executable.pin.sha256 === entrySha256, 'built_owner_image');
  } else {
    const selected = plan.ownerSourceInvocation;
    check(selected?.format === 'agent-teams.hosted-owner-source-invocation/v1' &&
      selected.executable.device === plan.expectedExecutableDevice.owner &&
      selected.executable.inode === plan.expectedExecutableInode.owner &&
      selected.executable.sha256 === plan.expectedExecutableSha256.owner &&
      selected.module.path === invocation.modulePath && selected.module.sha256 === entrySha256, 'source_selection');
    check(invocation.moduleSha256 === entrySha256 && invocation.modulePath.startsWith('/') &&
      Buffer.byteLength(invocation.modulePath) <= 4096 && !invocation.modulePath.includes('\0') &&
      !invocation.modulePath.split('/').some(s => s === '.' || s === '..'), 'source_module');
  }
  assertOwnerPlanV2(plan);
  check(plan.ownerPreparationModule ? bootstrap.serverAuthFormat === SERVER_AUTH_V2 :
    bootstrap.serverAuthFormat !== SERVER_AUTH_V2, 'profile_recipe_selection');
  if (plan.supervisorSourceInvocation) {
    check(options.selectedPlanAdmission, 'selected_plan_admission_required');
    assertSelectedPlanAdmission(options.selectedPlanAdmission, plan);
    check(options.selectedSupervisorObservation, 'selected_supervisor_observation_required');
    check(options.selectedPlanAdmission.process === options.selectedSupervisorObservation,
      'selected_supervisor_admission_observation');
    assertSelectedSupervisorObservation(options.selectedSupervisorObservation, plan.supervisorSourceInvocation);
    check(options.selectedSupervisorObservation.processStartToken === options.supervisorProcessStartToken &&
      options.selectedSupervisorObservation.executable.sha256 === plan.expectedExecutableSha256.supervisor &&
      options.selectedSupervisorObservation.executable.device === plan.expectedExecutableDevice.supervisor &&
      options.selectedSupervisorObservation.executable.inode === plan.expectedExecutableInode.supervisor,
    'selected_supervisor_binding');
  } else {
    check(options.selectedSupervisorObservation === undefined, 'selected_supervisor_unexpected');
    check(options.selectedPlanAdmission === undefined, 'selected_plan_admission_unexpected');
  }
  if (options.activationHandleIpc) {
    check(options.activationHandleIpc.nativeController &&
      options.activationHandleIpc.nativeController.admission === options.selectedPlanAdmission &&
      canonicalJson(options.activationHandleIpc.nativeController.plan) === canonicalJson(plan), 'native_controller_binding');
    const artifacts = options.activationHandleIpc.selectedArtifacts;
    check(invocation.kind === 'source-bun' && artifacts?.contract === SELECTED_LAUNCH_PHASE &&
      /^[0-9a-f]{64}$/u.test(artifacts.runtimeManifestSha256) &&
      artifacts.harnessContractPath.startsWith('/') && artifacts.harnessContractPath.length <= 4096 &&
      !artifacts.harnessContractPath.includes('\0') && !artifacts.harnessContractPath.includes('\\') &&
      artifacts.harnessContractPath.split('/').slice(1).every(p => p && p !== '.' && p !== '..'), 'selection_phase_artifacts');
    check(options.activationHandleIpc.contract === 'agent-teams.hosted-native-activation-transfer/v1' &&
      plan.productSourceInvocation?.format === 'agent-teams.hosted-product-node-handle-ipc/v1' &&
      canonicalJson(plan.expectedArgv.product) === canonicalJson([plan.productSourceInvocation.module.path,
        plan.productSourceInvocation.activationArgument]), 'handle_transfer_version');
  }
  check(options.recipeSha256 === plan.ownerRecipeSha256 && options.harnessContractSha256 === plan.ownerHarnessContractSha256, 'selected_contract_recipe');
  const helper = plan.ownerLaunchHelper!;
  check(handles.helper.pin.device === helper.device && handles.helper.pin.inode === helper.inode &&
    handles.helper.pin.sha256 === helper.sha256 && handles.helper.pin.size === helper.size &&
    handles.helper.pin.mode === helper.mode, 'selected_helper');
  if (invocation.kind === 'source-bun') await observeSelectedOwnerModule(invocation.modulePath, invocation.moduleSha256);
  await observeExecutingSupervisor(plan, options.signal);
  const wal = fstatSync(handles.walFd, { bigint: true });
  const provenance = plan.runtimeManifest.captureEmissionContract;
  check(provenance.contract === 'claude-team/hosted-producer-provenance' && provenance.version === 2 &&
    provenance.environment === 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2' && provenance.descriptorSlots.ownerWalTimeline === 9 &&
    /^[0-9a-f]{64}$/u.test(provenance.contractSha256), 'selected_provenance_contract');
  // Existing H/P capsule format, using the actual inherited FD9 object and the selected image/module.
  const capsule = canonicalJson({ activation: {
    controllerNonce: plan.controllerNonce, runId: plan.runId, stackManifestSha256: bootstrap.expectedHost.activation.stackManifestSha256 },
    contract: provenance.contract, contractSha256: provenance.contractSha256,
    expectedProducer: { artifactManifestSha256: plan.expectedProducerArtifactSha256.owner,
      executableSha256: handles.executable.pin.sha256, implementationId: 'agent-teams.orchestrator.hosted-approval-owner.v1', moduleSha256: entrySha256 },
    producerRole: 'owner', streams: { ownerWalTimeline: { fd: 9, device: String(wal.dev), inode: String(wal.ino) } }, version: 2 });
  const ownerProcessStartToken = randomBytes(32).toString('hex');
  check(bootstrap.preparedProfileTransfer === undefined, 'precomputed_profile_transfer');
  check(bootstrap.serverAuthFormat === SERVER_AUTH_V2 ? !!options.retainedPreparedProfile :
    !options.retainedPreparedProfile, 'retained_profile_selection');
  // This token is the actual launch-selected token used in all subsequent
  // native observations. Never transfer with a placeholder or a prior start.
  const profileContext = { expectedHostSha256: sha256(canonicalJson(bootstrap.expectedHost)),
    ownerProcessStartToken, bootstrapDigest: bootstrap.common.bootstrapBinding.bootstrapDigest };
  let preparedProfileTransfer = options.retainedPreparedProfile
    ? structuredClone(options.retainedPreparedProfile.transfer(bootstrap.key, profileContext)) : undefined;
  const preparedProfileBinding = preparedProfileTransfer &&
    validatePreparedProfileTransfer(preparedProfileTransfer, bootstrap.key, profileContext);
  // Retain static selected values before the child exists; only bounded native
  // observations and the actual assembled header digest are added after exec.
  const selectedStatic = options.activationHandleIpc ? Object.freeze(structuredClone({
        ...(preparedProfileBinding ? { preparedProfileBinding } : {}),
        expectedHost: bootstrap.expectedHost, rawRetention: bootstrap.rawRetention,
        supervisorProcessStartToken: options.supervisorProcessStartToken, ownerProcessStartToken,
        recipeSha256: options.recipeSha256, harnessContractSha256: options.harnessContractSha256,
        ownerModule: { path: plan.ownerSourceInvocation!.module.path, sha256: entrySha256 },
        ownerArtifactManifestSha256: plan.expectedProducerArtifactSha256.owner,
        ownerExecutable: { device: handles.executable.pin.device, inode: handles.executable.pin.inode,
          size: handles.executable.pin.size, sha256: handles.executable.pin.sha256 },
        supervisorExecutable: { device: plan.expectedExecutableDevice.supervisor,
          inode: plan.expectedExecutableInode.supervisor, sha256: plan.expectedExecutableSha256.supervisor },
        ...(options.selectedSupervisorObservation ? {
          selectedSupervisor: options.selectedSupervisorObservation,
          selectedControl: options.selectedPlanAdmission!.control,
          selectedRecipe: options.selectedPlanAdmission!.recipe,
        } : {}),
        refs: { openCode: plan.runtimeManifest.refs.openCode, orchestrator: plan.runtimeManifest.refs.orchestrator,
          product: plan.runtimeManifest.refs.product },
        serializedProductBootstrap: new TextDecoder('utf-8', { fatal: true }).decode(bootstrap.serializedProductBootstrap),
        producerCapsule: capsule, runtimeManifestSha256: options.activationHandleIpc!.selectedArtifacts.runtimeManifestSha256,
        harnessContractPath: options.activationHandleIpc!.selectedArtifacts.harnessContractPath
  })) : undefined;
  if (selectedStatic) {
    assertSelectedLaunchPreflightBound(selectedStatic);
  }
  let digests: AssembledBootstrap['digests'] | undefined;
  let wrapperObservation: OwnerWrapperObservation | undefined;
  const launch = await launchNativeOwner({ ...handles, signal: options.signal,
    serverAuthFormat: bootstrap.serverAuthFormat,
    onWriterOwnershipTaken: options.onWriterOwnershipTaken,
    argv: ['/proc/self/fd/11', ...plan.expectedArgv.owner],
    environment: { ...options.environment, P3C_PROCESS_OWNERSHIP_MARKER: plan.processOwnership.marker,
      [provenance.environment]: capsule },
    async assemble(held) {
      wrapperObservation = await observeOwnerWrapper(held, handles.helper.pin);
      const assembled = assembleOwnerBootstrap({ ...bootstrap, preparedProfileTransfer, held, supervisorBinding: {
        supervisorPid: held.callerPid, supervisorStartTicks: held.callerStartTicks,
        supervisorStartToken: options.supervisorProcessStartToken, supervisorExecutableSha256: plan.expectedExecutableSha256.supervisor,
        recipeSha256: options.recipeSha256, ownerEntrySha256: entrySha256, ownerPid: held.ownerPid,
        ownerStartTicks: held.ownerStartTicks, ownerProcessStartToken, harnessContractSha256: options.harnessContractSha256,
        ownerProducerCapsuleSha256: sha256(capsule) } });
      preparedProfileTransfer = undefined;
      digests = assembled.digests; return assembled;
    } });
  const map = descriptorMap(launch.held), cleanup = parentCleanup(launch.held, ownerProcessStartToken);
  const launchEvidence = (): OwnerLaunchEvidenceV2 => Object.freeze({ schemaVersion: 2,
    contract: OWNER_LAUNCH_EVIDENCE_V2, ownerProcessStartToken, descriptorMap: map,
    descriptorMapSha256: digests!.descriptorMapSha256, bootstrapDigests: digests!, parentCleanup: cleanup,
    wrapperObservation: wrapperObservation!, executedImageSha256: launch.executed.executableSha256,
    nativeEvents: launch.nativeEvents() });
  let activationHandleTransfer: Awaited<ReturnType<typeof transferNativeActivationHandle>> | undefined;
  let selectedLaunchPhase: Awaited<ReturnType<typeof writeSelectedLaunchPhase>> | undefined;
  if (options.activationHandleIpc) {
    const endpoint = launch.activation.take();
    try {
      // One existing five-second budget covers root admission and the complete
      // HSL1 write. Neither Product startup nor activation is a signing input.
      const deadline = performance.now() + 5000;
      const admissionSignal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(5000)]);
      const selectedLaunch = Object.freeze({ ...selectedStatic!,
        bootstrapV2HeaderSha256: digests!.bootstrapV2HeaderSha256,
        held: launch.held, executed: launch.executed });
      const nativeAdmission = await options.activationHandleIpc.nativeController.nativeAdmission({ kind: 'native',
        generation: bootstrap.common.ownerGeneration, ownerProcessStartToken, launch: selectedLaunch, sealed: launch.sealed }, admissionSignal);
      const frame = encodeSelectedLaunchPhase(selectedLaunch, launch.sealed, nativeAdmission);
      try { selectedLaunchPhase = await writeSelectedLaunchPhase(endpoint, frame, deadline, admissionSignal); }
      finally { frame.fill(0); }
      const selected = decodeNativeActivationHandleSelection({ contract: NATIVE_ACTIVATION_HANDLE_CONTRACT,
        ownerProcessStartToken, bootstrapV2HeaderSha256: digests!.bootstrapV2HeaderSha256,
        bootstrapDigest: digests!.bootstrapDigest, ownerGeneration: bootstrap.common.ownerGeneration,
        ownerSessionId: bootstrap.common.ownerSessionId,
        expectedOpenCodeExecutableSha256: bootstrap.expectedHost.executable.sha256 });
      const product = typeof options.activationHandleIpc.product === 'function'
        ? await options.activationHandleIpc.product(selected) : options.activationHandleIpc.product;
      const wire = selected.ownerGeneration === 1 ? selected
        : await options.activationHandleIpc.authorizeSuccessorHandle?.(selected, nativeActivationSocketIdentity(endpoint));
      if (!wire) throw new Error('native_successor_handle_authorization_required');
      if ('selection' in wire && canonicalJson(wire.selection) !== canonicalJson(selected)) {
        throw new Error('native_successor_handle_selection_substituted');
      }
      activationHandleTransfer = await transferNativeActivationHandle(product,
        endpoint, wire, options.signal);
    } catch (error) {
      endpoint.destroy();
      const [disposal] = await Promise.allSettled([launch.dispose()]);
      throw new OwnerPostExecHandoffError(error, Object.freeze({
        held: launch.held, sealed: launch.sealed, executed: launch.executed,
        parentWriterClosures: launch.parentWriterClosures,
        ownerProcessStartToken, evidence: launchEvidence(),
        ...(selectedLaunchPhase ? { selectedLaunchPhase } : {}),
      }), disposal);
    }
  }
  return Object.freeze({ ...launch, ownerProcessStartToken, digests: digests!, descriptorMap: map,
    ...(options.selectedSupervisorObservation ? { selectedSupervisor: options.selectedSupervisorObservation } : {}),
    parentCleanup: cleanup, launchEvidence,
    ...(activationHandleTransfer ? { activationHandleTransfer, selectedLaunchPhase } : {}) });
}

/** Native execution already happened. Preserve it even when the FD5 prelude or
 * cross-process socket transfer subsequently fails. Disposal fulfillment only
 * reports native-launch cleanup, not descendant drain or evidence sealing. */
export class OwnerPostExecHandoffError extends Error {
  constructor(cause: unknown,
    readonly observedLaunch: Readonly<{
      held: NativeOwnerLaunch['held'];
      sealed: NativeOwnerLaunch['sealed'];
      executed: NativeOwnerLaunch['executed'];
      parentWriterClosures: NativeOwnerLaunch['parentWriterClosures'];
      ownerProcessStartToken: string;
      evidence: OwnerLaunchEvidenceV2;
      selectedLaunchPhase?: Awaited<ReturnType<typeof writeSelectedLaunchPhase>>;
    }>,
    readonly disposal: PromiseSettledResult<void>,
  ) {
    super('owner_post_exec_handoff_failed', { cause });
    this.name = 'OwnerPostExecHandoffError';
  }
}
