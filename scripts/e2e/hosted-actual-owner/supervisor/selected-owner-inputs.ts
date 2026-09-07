import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import type { SupervisorPlan } from '../processes';
import type { LaunchOwnerFromPlanOptions, launchOwnerFromPlan } from './index';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';

type OwnerLaunch = Awaited<ReturnType<typeof launchOwnerFromPlan>>;

/** Prepared by the actual OpenCode/bootstrap/raw-custody operations. Descriptor
 * ownership transfers to this scope; these are not expected-result fixtures. */
export interface PreparedSelectedOwnerInputs {
  readonly rawFd: number;
  readonly walFd: number;
  readonly bootstrap: LaunchOwnerFromPlanOptions['bootstrap'];
  readonly environment: LaunchOwnerFromPlanOptions['environment'];
  readonly activationHandleIpc: NonNullable<LaunchOwnerFromPlanOptions['activationHandleIpc']>;
}

/** Concrete input-resource operation for SelectedScheduleOperations. Borrowed
 * helper/Owner/cwd descriptors close after launch settles. Raw/WAL writers close
 * here only if the actual native ownership boundary was never crossed. */
export async function withSelectedOwnerInputs(
  plan: SupervisorPlan,
  admission: SelectedPlanAdmission,
  prepared: PreparedSelectedOwnerInputs,
  run: (inputs: LaunchOwnerFromPlanOptions) => Promise<OwnerLaunch>,
): Promise<OwnerLaunch> {
  const rawFd = prepared.rawFd, walFd = prepared.walFd;
  if (![rawFd, walFd].every(fd => Number.isSafeInteger(fd) && fd >= 3) || rawFd === walFd) {
    throw new Error('selected_owner_input_writer_numbers');
  }
  const retainedWriters = new Set([rawFd, walFd]);
  const borrowed: number[] = [];
  let bootstrap: LaunchOwnerFromPlanOptions['bootstrap'] | undefined;
  let failed = false;
  let failure: unknown;
  try {
    // Check writer slots before allocating any descriptor: a stale number must
    // not become an alias for a newly opened image or proc observation handle.
    const raw = fstatSync(rawFd, { bigint: true }), wal = fstatSync(walFd, { bigint: true });
    if (!raw.isFile() || !wal.isFile() || raw.nlink !== 1n || wal.nlink !== 1n ||
      (raw.dev === wal.dev && raw.ino === wal.ino)) {
      throw new Error('selected_owner_input_writer_identity');
    }
    // This is synchronous and precedes every resource await. It does not clone
    // the internal admission receipt or a live Product ChildProcess.
    assertSelectedPlanAdmission(admission, plan);
    const selectedPlan = structuredClone(plan);
    bootstrap = structuredClone(prepared.bootstrap);
    const environment = Object.freeze({ ...prepared.environment });
    const activationHandleIpc = Object.freeze({ ...prepared.activationHandleIpc,
      selectedArtifacts: Object.freeze({ ...prepared.activationHandleIpc.selectedArtifacts }),
    });
    const source = selectedPlan.ownerSourceInvocation, helperPin = selectedPlan.ownerLaunchHelper;
    if (!source || !helperPin || !selectedPlan.supervisorAdmissionDescriptor ||
      !selectedPlan.startSchedule.some(step => step.role === 'owner' &&
        step.generation === bootstrap!.common.ownerGeneration)) {
      throw new Error('selected_owner_input_selection');
    }
    const helperFd = openSync(`/p3b2/${helperPin.relativePath}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    borrowed.push(helperFd);
    // The executable FilePin comes from the already verified recipe, not from
    // the source-module path (which identifies a different file).
    const executablePin = admission.ownerExecutable;
    const ownerFd = openSync(`/p3b2/${executablePin.relativePath}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    borrowed.push(ownerFd);
    const cwdFd = openSync('/sandbox/project', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    borrowed.push(cwdFd);
    const cwd = fstatSync(cwdFd, { bigint: true });
    if (String(cwd.dev) !== selectedPlan.expectedCwd.owner.device ||
      String(cwd.ino) !== selectedPlan.expectedCwd.owner.inode) {
      throw new Error('selected_owner_input_cwd');
    }
    return await run({
      plan: selectedPlan,
      handles: { helper: { fd: helperFd, pin: helperPin }, executable: { fd: ownerFd, pin: executablePin },
        cwdFd, rawFd, walFd },
      onWriterOwnershipTaken: () => { retainedWriters.clear(); },
      selectedPlanAdmission: admission,
      selectedSupervisorObservation: admission.process,
      supervisorProcessStartToken: admission.process.processStartToken,
      recipeSha256: admission.recipe.sha256,
      harnessContractSha256: selectedPlan.ownerHarnessContractSha256!,
      bootstrap,
      invocation: { kind: 'source-bun', modulePath: source.module.path, moduleSha256: source.module.sha256 },
      environment,
      activationHandleIpc,
    });
  } catch (error) {
    failed = true; failure = error;
    throw error;
  } finally {
    // Erase only our copies, never the caller's retained bootstrap evidence.
    bootstrap?.key.fill(0);
    bootstrap?.serializedProductBootstrap.fill(0);
    const failures: unknown[] = [];
    for (const fd of [...retainedWriters, ...borrowed.reverse()]) {
      try { closeSync(fd); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      throw new AggregateError(failed ? [failure, ...failures] : failures,
        'selected_owner_input_cleanup', failed ? { cause: failure } : undefined);
    }
  }
}
