import { closeSync, constants, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { retainSelectedProcess, type SelectedKernel, type SelectedProcessHandle } from './selected-kernel';
import { processIdentity } from './selected-process-observation';

export const SELECTED_PROCESS_LIFETIME = 'P3C_SELECTED_PROCESS_LIFETIME';
function check(value: unknown): asserts value { if (!value) throw new Error('selected_process_drain_unproven'); }
function hasMarker(pid: number, marker: string): boolean {
  const fd = openSync(`/proc/${pid}/environ`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  try {
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break; length += count;
    }
    check(length <= 1024 * 1024);
    const expected = Buffer.from(`${SELECTED_PROCESS_LIFETIME}=${marker}`);
    let offset = 0, found = false;
    while (offset < length) {
      const end = bytes.indexOf(0, offset); check(end >= offset && end < length);
      if (bytes.subarray(offset, end).equals(expected)) { check(!found); found = true; }
      offset = end + 1;
    }
    return found;
  } finally { bytes.fill(0); closeSync(fd); }
}
function churn(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
/** A distinct per-child lifetime marker, plus its exact namespace and retained
 * pidfds, limits cleanup to that selected subtree. No negative process-group
 * signals and no numeric-PID signalling occur. Full final namespace census is
 * still required before the enclosing supervisor can claim zero survivors. */
export async function drainSelectedProcess(kernel: SelectedKernel, root: SelectedProcessHandle,
  marker: string, namespaceInode: string, graceMs = 5000) {
  check(/^[0-9a-f]{64}$/u.test(marker) && /^[0-9]+$/u.test(namespaceInode) &&
    Number.isSafeInteger(graceMs) && graceMs > 0 && graceMs <= 30_000);
  const owned = new Map<string, SelectedProcessHandle>();
  const observations: { pid: number; startTicks: string; pidfdInode: string; observedMonotonicNs: string }[] = [];
  const observed = new Set<SelectedProcessHandle>();
  const markExit = (handle: SelectedProcessHandle) => {
    if (!observed.has(handle) && handle.isExited()) {
      observed.add(handle); observations.push({ pid: handle.pid, startTicks: handle.startTicks,
        pidfdInode: handle.pidfdInode, observedMonotonicNs: process.hrtime.bigint().toString() });
    }
  };
  const scan = () => {
    const pids = readdirSync('/proc').filter(value => /^[1-9][0-9]*$/u.test(value));
    check(pids.length <= 4096);
    for (const text of pids) {
      const pid = Number(text);
      if (pid === process.pid || pid === 1 || pid === root.pid) continue;
      try {
        if (String(statSync(`/proc/${pid}/ns/pid`, { bigint: true }).ino) !== namespaceInode || !hasMarker(pid, marker)) continue;
        const handle = retainSelectedProcess(kernel, pid);
        let retained = false;
        try {
          // The prefilter precedes pidfd acquisition. Reobserve its authority
          // under the retained start identity so PID reuse in that interval
          // cannot authorize signalling an unrelated replacement process.
          const before = processIdentity(pid);
          check(before.startTicks === handle.startTicks && before.pidNamespaceInode === namespaceInode);
          check(hasMarker(pid, marker));
          const after = processIdentity(pid);
          check(after.startTicks === handle.startTicks && after.pidNamespaceInode === namespaceInode);
          const identity = `${pid}:${handle.startTicks}`;
          if (!owned.has(identity)) { owned.set(identity, handle); retained = true; }
        } finally { if (!retained) handle.close(); }
      } catch (error) { if (!churn(error)) throw error; }
    }
  };
  try {
    for (const signal of [15, 9] as const) {
      const until = performance.now() + graceMs;
      const signalled = new Set<SelectedProcessHandle>();
      do {
        scan();
        for (const handle of [root, ...owned.values()]) {
          if (!handle.isExited() && !signalled.has(handle)) { handle.signal(signal); signalled.add(handle); }
          markExit(handle);
        }
        if (root.isExited() && [...owned.values()].every(handle => handle.isExited())) {
          // Repeat the census after the root exit: newly orphaned marked
          // children must be retained/signalled before resolving this drain.
          const count = owned.size; scan();
          if (owned.size === count && [...owned.values()].every(handle => handle.isExited())) {
            for (const handle of [root, ...owned.values()]) markExit(handle);
            return Object.freeze(observations.map(row => Object.freeze(row)));
          }
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      } while (performance.now() < until);
    }
    throw new Error('selected_process_drain_unproven');
  } finally { for (const handle of owned.values()) handle.close(); }
}
