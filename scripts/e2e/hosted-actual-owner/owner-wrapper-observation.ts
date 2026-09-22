import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import type { HeldOwner } from './supervisor/native-protocol';
import type { InheritedImage } from './supervisor/native-launch';

export interface OwnerWrapperObservation {
  readonly method: 'proc-stat-exe-ns';
  readonly pid: number;
  readonly parentPid: number;
  readonly startTicks: string;
  readonly observedMonotonicNs: string;
  readonly pidNamespaceInode: string;
  readonly networkNamespaceInode: string;
  readonly uid: number;
  readonly gid: number;
  readonly executable: { readonly device: string; readonly inode: string; readonly size: string; readonly sha256: string };
}
function check(value: unknown): asserts value {
  if (!value) throw new Error('p3c_owner_wrapper_observation');
}
function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  check(stat.startsWith(`${pid} (`) && stat.length <= 4096);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  check(fields[0] !== 'Z' && /^[1-9][0-9]*$/u.test(fields[1]) && /^[1-9][0-9]*$/u.test(fields[19]));
  return { parentPid: Number(fields[1]), startTicks: fields[19] };
}
/** Independent of the helper's claimed PID/start: called by its retained TS parent at the held barrier.
 * The helper's image is selected by the recipe. Only observations, never secrets, enter a transcript.
 */
export async function observeOwnerWrapper(held: HeldOwner, pin: InheritedImage['pin']): Promise<OwnerWrapperObservation> {
  check(held.callerPid === process.pid && held.parentPid !== process.pid && held.parentPid !== held.ownerPid);
  const before = processIdentity(held.parentPid);
  check(before.parentPid === process.pid && before.startTicks === held.parentStartTicks);
  const fd = openSync(`/proc/${held.parentPid}/exe`, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd, { bigint: true });
    check(stat.isFile() && stat.size === BigInt(pin.size) && stat.size > 0n && stat.size <= 1024n ** 3n &&
      String(stat.dev) === pin.device && String(stat.ino) === pin.inode && (stat.mode & 0o7777n) === 0o500n &&
      stat.nlink === 1n && Number(stat.uid) === process.getuid!() && Number(stat.gid) === process.getgid!());
    const hash = createHash('sha256'); let count = 0;
    for await (const part of createReadStream('', { fd, autoClose: false, start: 0, end: pin.size - 1 })) {
      hash.update(part as Buffer); count += (part as Buffer).length;
    }
    const digest = hash.digest('hex'), after = fstatSync(fd, { bigint: true });
    const current = processIdentity(held.parentPid);
    check(count === pin.size && digest === pin.sha256 && current.parentPid === before.parentPid &&
      current.startTicks === before.startTicks && after.dev === stat.dev && after.ino === stat.ino &&
      after.size === stat.size && after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs);
    const pidNamespaceInode = String(statSync(`/proc/${held.parentPid}/ns/pid`, { bigint: true }).ino);
    const networkNamespaceInode = String(statSync(`/proc/${held.parentPid}/ns/net`, { bigint: true }).ino);
    check(pidNamespaceInode === held.parentPidNamespaceInode && networkNamespaceInode === held.parentNetworkNamespaceInode);
    return Object.freeze({ method: 'proc-stat-exe-ns', pid: held.parentPid, parentPid: current.parentPid,
      startTicks: current.startTicks, observedMonotonicNs: String(process.hrtime.bigint()),
      pidNamespaceInode, networkNamespaceInode, uid: Number(stat.uid), gid: Number(stat.gid),
      executable: Object.freeze({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), sha256: digest }) });
  } finally { closeSync(fd); }
}

/** Hash the exact selected source module separately from the image executed on FD11. */
export async function observeSelectedOwnerModule(path: string, digest: string): Promise<void> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.nlink === 1n && (before.mode & 0o222n) === 0n &&
      before.uid === BigInt(process.getuid!()) && before.size > 0n && before.size <= 1024n ** 3n);
    const hash = createHash('sha256'); let count = 0;
    for await (const part of createReadStream('', { fd, autoClose: false, start: 0, end: Number(before.size) - 1 })) {
      hash.update(part as Buffer); count += (part as Buffer).length;
    }
    const after = fstatSync(fd, { bigint: true }), linked = statSync(path, { bigint: true });
    check(hash.digest('hex') === digest && count === Number(before.size) &&
      before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      linked.dev === before.dev && linked.ino === before.ino);
  } finally { closeSync(fd); }
}
