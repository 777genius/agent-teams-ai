/** Root-side observation of the namespace-entry -> PID1 -> selected Node
 * chain. This binds a namespace-local transcript PID to the exact host child;
 * an IPC-supplied PID/start alone is never a transcript receipt. */
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SupervisorPlan } from '../processes';
import type { FilePin } from '../contracts';
import { canonicalJson, exactRecord } from './canonical';

function check(value: unknown): asserts value { if (!value) throw new Error('selected_controller_process_rejected'); }
function read(path: string, maximum = 8192): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break; length += count;
    }
    check(length <= maximum); return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function children(pid: number): number[] {
  const source = read(`/proc/${pid}/task/${pid}/children`).toString('utf8').trim();
  const rows = source ? source.split(/\s+/u) : [];
  check(rows.length <= 16 && rows.every(row => /^[1-9][0-9]{0,9}$/u.test(row)));
  return rows.map(Number);
}
function identity(pid: number) {
  const text = read(`/proc/${pid}/stat`).toString('utf8');
  const end = text.lastIndexOf(') '); check(text.startsWith(`${pid} (`) && end > 0);
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  check(fields[0] !== 'Z' && fields[0] !== 'X' && /^[1-9][0-9]*$/u.test(fields[19]));
  const nspid = /^NSpid:\s+([0-9\t ]+)$/mu.exec(read(`/proc/${pid}/status`, 64 * 1024).toString('utf8'));
  check(nspid);
  return { hostPid: pid, parentPid: Number(fields[1]), startTime: fields[19],
    namespacePids: nspid[1].trim().split(/\s+/u).map(Number),
    pidNamespace: String(statSync(`/proc/${pid}/ns/pid`, { bigint: true }).ino),
    networkNamespace: String(statSync(`/proc/${pid}/ns/net`, { bigint: true }).ino),
    mountNamespace: String(statSync(`/proc/${pid}/ns/mnt`, { bigint: true }).ino) };
}

/** Inspect the module/loader through this process's actual namespace root.
 * A matching Node executable alone does not prove the selected JS closure is
 * still present. Paths/pins come from the root-admitted plan, never IPC data. */
function assertNamespaceModule(hostPid: number, mount: 'p3b2' | 'toolchain', pin: FilePin): void {
  check(pin.root === mount && Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 32 * 1024 * 1024);
  const parts = pin.relativePath.split('/');
  check(parts.length > 0 && parts.every(part => part && part !== '.' && part !== '..' &&
    !part.includes('\\') && !part.includes('\0')));
  const owned: number[] = [];
  try {
    // /proc/<pid>/root is a kernel-owned magic link, not an input path.
    let parent = openSync(`/proc/${hostPid}/root/${mount}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    owned.push(parent);
    const mounts = read(`/proc/${hostPid}/mountinfo`, 1024 * 1024).toString('utf8');
    for (let index = 0; index < parts.length; index++) {
      const directory = index !== parts.length - 1;
      const fd = openSync(`/proc/self/fd/${parent}/${parts[index]}`, constants.O_RDONLY |
        constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
      owned.push(fd);
      const before = fstatSync(fd, { bigint: true });
      check(before.uid === 0n && before.gid === 0n && !(before.mode & 0o022n));
      const mountId = /^mnt_id:\s+([0-9]+)$/mu.exec(read(`/proc/self/fdinfo/${fd}`).toString('utf8'))?.[1];
      const rows = mounts.split('\n').filter(row => row.startsWith(`${mountId} `));
      check(mountId && rows.length === 1 && rows[0].split(' ')[5]?.split(',').includes('ro'));
      if (directory) { check(before.isDirectory()); parent = fd; continue; }
      check(before.isFile() && before.nlink === 1n && before.size === BigInt(pin.size) &&
        String(before.dev) === pin.device && String(before.ino) === pin.inode &&
        Number(before.mode & 0o7777n) === pin.mode);
      const buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
      let offset = 0;
      try {
        while (offset < pin.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, pin.size - offset), offset);
          check(count > 0); hash.update(buffer.subarray(0, count)); offset += count;
        }
      } finally { buffer.fill(0); }
      const after = fstatSync(fd, { bigint: true });
      check(hash.digest('hex') === pin.sha256 && before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mode === after.mode && before.nlink === after.nlink &&
        before.uid === after.uid && before.gid === after.gid &&
        before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
    }
  } finally {
    const failures: unknown[] = [];
    for (const fd of owned.reverse()) { try { closeSync(fd); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'selected_controller_module_close');
  }
}
export async function observeSelectedControllerProcess(launcherPid: number, plan: SupervisorPlan,
  observation: unknown, signal: AbortSignal) {
  const claimed = exactRecord(observation, ['pid', 'startTicks'], 'selected_controller_process');
  check(Number.isSafeInteger(claimed.pid) && Number(claimed.pid) > 1 && typeof claimed.startTicks === 'string');
  const launcherBefore = identity(launcherPid);
  const initPids = children(launcherPid); check(initPids.length === 1);
  const init = identity(initPids[0]);
  check(init.parentPid === launcherPid && init.namespacePids.at(-1) === 1 &&
    init.pidNamespace !== launcherBefore.pidNamespace);
  const nodes = children(init.hostPid); check(nodes.length === 1);
  const node = identity(nodes[0]);
  check(node.parentPid === init.hostPid && node.namespacePids.at(-1) === claimed.pid && node.startTime === claimed.startTicks &&
    node.pidNamespace === init.pidNamespace && node.networkNamespace === init.networkNamespace &&
    node.mountNamespace === init.mountNamespace);
  const invocation = plan.supervisorSourceInvocation; check(invocation);
  const argv = read(`/proc/${node.hostPid}/cmdline`, 32 * 1024).toString('utf8').split('\0');
  check(argv.pop() === '' && canonicalJson(argv) === canonicalJson([
    `/toolchain/${invocation.executable.relativePath}`, ...plan.expectedArgv.supervisor]));
  const fd = openSync(`/proc/${node.hostPid}/exe`, constants.O_RDONLY);
  try {
    const before = fstatSync(fd, { bigint: true }), pin = invocation.executable;
    check(before.isFile() && String(before.dev) === pin.device && String(before.ino) === pin.inode &&
      before.size === BigInt(pin.size) && Number(before.mode & 0o7777n) === pin.mode && before.nlink === 1n);
    const hash = createHash('sha256'); let length = 0;
    for await (const bytes of createReadStream('', { fd, autoClose: false, start: 0, end: pin.size - 1, signal })) {
      hash.update(bytes as Buffer); length += (bytes as Buffer).length;
    }
    const after = fstatSync(fd, { bigint: true });
    assertNamespaceModule(node.hostPid, 'p3b2', invocation.module);
    assertNamespaceModule(node.hostPid, 'toolchain', invocation.loader);
    check(length === pin.size && hash.digest('hex') === pin.sha256 && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      canonicalJson(identity(node.hostPid)) === canonicalJson(node) &&
      canonicalJson(identity(init.hostPid)) === canonicalJson(init) &&
      canonicalJson(identity(launcherPid)) === canonicalJson(launcherBefore));
  } finally { closeSync(fd); }
  return Object.freeze({ pid: Number(claimed.pid), startTime: node.startTime, hostPid: node.hostPid,
    launcherHostPid: launcherPid, namespaceInitHostPid: init.hostPid });
}
