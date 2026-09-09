import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import type { FilePin } from '../contracts';
import { canonicalJson } from './canonical';
import { readReadonlyArtifact } from './readonly-artifact';
import type { SelectedSupervisorInvocation } from './selected-invocation';

const observedSelections = new WeakMap<object, string>();
export type SelectedSupervisorProcessObservation = Awaited<ReturnType<typeof observeSelectedSupervisor>>;

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_supervisor_observation_${reason}`);
}

export function processIdentity(pid: number) {
  const fd = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    check(length > 0 && length <= 8192, 'stat_bound');
    source = bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
  const end = source.lastIndexOf(') ');
  check(source.startsWith(`${pid} (`) && end > 0, 'stat_frame');
  const fields = source.slice(end + 2).trim().split(/\s+/u);
  check(fields[0] !== 'Z' && fields[0] !== 'X' && /^(?:0|[1-9][0-9]*)$/u.test(fields[1]) &&
    /^[1-9][0-9]*$/u.test(fields[19]), 'process_live');
  return Object.freeze({ pid, parentPid: Number(fields[1]), startTicks: fields[19],
    pidNamespaceInode: String(statSync(`/proc/${pid}/ns/pid`, { bigint: true }).ino),
    mountNamespaceInode: String(statSync(`/proc/${pid}/ns/mnt`, { bigint: true }).ino),
    networkNamespaceInode: String(statSync(`/proc/${pid}/ns/net`, { bigint: true }).ino),
  });
}

export async function executingImage(pid: number, pin: FilePin, signal: AbortSignal) {
  check(Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 1024 ** 3 &&
    /^[0-9a-f]{64}$/u.test(pin.sha256), 'image_pin');
  const fd = openSync(`/proc/${pid}/exe`, constants.O_RDONLY);
  try {
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.uid === 0n && before.gid === 0n && before.nlink === 1n &&
      before.size === BigInt(pin.size) && String(before.dev) === pin.device && String(before.ino) === pin.inode &&
      Number(before.mode & 0o7777n) === pin.mode, 'image_identity');
    const hash = createHash('sha256');
    let count = 0;
    for await (const part of createReadStream('', { fd, autoClose: false, start: 0, end: pin.size - 1,
      highWaterMark: 64 * 1024, signal })) {
      count += (part as Buffer).length; hash.update(part as Buffer);
    }
    const after = fstatSync(fd, { bigint: true });
    const digest = hash.digest('hex');
    check(count === pin.size && digest === pin.sha256 && before.dev === after.dev &&
      before.ino === after.ino && before.size === after.size && before.mode === after.mode &&
      before.nlink === after.nlink && before.uid === after.uid && before.gid === after.gid &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'image_changed');
    return Object.freeze({ device: String(after.dev), inode: String(after.ino),
      size: String(after.size), sha256: digest });
  } finally { closeSync(fd); }
}

/** Called once by the selected Node entry before preparing Owner inputs. The
 * namespace PID1 is the actual native launcher image; Node is its direct child.
 * Neither an expected JSON process record nor the later FD5 prelude is used as
 * the observation source. Outer host PID/start joins remain a separate receipt. */
export async function observeSelectedSupervisor(
  invocation: SelectedSupervisorInvocation,
  signal: AbortSignal,
) {
  const selected = structuredClone(invocation);
  signal.throwIfAborted();
  check(process.platform === 'linux' && !process.versions.bun && process.getuid?.() === 0 &&
    process.getgid?.() === 0 && process.pid > 1 && process.ppid === 1, 'runtime');
  const nodePath = `/toolchain/${selected.executable.relativePath}`;
  const loaderPath = `/toolchain/${selected.loader.relativePath}`;
  const modulePath = `/p3b2/${selected.module.relativePath}`;
  check(canonicalJson(process.argv) === canonicalJson([nodePath, modulePath, '--selected-supervisor-v1']) &&
    canonicalJson(process.execArgv) === canonicalJson(['--import', loaderPath]), 'argv');
  const before = processIdentity(process.pid), initBefore = processIdentity(1);
  check(before.parentPid === 1 && initBefore.parentPid === 0 &&
    before.pidNamespaceInode === initBefore.pidNamespaceInode &&
    before.mountNamespaceInode === initBefore.mountNamespaceInode &&
    before.networkNamespaceInode === initBefore.networkNamespaceInode, 'namespace_parent');
  const executable = await executingImage(process.pid, selected.executable, signal);
  const launcherExecutable = await executingImage(1, selected.launcher, signal);
  const roots: number[] = [];
  try {
    const p3b2 = openSync('/p3b2', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    roots.push(p3b2);
    const toolchain = openSync('/toolchain', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    roots.push(toolchain);
    readReadonlyArtifact(p3b2, selected.module, 32 * 1024 * 1024);
    readReadonlyArtifact(toolchain, selected.loader, 32 * 1024 * 1024);
    const current = processIdentity(process.pid), initCurrent = processIdentity(1);
    const currentImage = statSync('/proc/self/exe', { bigint: true });
    const initImage = statSync('/proc/1/exe', { bigint: true });
    check(canonicalJson(current) === canonicalJson(before) &&
      canonicalJson(initCurrent) === canonicalJson(initBefore) &&
      String(currentImage.dev) === executable.device && String(currentImage.ino) === executable.inode &&
      String(initImage.dev) === launcherExecutable.device && String(initImage.ino) === launcherExecutable.inode,
    'process_changed');
    signal.throwIfAborted();
    const observation = Object.freeze({
      contract: 'agent-teams.hosted-selected-supervisor-process/v1' as const,
      ...current,
      processStartToken: randomBytes(32).toString('hex'),
      observedMonotonicNs: process.hrtime.bigint().toString(),
      executable,
      module: Object.freeze({ path: modulePath, ...selected.module }),
      loader: Object.freeze({ path: loaderPath, ...selected.loader }),
      namespaceInit: Object.freeze({ ...initCurrent, executable: launcherExecutable }),
    });
    observedSelections.set(observation, canonicalJson(selected));
    return observation;
  } finally {
    const failures: unknown[] = [];
    for (const fd of roots.reverse()) {
      try { closeSync(fd); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'selected_supervisor_root_close');
  }
}

/** A deserialized expected observation cannot stand in for the live entry's
 * retained receipt. Check the process again when each Owner generation starts. */
export function assertSelectedSupervisorObservation(
  observation: SelectedSupervisorProcessObservation,
  invocation: SelectedSupervisorInvocation,
): void {
  check(observation && observedSelections.get(observation) === canonicalJson(invocation), 'receipt');
  const current = processIdentity(process.pid), init = processIdentity(1);
  check(current.pid === observation.pid && current.parentPid === observation.parentPid &&
    current.startTicks === observation.startTicks &&
    current.pidNamespaceInode === observation.pidNamespaceInode &&
    current.mountNamespaceInode === observation.mountNamespaceInode &&
    current.networkNamespaceInode === observation.networkNamespaceInode &&
    init.startTicks === observation.namespaceInit.startTicks && init.parentPid === 0 &&
    init.pidNamespaceInode === current.pidNamespaceInode &&
    init.mountNamespaceInode === current.mountNamespaceInode &&
    init.networkNamespaceInode === current.networkNamespaceInode, 'receipt_currentness');
  const node = statSync('/proc/self/exe', { bigint: true });
  const launcher = statSync('/proc/1/exe', { bigint: true });
  check(String(node.dev) === observation.executable.device && String(node.ino) === observation.executable.inode &&
    String(launcher.dev) === observation.namespaceInit.executable.device &&
    String(launcher.ino) === observation.namespaceInit.executable.inode, 'receipt_images');
}
