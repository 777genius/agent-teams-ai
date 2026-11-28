/** Closed kernel32 surface. No handle, function name or PID comes from IPC. */
export type WindowsHandle = object;
export interface WindowsProcessIdentity {
  pid: number;
  startIdentity: string;
  executablePath: string;
}
export interface WindowsJobKernel {
  openProcess(pid: number): WindowsHandle;
  createJob(): WindowsHandle;
  assign(job: WindowsHandle, process: WindowsHandle): void;
  isMember(job: WindowsHandle, process: WindowsHandle): boolean;
  readProcess(process: WindowsHandle): WindowsProcessIdentity;
  alive(process: WindowsHandle): boolean;
  activeProcesses(job: WindowsHandle): number;
  terminate(job: WindowsHandle): void;
  close(handle: WindowsHandle): void;
}

interface FfiBinding {
  open(input: { library: string; path: string }): void;
  load(input: {
    library: string;
    funcName: string;
    retType: number;
    paramsType: unknown[];
    paramsValue: unknown[];
    freeResultMemory: false;
    runInNewThread: false;
  }): unknown;
  isNullPointer(value: unknown): boolean;
}

const unavailable = (): never => { throw new Error('Windows process custody unavailable'); };
// Exact ffi-rs 1.3.7 ABI. HANDLEs always remain opaque N-API External values.
const I32 = 1, U8_ARRAY = 10, EXTERNAL = 11, U64 = 12, U32 = 20, ARRAY = 997;
const bufferType = (buffer: Buffer) => ({ type: U8_ARRAY, length: buffer.length, ffiTypeTag: ARRAY });
const uint32 = (value: unknown): number => {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff)
    return unavailable();
  return Number(value);
};
const accepted = (value: unknown): void => {
  if (!Number.isInteger(value) || value === 0) return unavailable();
};

/** Called only after the exact delivered .node file has passed graph verification. */
export function createWindowsJobKernel(binding: unknown, library: string): WindowsJobKernel {
  if (!binding || typeof binding !== 'object') return unavailable();
  const candidate = binding as Partial<FfiBinding>;
  if (typeof candidate.open !== 'function' || typeof candidate.load !== 'function'
    || typeof candidate.isNullPointer !== 'function') return unavailable();
  const open = candidate.open.bind(binding), load = candidate.load.bind(binding);
  const isNullPointer = candidate.isNullPointer.bind(binding);
  // kernel32 is already loaded by the native Node process and is a Windows
  // KnownDLL. A fixed module name avoids trusting PATH, cwd or SystemRoot.
  open({ library, path: 'kernel32.dll' });
  const call = (funcName: string, retType: number, paramsType: unknown[], paramsValue: unknown[]) =>
    load({ library, funcName, retType, paramsType, paramsValue,
      freeResultMemory: false, runInNewThread: false });
  const handle = (value: unknown): WindowsHandle => {
    if (!value || typeof value !== 'object' || isNullPointer(value)) return unavailable();
    return value;
  };
  const close = (value: WindowsHandle): void => { accepted(call('CloseHandle', I32, [EXTERNAL], [value])); };
  return Object.freeze({
    openProcess(pid: number) {
      if (uint32(pid) === 0) return unavailable();
      // QueryLimitedInformation | Synchronize | SetQuota | Terminate.
      return handle(call('OpenProcess', EXTERNAL, [U32, I32, U32], [0x101101, 0, pid]));
    },
    createJob() {
      // Both supported architectures use 64-bit pointers; zero U64 arguments
      // are NULL security/name pointers, never numeric process handles.
      const job = handle(call('CreateJobObjectW', EXTERNAL, [U64, U64], [0, 0]));
      try {
        // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION, identical on x64/ARM64.
        const limits = Buffer.alloc(144);
        limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        accepted(call('SetInformationJobObject', I32,
          [EXTERNAL, I32, bufferType(limits), U32], [job, 9, limits, limits.length]));
        return job;
      } catch (error) {
        try { close(job); } catch { /* Never turn a setup failure into a valid job. */ }
        throw error;
      }
    },
    assign(job: WindowsHandle, process: WindowsHandle) {
      accepted(call('AssignProcessToJobObject', I32, [EXTERNAL, EXTERNAL], [job, process]));
    },
    isMember(job: WindowsHandle, process: WindowsHandle) {
      const result = Buffer.alloc(4);
      accepted(call('IsProcessInJob', I32, [EXTERNAL, EXTERNAL, bufferType(result)], [process, job, result]));
      const member = result.readInt32LE();
      if (member !== 0 && member !== 1) return unavailable();
      return member === 1;
    },
    readProcess(process: WindowsHandle) {
      const pid = uint32(call('GetProcessId', U32, [EXTERNAL], [process]));
      const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
      accepted(call('GetProcessTimes', I32,
        [EXTERNAL, ...[creation, exit, kernel, user].map(bufferType)], [process, creation, exit, kernel, user]));
      const stamp = creation.readBigUInt64LE();
      if (pid === 0 || stamp === 0n) return unavailable();
      const name = Buffer.alloc(32768 * 2), length = Buffer.alloc(4);
      length.writeUInt32LE(32768);
      accepted(call('QueryFullProcessImageNameW', I32,
        [EXTERNAL, U32, bufferType(name), bufferType(length)], [process, 0, name, length]));
      const count = length.readUInt32LE();
      if (count === 0 || count >= 32768) return unavailable();
      const executablePath = name.toString('utf16le', 0, count * 2);
      if (executablePath.includes('\0')) return unavailable();
      return { pid, startIdentity: stamp.toString(10), executablePath };
    },
    alive(process: WindowsHandle) {
      const wait = uint32(call('WaitForSingleObject', U32, [EXTERNAL, U32], [process, 0]));
      if (wait === 0) return false;
      if (wait === 258) return true;
      return unavailable();
    },
    activeProcesses(job: WindowsHandle) {
      const accounting = Buffer.alloc(48), length = Buffer.alloc(4);
      accepted(call('QueryInformationJobObject', I32,
        [EXTERNAL, I32, bufferType(accounting), U32, bufferType(length)],
        [job, 1, accounting, accounting.length, length]));
      if (length.readUInt32LE() !== accounting.length) return unavailable();
      return accounting.readUInt32LE(40);
    },
    terminate(job: WindowsHandle) {
      accepted(call('TerminateJobObject', I32, [EXTERNAL, U32], [job, 1]));
    },
    close,
  });
}
