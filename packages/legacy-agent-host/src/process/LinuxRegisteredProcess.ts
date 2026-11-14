import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { loadProcessNativeArtifact } from './loadProcessNativeArtifact.js';
import { createLinuxWarmProcess, linuxWarmIdentity } from './LinuxWarmProcess.js';
import { runtimeDigest } from '../runtime/identity.js';
import { validateProcessCapture } from './validateProcessRecords.js';
import type { LinuxWarmNativeApi } from './LinuxWarmProcess.js';

import type { LinuxProcessIdentity, LinuxRegisteredProcessCapture, ProcessObservation,
  RegistrarBinding, RegisteredProcessCapture } from './registeredProcessContracts.js';

interface NativeApi extends LinuxWarmNativeApi {
  kernelIdentity(): { kernelRelease: string; machine: string; glibcVersion: string;
    pidfd?: boolean; pidfs?: boolean };
  captureRoot(pid: number): unknown;
  captureDescendant(root: LinuxProcessIdentity, pid: number): unknown;
  readRootExecutable(root: LinuxProcessIdentity): unknown;
  observeOriginal(target: LinuxProcessIdentity): string;
  signalOriginal(target: LinuxProcessIdentity): number;
}
const hold = (): never => { throw new Error('Registered process custody unavailable'); };
function identity(value: unknown): LinuxProcessIdentity {
  if (!value || typeof value !== 'object') return hold();
  const row = value as LinuxProcessIdentity;
  const decimal = (part: unknown) => typeof part === 'string' && /^[1-9]\d{0,19}$/.test(part) &&
    BigInt(part) <= 0xffffffffffffffffn;
  if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pid > 0x7fffffff ||
      !Number.isSafeInteger(row.sessionId) || row.sessionId <= 1 || row.sessionId > 0x7fffffff ||
      !decimal(row.pidfdId) || !decimal(row.pidNamespaceId) ||
      typeof row.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.bootId)) return hold();
  return { pid: row.pid, sessionId: row.sessionId, pidfdId: row.pidfdId,
    pidNamespaceId: row.pidNamespaceId, bootId: row.bootId };
}
/** Actual kernel capability selects durable pidfs or retained original pidfds; never a release guess. */
export function createQualifiedLinuxProcessApi(artifact: {
  path: string;
  sha256: string;
  kernelCapability: 'pidfs-inode64-v1' | 'pidfd-live-v1';
  libc: { family: 'glibc'; minimumVersion: string };
}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
      !['pidfs-inode64-v1', 'pidfd-live-v1'].includes(artifact.kernelCapability) || artifact.libc.family !== 'glibc' ||
      !/^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?$/.test(artifact.libc.minimumVersion)) return hold();
  const minimumVersion = artifact.libc.minimumVersion;
  const { native, assertBinary } = loadProcessNativeArtifact<NativeApi>(artifact);
  const readKernel = () => {
    assertBinary();
    const kernel = native.kernelIdentity();
    if (kernel.machine !== 'x86_64' || !/^[A-Za-z0-9._+-]{1,128}$/.test(kernel.kernelRelease) ||
        !/^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?$/.test(kernel.glibcVersion)) hold();
    const current = kernel.glibcVersion.split('.').map(Number), required = minimumVersion.split('.').map(Number);
    for (let index = 0; index < Math.max(current.length, required.length); index++) {
      const observed = current[index] ?? 0, minimum = required[index] ?? 0;
      if (observed < minimum) hold();
      if (observed > minimum) break;
    }
    // Older selected manifests used a native probe that succeeded only on pidfs.
    if (artifact.kernelCapability === 'pidfs-inode64-v1' &&
        kernel.pidfd === undefined && kernel.pidfs === undefined) return { pidfd: true, pidfs: true };
    if (typeof kernel.pidfd !== 'boolean' || typeof kernel.pidfs !== 'boolean' ||
        (kernel.pidfs && !kernel.pidfd)) return hold();
    return { pidfd: kernel.pidfd, pidfs: kernel.pidfs };
  };
  const capability = readKernel();
  if (!capability.pidfd || (artifact.kernelCapability === 'pidfs-inode64-v1' && !capability.pidfs))
    return undefined;
  const assertCurrent = () => {
    const observed = readKernel();
    if (observed.pidfd !== capability.pidfd || observed.pidfs !== capability.pidfs) hold();
  };
  if (!capability.pidfs && ['captureWarmRoot', 'captureWarmDescendant', 'readWarmRootExecutable',
    'observeWarm', 'signalWarm', 'closeWarm'].some(name =>
      typeof native[name as keyof LinuxWarmNativeApi] !== 'function')) return hold();
  const warm = capability.pidfs ? undefined : createLinuxWarmProcess(native, assertCurrent);
  const original = (capture: RegisteredProcessCapture) => {
    validateProcessCapture(capture);
    if (capture.version !== 3 || capture.platform !== 'linux') return hold();
    return identity(capture.target);
  };
  const roots = new WeakMap<ChildProcess, { root: LinuxProcessIdentity; current(): boolean }>();
  return {
    captureRoot(child: ChildProcess, current: () => boolean) {
      if (warm) return warm.captureRoot(child, current);
      if (!(child instanceof ChildProcess) || roots.has(child) || !child.pid || !current() ||
          child.exitCode !== null || child.signalCode !== null) return hold();
      assertCurrent();
      const root = identity(native.captureRoot(child.pid));
      if (root.pid !== child.pid || root.sessionId !== root.pid || !current()) return hold();
      let alive = true;
      child.once('exit', () => { alive = false; });
      const isCurrent = () => alive && current() && child.exitCode === null && child.signalCode === null;
      roots.set(child, { root, current: isCurrent });
      return {
        capture(pid: number, registrar: RegistrarBinding): LinuxRegisteredProcessCapture {
          if (!isCurrent()) return hold();
          assertCurrent();
          const target = identity(native.captureDescendant(root, pid));
          const capture: LinuxRegisteredProcessCapture = { version: 3, platform: 'linux',
            registrar: structuredClone(registrar), root: structuredClone(root), target };
          validateProcessCapture(capture);
          if (target.pid !== pid || !isCurrent()) return hold();
          return capture;
        },
      };
    },
    readRootExecutable(child: ChildProcess, executable: { path: string; sha256: string }) {
      const durable = roots.get(child);
      const selected = warm ? warm.rootEvidence(child) : durable && { ...durable,
        startIdentity: `${durable.root.bootId}:${durable.root.pidNamespaceId}:${durable.root.pidfdId}`,
        measure: () => native.readRootExecutable(durable.root) };
      if (!selected?.current() || !/^[a-f0-9]{64}$/.test(executable.sha256)) return hold();
      const measure = () => {
        assertCurrent();
        if (!selected.current()) return hold();
        const value = selected.measure();
        if (runtimeDigest(warm ? linuxWarmIdentity(value) : identity(value)) !== runtimeDigest(selected.root) ||
            !value || typeof value !== 'object' ||
            !('executablePath' in value) || value.executablePath !== executable.path ||
            !('executableDevice' in value) || typeof value.executableDevice !== 'string' ||
            !/^[0-9]{1,20}$/.test(value.executableDevice) ||
            !('executableInode' in value) || typeof value.executableInode !== 'string' ||
            !/^[1-9]\d{0,19}$/.test(value.executableInode) || !selected.current()) return hold();
        return { device: value.executableDevice, inode: value.executableInode };
      };
      const nativeImage = measure();
      const before = lstatSync(executable.path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
          before.size > 512n * 1024n * 1024n || realpathSync(executable.path) !== executable.path ||
          before.dev.toString() !== nativeImage.device || before.ino.toString() !== nativeImage.inode) return hold();
      const file = openSync(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let digest: string;
      try {
        const opened = fstatSync(file, { bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return hold();
        digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      } finally { closeSync(file); }
      const after = lstatSync(executable.path, { bigint: true }), measuredAfter = measure();
      if (digest !== executable.sha256 || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
          nativeImage.device !== measuredAfter.device || nativeImage.inode !== measuredAfter.inode) return hold();
      return { executablePath: executable.path, executableSha256: digest, pid: selected.root.pid,
        startIdentity: selected.startIdentity };
    },
    observe(capture: RegisteredProcessCapture): ProcessObservation {
      try {
        assertCurrent();
        if (capture.version === 4) return warm ? warm.observe(capture) : 'unknown';
        if (warm) return 'unknown';
        const observed = native.observeOriginal(original(capture));
        return ['same-live', 'absent', 'stale', 'unknown'].includes(observed)
          ? observed as ProcessObservation : 'unknown';
      } catch { return 'unknown'; }
    },
    signal(capture: RegisteredProcessCapture): 'accepted' | 'refused' {
      assertCurrent();
      if (capture.version === 4) return warm ? warm.signal(capture) : 'refused';
      if (warm) return 'refused';
      return native.signalOriginal(original(capture)) === 0 ? 'accepted' : 'refused';
    },
  };
}
