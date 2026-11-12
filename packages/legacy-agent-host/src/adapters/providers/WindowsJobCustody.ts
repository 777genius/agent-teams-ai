import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { verifyOpenCodeV2EmbeddedGraph } from './OpenCodeV2EmbeddedGraph.js';
import { createWindowsJobKernel } from './WindowsJobKernel.js';

import type { ChildProcess } from 'node:child_process';
import type { CapturedProcessTreeSource } from './CapturedProcess.js';
import type { OpenCodeV2EmbeddedSelection } from './OpenCodeV2EmbeddedGraph.js';
import type { WindowsHandle, WindowsJobKernel } from './WindowsJobKernel.js';

const unavailable = (): never => { throw new Error('Windows process custody unavailable'); };
const kernels = new Map<string, { sha256: string; kernel: WindowsJobKernel }>();
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** Retain only the original process handle and its private Job Object. No PID re-adoption. */
export function createWindowsJobCustodyForKernel(kernel: WindowsJobKernel): CapturedProcessTreeSource {
  const captured = new WeakSet<ChildProcess>();
  return Object.freeze({
    capture(child: ChildProcess, executable: { path: string; sha256: string }) {
      if (captured.has(child) || !Number.isSafeInteger(child.pid) || !child.pid
        || child.exitCode !== null || child.signalCode !== null) return unavailable();
      captured.add(child);
      const pid = child.pid, expected = Object.freeze({ ...executable });
      let process: WindowsHandle | undefined, job: WindowsHandle | undefined;
      try {
        // Called synchronously from spawn before the first yield. libuv still
        // holds the original hProcess, so the PID cannot be reused in this gap.
        process = kernel.openProcess(pid);
        if (!kernel.alive(process)) return unavailable();
        const original = kernel.readProcess(process);
        if (original.pid !== pid || !/^[1-9]\d*$/.test(original.startIdentity)) return unavailable();
        const processHandle = process;
        let retired = false, broken = false, terminationRequested = false;
        const readExecutable = () => {
          if (retired || broken || !kernel.alive(processHandle)) return unavailable();
          const before = kernel.readProcess(processHandle);
          if (before.pid !== pid || before.startIdentity !== original.startIdentity
            || realpathSync(before.executablePath) !== expected.path) return unavailable();
          const file = lstatSync(expected.path);
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
            || realpathSync(expected.path) !== expected.path) return unavailable();
          const sha256 = digest(readFileSync(expected.path));
          const after = lstatSync(expected.path), nativeAfter = kernel.readProcess(processHandle);
          if (sha256 !== expected.sha256 || file.dev !== after.dev || file.ino !== after.ino
            || file.size !== after.size || file.mtimeMs !== after.mtimeMs || file.ctimeMs !== after.ctimeMs
            || nativeAfter.pid !== pid || nativeAfter.startIdentity !== original.startIdentity
            || nativeAfter.executablePath !== before.executablePath || !kernel.alive(processHandle))
            return unavailable();
          return { executablePath: expected.path, executableSha256: sha256,
            pid, startIdentity: original.startIdentity };
        };
        readExecutable();
        job = kernel.createJob();
        kernel.assign(job, processHandle);
        const jobHandle = job;
        if (!kernel.isMember(jobHandle, processHandle)) return unavailable();
        readExecutable();
        return Object.freeze({
          readExecutable() {
            if (retired || broken || !kernel.isMember(jobHandle, processHandle)) return unavailable();
            return readExecutable();
          },
          observe(): 'present' | 'absent' | 'unknown' {
            if (retired) return 'absent';
            if (broken) return 'unknown';
            try {
              const live = kernel.alive(processHandle), active = kernel.activeProcesses(jobHandle);
              if (!Number.isSafeInteger(active) || active < 0 || active > 0xffff_ffff) return 'unknown';
              if (live) return active > 0 && kernel.isMember(jobHandle, processHandle) ? 'present' : 'unknown';
              if (active > 0) return 'present';
              // Both original root and the whole job are absent. Each retained
              // handle is closed once; a failed close never permits handle reuse.
              let closed = true;
              for (const handle of [processHandle, jobHandle]) {
                try { kernel.close(handle); } catch { closed = false; }
              }
              if (!closed) { broken = true; return 'unknown'; }
              retired = true;
              return 'absent';
            } catch { return 'unknown'; }
          },
          terminate() {
            if (retired || broken || terminationRequested) return;
            terminationRequested = true;
            kernel.terminate(jobHandle);
          },
        });
      } catch (error) {
        // Closing an assigned kill-on-close job contains a failed launch. The
        // CapturedProcess owner also retains and stops its original ChildProcess.
        for (const handle of [job, process]) {
          if (handle) try { kernel.close(handle); } catch { /* Required capture remains rejected. */ }
        }
        throw error;
      }
    },
  });
}

/** Load only the selected, fully measured N-API binary; no require() fallback search. */
export async function createWindowsJobCustody(
  selection: OpenCodeV2EmbeddedSelection,
  signal?: AbortSignal
): Promise<CapturedProcessTreeSource> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) return unavailable();
  await verifyOpenCodeV2EmbeddedGraph(selection, signal);
  const packageName = `@yuuang/ffi-rs-win32-${process.arch}-msvc`;
  const packageDirectory = path.join(selection.directory, 'local-cli/node_modules', packageName);
  const entry = path.join(packageDirectory, `ffi-rs.win32-${process.arch}-msvc.node`);
  if (realpathSync(entry) !== entry) return unavailable();
  const info = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (info.name !== packageName || info.version !== '1.3.7') return unavailable();
  const before = lstatSync(entry), sha256 = digest(readFileSync(entry));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return unavailable();
  signal?.throwIfAborted();
  let selected = kernels.get(entry);
  if (selected && selected.sha256 !== sha256) return unavailable();
  if (!selected) {
    const binding: unknown = createRequire(import.meta.url)(entry);
    const after = lstatSync(entry);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || digest(readFileSync(entry)) !== sha256 || realpathSync(entry) !== entry) return unavailable();
    selected = { sha256, kernel: createWindowsJobKernel(binding, `agent-teams-windows-job-${digest(Buffer.from(entry))}`) };
    kernels.set(entry, selected);
  }
  return createWindowsJobCustodyForKernel(selected.kernel);
}
