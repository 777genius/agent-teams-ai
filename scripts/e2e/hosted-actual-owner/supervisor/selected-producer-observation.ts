import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import type { ProcessExitEvidence, ProcessStartEvidence, SupervisorPlan } from '../processes';
import { canonicalJson, sha256 } from './canonical';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { assertSelectedProcessHandle, type SelectedProcessHandle } from './selected-kernel';
import { executingImage, processIdentity } from './selected-process-observation';

type DirectRole = 'opencode' | 'product' | 'browser';
const observations = new WeakMap<object, SelectedProcessHandle>();
const exits = new WeakMap<object, SelectedProcessHandle>();
const observationAttempts = new WeakSet<SelectedProcessHandle>();
const admittedRoles = new WeakMap<SelectedPlanAdmission, Set<DirectRole>>();
const observedExits = new WeakSet<ProcessStartEvidence>();
function check(value: unknown): asserts value { if (!value) throw new Error('selected_producer_observation'); }

function readProc(pid: number, leaf: 'cmdline' | 'environ', maximum: number): Buffer {
  const fd = openSync(`/proc/${pid}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(maximum + 1);
  try {
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    check(length > 0 && length <= maximum && bytes[length - 1] === 0);
    return Buffer.from(bytes.subarray(0, length));
  } finally { bytes.fill(0); closeSync(fd); }
}

function assertOwned(pid: number, plan: SupervisorPlan): void {
  const bytes = readProc(pid, 'environ', 1024 * 1024);
  const expected = Buffer.from(`${plan.processOwnership.environmentKey}=${plan.processOwnership.marker}`);
  try {
    let offset = 0, matches = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(0, offset); check(end >= offset);
      if (bytes.subarray(offset, end).equals(expected)) matches++;
      offset = end + 1;
    }
    check(matches === 1);
  } finally { bytes.fill(0); expected.fill(0); }
}

/** Observe the direct children actually spawned by the selected Node. Owner's
 * native-helper child and Chromium descendants have different lineage and
 * cannot obtain this receipt. No plan-supplied PID/start/evidence is accepted. */
export async function observeSelectedDirectProducer(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  role: DirectRole, handle: SelectedProcessHandle, signal: AbortSignal): Promise<ProcessStartEvidence> {
  assertSelectedPlanAdmission(admission, plan);
  assertSelectedProcessHandle(handle);
  const descriptor = plan.supervisorAdmissionDescriptor;
  check(descriptor && !handle.isExited());
  const steps = plan.startSchedule.filter(step => step.role === role);
  check(steps.length === 1);
  signal.throwIfAborted();
  const roles = admittedRoles.get(admission) ?? new Set<DirectRole>();
  check(!observationAttempts.has(handle) && !roles.has(role));
  // Reserve before the first asynchronous image read. A failed observation is
  // terminal for this scheduled start; retries must not mint another identity
  // or substitute a second child for the one admitted instance.
  observationAttempts.add(handle);
  roles.add(role);
  admittedRoles.set(admission, roles);
  const step = steps[0];
  const before = processIdentity(handle.pid);
  check(before.startTicks === handle.startTicks && before.parentPid === admission.process.pid &&
    before.pidNamespaceInode === admission.process.pidNamespaceInode &&
    before.mountNamespaceInode === admission.process.mountNamespaceInode &&
    before.networkNamespaceInode === admission.process.networkNamespaceInode);
  assertOwned(handle.pid, plan);
  const executable = role === 'opencode' ? descriptor.openCode.linuxX64Binary : descriptor.toolchain.node;
  const executablePath = role === 'opencode' ? '/opencode' : `/toolchain/${executable.relativePath}`;
  const expectedArgv = [executablePath, ...plan.expectedArgv[role]];
  const argvBytes = readProc(handle.pid, 'cmdline', 64 * 1024);
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(argvBytes);
    check(canonicalJson(source.slice(0, -1).split('\0')) === canonicalJson(expectedArgv));
  } finally { argvBytes.fill(0); }
  const cwd = statSync(`/proc/${handle.pid}/cwd`, { bigint: true });
  check(cwd.isDirectory() && String(cwd.dev) === plan.expectedCwd[role].device &&
    String(cwd.ino) === plan.expectedCwd[role].inode);
  const image = await executingImage(handle.pid, executable, signal);
  signal.throwIfAborted();
  assertSelectedPlanAdmission(admission, plan);
  assertSelectedProcessHandle(handle);
  assertOwned(handle.pid, plan);
  const after = processIdentity(handle.pid);
  const currentArgv = readProc(handle.pid, 'cmdline', 64 * 1024);
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(currentArgv);
    check(canonicalJson(source.slice(0, -1).split('\0')) === canonicalJson(expectedArgv));
  } finally { currentArgv.fill(0); }
  const currentCwd = statSync(`/proc/${handle.pid}/cwd`, { bigint: true });
  const currentImage = statSync(`/proc/${handle.pid}/exe`, { bigint: true });
  check(!handle.isExited() && canonicalJson(after) === canonicalJson(before) &&
    currentCwd.dev === cwd.dev && currentCwd.ino === cwd.ino &&
    String(currentImage.dev) === image.device && String(currentImage.ino) === image.inode);
  const evidence = Object.freeze<ProcessStartEvidence>({ role, instanceId: step.instanceId,
    generation: step.generation, restartBoundary: step.restartBoundary,
    pid: handle.pid, pidfdInode: handle.pidfdInode, startTime: handle.startTicks,
    observedMonotonicNs: process.hrtime.bigint().toString(), startToken: randomBytes(32).toString('hex'),
    parentStartToken: admission.process.processStartToken, observerStartToken: admission.process.processStartToken,
    executableDevice: image.device, executableInode: image.inode, executableSha256: image.sha256,
    argvSha256: sha256(canonicalJson(plan.expectedArgv[role])), cwdDevice: String(cwd.dev), cwdInode: String(cwd.ino) });
  observations.set(evidence, handle);
  return evidence;
}

export function assertSelectedDirectProducerObservation(evidence: ProcessStartEvidence, handle: SelectedProcessHandle): void {
  assertSelectedProcessHandle(handle);
  check(observations.get(evidence) === handle && evidence.pid === handle.pid &&
    evidence.startTime === handle.startTicks && evidence.pidfdInode === handle.pidfdInode);
}

/** Called after the actual child wait. A live pidfd, deserialized start, or
 * cleanup promise alone cannot produce an exit receipt. */
export function observeSelectedDirectProducerExit(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  start: ProcessStartEvidence, handle: SelectedProcessHandle): ProcessExitEvidence {
  assertSelectedPlanAdmission(admission, plan);
  assertSelectedDirectProducerObservation(start, handle);
  check(!observedExits.has(start) && handle.isExited() &&
    start.observerStartToken === admission.process.processStartToken);
  const exit = Object.freeze<ProcessExitEvidence>({ startToken: start.startToken,
    pidfdInode: handle.pidfdInode, observedMonotonicNs: process.hrtime.bigint().toString(),
    observerStartToken: admission.process.processStartToken, disposition: 'controlled-exit' });
  check(BigInt(exit.observedMonotonicNs) > BigInt(start.observedMonotonicNs));
  observedExits.add(start);
  exits.set(exit, handle);
  return exit;
}

export function assertSelectedDirectProducerExit(exit: ProcessExitEvidence, handle: SelectedProcessHandle): void {
  assertSelectedProcessHandle(handle);
  check(exits.get(exit) === handle && handle.isExited());
}
