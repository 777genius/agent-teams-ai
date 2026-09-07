import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FilePin } from '../contracts';
import { readReadonlyArtifact } from './readonly-artifact';
import { processIdentity } from './selected-process-observation';

export interface SelectedKernel {
  pidfdOpen(pid: number): number;
  pidfdSendSignal(fd: number, signal: 0 | 15 | 9): boolean;
  pidfdExited(fd: number): boolean;
  probeOpenat2(rootFd: number): void;
}
const retainedProcesses = new WeakSet<object>();
export function assertSelectedProcessHandle(handle: SelectedProcessHandle): void {
  if (!retainedProcesses.has(handle)) throw new Error('selected_kernel_process_receipt');
}
export function loadSelectedKernel(pin: FilePin): SelectedKernel {
  if (pin.root !== 'p3b2' || !pin.relativePath.endsWith('.node')) throw new Error('selected_kernel_pin');
  const root = openSync('/p3b2', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const bytes = readReadonlyArtifact(root, pin, 32 * 1024 * 1024); bytes.fill(0);
    const value: unknown = createRequire('/p3b2/selected-entry.cjs')(`/p3b2/${pin.relativePath}`);
    for (const key of ['pidfdOpen', 'pidfdSendSignal', 'pidfdExited', 'probeOpenat2']) {
      if (!value || typeof value !== 'object' || typeof Reflect.get(value, key) !== 'function') throw new Error('selected_kernel_exports');
    }
    const kernel = Object.freeze(value) as SelectedKernel;
    kernel.probeOpenat2(root);
    return kernel;
  } finally { closeSync(root); }
}
/** The numeric PID is used only to acquire and verify a pidfd. Subsequent
 * signals/exits target the retained kernel handle, never a reused PID. */
export function retainSelectedProcess(kernel: SelectedKernel, pid: number) {
  const before = processIdentity(pid);
  const fd = kernel.pidfdOpen(pid);
  let closed = false;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (readlinkSync(`/proc/self/fd/${fd}`) !== 'anon_inode:[pidfd]' ||
      !new RegExp(`^Pid:\\s+${pid}$`, 'mu').test(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')) ||
      processIdentity(pid).startTicks !== before.startTicks || !kernel.pidfdSendSignal(fd, 0)) {
      throw new Error('selected_kernel_process_changed');
    }
    const handle = Object.freeze({ pid, startTicks: before.startTicks, pidfdInode: String(stat.ino),
      observedMonotonicNs: process.hrtime.bigint().toString(),
      isExited() { if (closed) throw new Error('selected_kernel_process_closed'); return kernel.pidfdExited(fd); },
      signal(signal: 15 | 9) { if (closed) throw new Error('selected_kernel_process_closed'); return kernel.pidfdSendSignal(fd, signal); },
      close() { if (closed) return; closed = true; retainedProcesses.delete(handle); closeSync(fd); },
    });
    retainedProcesses.add(handle);
    return handle;
  } catch (error) { closeSync(fd); throw error; }
}
export type SelectedProcessHandle = ReturnType<typeof retainSelectedProcess>;
