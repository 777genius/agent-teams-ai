import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { loadProcessNativeArtifact } from './loadProcessNativeArtifact.js';
import { isQualifiedDarwinBuild } from './qualifiedDarwinBuild.js';
import type { QualifiedDarwinBuild } from './qualifiedDarwinBuild.js';

import type { ChildProcess } from 'node:child_process';
import type {
  DarwinProcessIdentity,
  DarwinRegisteredProcessCapture,
  RegistrarBinding,
  RegisteredProcessCapture,
  ProcessObservation,
} from './registeredProcessContracts.js';

interface NativeApi {
  osBuild(): string;
  captureRoot(pid: number): unknown;
  readRootExecutable?(boot: string, token: readonly number[], sid: number): unknown;
  captureDescendant(boot: string, rootToken: readonly number[], pid: number): unknown;
  observeOriginal(boot: string, token: readonly number[], sid: number): string;
  signalOriginal(boot: string, token: readonly number[], sid: number): number;
}
const hold = (): never => {
  throw new Error('Registered process custody unavailable');
};
function identity(value: unknown, osBuild: QualifiedDarwinBuild): DarwinProcessIdentity {
  if (!value || typeof value !== 'object') return hold();
  const row = value as DarwinProcessIdentity;
  if (
    !Array.isArray(row.auditToken) ||
    row.auditToken.length !== 8 ||
    !row.auditToken.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) ||
    row.auditToken[5]! <= 1 ||
    row.auditToken[5]! > 0x7fffffff ||
    !Number.isSafeInteger(row.sessionId) ||
    row.sessionId <= 1 ||
    typeof row.bootId !== 'string' ||
    !/^[A-Fa-f0-9-]{36}$/.test(row.bootId) ||
    row.osBuild !== osBuild
  )
    return hold();
  return {
    auditToken: [...row.auditToken],
    sessionId: row.sessionId,
    bootId: row.bootId,
    osBuild: row.osBuild,
  };
}
/** Load once in trusted Host composition. Binary is compiled/packaged at build time, never at startup. */
export function createQualifiedDarwinProcessApi(artifact: {
  path: string;
  sha256: string;
  osBuild: QualifiedDarwinBuild;
}) {
  if (
    process.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(process.arch) ||
    !isQualifiedDarwinBuild(artifact.osBuild) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.path.endsWith('.node')
  )
    return hold();
  const { native, assertBinary } = loadProcessNativeArtifact<NativeApi>(artifact);
  const assertCurrent = () => {
    assertBinary();
    if (native.osBuild() !== artifact.osBuild) hold();
  };
  const original = (capture: RegisteredProcessCapture) => {
    if (capture.version !== 1 && capture.version !== 2) return hold();
    identity(capture.root, artifact.osBuild);
    return identity(capture.target, artifact.osBuild);
  };
  const roots = new WeakMap<ChildProcess, { root: DarwinProcessIdentity; current(): boolean }>();
  assertCurrent();
  return {
    /** Synchronous immediately after actual spawn, before yielding/reaping the original child. */
    captureRoot(child: ChildProcess, current: () => boolean) {
      if (
        roots.has(child) ||
        !current() ||
        !child.pid ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return hold();
      assertCurrent();
      const root = identity(native.captureRoot(child.pid), artifact.osBuild);
      if (root.auditToken[5] !== child.pid || root.sessionId !== child.pid || !current())
        return hold();
      let alive = true;
      child.once('exit', () => {
        alive = false;
      });
      roots.set(child, {
        root,
        current: () => alive && current() && child.exitCode === null && child.signalCode === null,
      });
      return {
        capture(pid: number, registrar: RegistrarBinding): DarwinRegisteredProcessCapture {
          if (!alive || !current() || child.exitCode !== null || child.signalCode !== null)
            return hold();
          assertCurrent();
          const captured = native.captureDescendant(root.bootId, root.auditToken, pid);
          const target = identity(captured, artifact.osBuild);
          const admission =
            captured && typeof captured === 'object' && 'admission' in captured
              ? captured.admission
              : undefined;
          const ancestry = admission === 'live-ancestry-v1';
          if (
            target.auditToken[5] !== pid ||
            (ancestry
              ? target.sessionId === root.sessionId || target.sessionId === pid
              : admission !== undefined || target.sessionId !== root.sessionId) ||
            target.bootId !== root.bootId ||
            !current() ||
            !alive
          )
            return hold();
          return {
            ...(ancestry
              ? { version: 2 as const, admission: 'live-ancestry-v1' as const }
              : { version: 1 as const }),
            registrar: structuredClone(registrar),
            target,
            root: structuredClone(root),
          };
        },
      };
    },
    /** Reuse the original synchronous root capture; never recapture a numeric PID. */
    readRootExecutable(child: ChildProcess, executable: { path: string; sha256: string }) {
      const captured = roots.get(child);
      if (
        !captured ||
        !captured.current() ||
        typeof native.readRootExecutable !== 'function' ||
        !/^[a-f0-9]{64}$/.test(executable.sha256)
      )
        return hold();
      const { root } = captured;
      const measure = () => {
        assertCurrent();
        if (!captured.current()) return hold();
        const value = native.readRootExecutable!(root.bootId, root.auditToken, root.sessionId);
        const observed = identity(value, artifact.osBuild);
        if (
          observed.bootId !== root.bootId ||
          observed.sessionId !== root.sessionId ||
          observed.auditToken.some((part, index) => part !== root.auditToken[index]) ||
          !value ||
          typeof value !== 'object' ||
          !('executablePath' in value) ||
          value.executablePath !== executable.path ||
          !('birth' in value) ||
          typeof value.birth !== 'string' ||
          !/^[1-9]\d{0,19}$/.test(value.birth) ||
          !captured.current()
        )
          return hold();
        return value.birth;
      };
      const birth = measure();
      const before = lstatSync(executable.path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 512 * 1024 * 1024 ||
        realpathSync(executable.path) !== executable.path
      )
        return hold();
      const file = openSync(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let digest: string;
      try {
        const opened = fstatSync(file);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
          return hold();
        digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      } finally {
        closeSync(file);
      }
      const after = lstatSync(executable.path);
      if (
        digest !== executable.sha256 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        measure() !== birth ||
        !captured.current()
      )
        return hold();
      return {
        executablePath: executable.path,
        executableSha256: digest,
        pid: root.auditToken[5]!,
        startIdentity: `${root.bootId}:${root.auditToken[5]}:${root.auditToken[7]}:${birth}`,
      };
    },
    /** Cold lookup uses immutable original identity, never recaptures a replacement root. */
    observe(capture: RegisteredProcessCapture): ProcessObservation {
      try {
        assertCurrent();
        const target = original(capture);
        const result = native.observeOriginal(target.bootId, target.auditToken, target.sessionId);
        return ['same-live', 'absent', 'stale', 'unknown'].includes(result)
          ? (result as ProcessObservation)
          : 'unknown';
      } catch {
        return 'unknown';
      }
    },
    signal(capture: RegisteredProcessCapture): 'accepted' | 'refused' {
      assertCurrent();
      const target = original(capture);
      // Throw after requested is persisted remains unknown; no false signalled:false result.
      const code = native.signalOriginal(target.bootId, target.auditToken, target.sessionId);
      if (!Number.isSafeInteger(code) || code < 0) return hold();
      return code === 0 ? 'accepted' : 'refused';
    },
  };
}
