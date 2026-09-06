import { randomBytes, createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, constants } from 'node:fs';

import type { SupervisorPlan } from '../processes';
import { canonicalJson, sha256 } from './canonical';
import { assembleOwnerBootstrap, type AssembleBootstrapInput, type AssembledBootstrap } from './bootstrap-v2';
import { launchNativeOwner, type NativeLaunchOptions } from './native-launch';
import { descriptorMap, OWNER_ROLES, wrapperStartToken, type HeldOwner } from './native-protocol';

export { launchNativeOwner, OwnerLaunchError } from './native-launch';
export type { InheritedImage, NativeOwnerLaunch } from './native-launch';
export { assembleOwnerBootstrap } from './bootstrap-v2';
export type { BootstrapCommon, ExpectedSupervisedOpenCode, RawRetentionBinding } from './bootstrap-v2';

export interface LaunchOwnerFromPlanOptions {
  readonly plan: SupervisorPlan & {
    /** Admitted source invocation: selected runtime image and selected immutable module are distinct.
     * The caller must verify this exact path/digest pair before maintaining the read-only closure. */
    readonly ownerSourceInvocation?: {
      readonly format: 'agent-teams.hosted-owner-source-invocation/v1';
      readonly executable: { readonly device: string; readonly inode: string; readonly sha256: string };
      readonly module: { readonly path: string; readonly sha256: string };
    };
  };
  readonly handles: Pick<NativeLaunchOptions, 'helper' | 'executable' | 'cwdFd' | 'rawFd' | 'walFd'>;
  /** Comes from the selected supervisor start record, not from the Owner frame. */
  readonly supervisorProcessStartToken: string;
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
  let prefix: readonly string[] = [];
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
    prefix = ['run', invocation.modulePath];
  }
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
  let digests: AssembledBootstrap['digests'] | undefined;
  const launch = await launchNativeOwner({ ...handles, signal: options.signal,
    argv: ['/proc/self/fd/11', ...prefix, '--hosted-actual-owner-sealed-protocol=v2', '--runtime-manifest', '/sandbox/runtime-manifest.json'],
    environment: { ...options.environment, P3C_PROCESS_OWNERSHIP_MARKER: plan.processOwnership.marker,
      [provenance.environment]: capsule },
    assemble(held) {
      const assembled = assembleOwnerBootstrap({ ...bootstrap, held, supervisorBinding: {
        supervisorPid: held.callerPid, supervisorStartTicks: held.callerStartTicks,
        supervisorStartToken: options.supervisorProcessStartToken, supervisorExecutableSha256: plan.expectedExecutableSha256.supervisor,
        recipeSha256: options.recipeSha256, ownerEntrySha256: entrySha256, ownerPid: held.ownerPid,
        ownerStartTicks: held.ownerStartTicks, ownerProcessStartToken, harnessContractSha256: options.harnessContractSha256,
        ownerProducerCapsuleSha256: sha256(capsule) } });
      digests = assembled.digests; return assembled;
    } });
  return Object.freeze({ ...launch, ownerProcessStartToken, digests: digests!, descriptorMap: descriptorMap(launch.held),
    parentCleanup: parentCleanup(launch.held, ownerProcessStartToken) });
}
