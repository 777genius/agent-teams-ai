import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { ChildProcess } from 'node:child_process';
import type {
  DarwinProcessIdentity,
  RegistrarBinding,
  RegisteredProcessCapture,
  ProcessObservation,
} from './registeredProcessContracts.js';

interface NativeApi {
  osBuild(): string;
  captureRoot(pid: number): unknown;
  captureDescendant(boot: string, rootToken: readonly number[], pid: number): unknown;
  observeOriginal(boot: string, token: readonly number[], sid: number): string;
  signalOriginal(boot: string, token: readonly number[], sid: number): number;
}
const hold = (): never => {
  throw new Error('Registered process custody unavailable');
};
function identity(value: unknown): DarwinProcessIdentity {
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
    row.osBuild !== '24G90'
  )
    return hold();
  return {
    auditToken: [...row.auditToken], sessionId: row.sessionId, bootId: row.bootId, osBuild: row.osBuild,
  };
}
/** Load once in trusted Host composition. Binary is compiled/packaged at build time, never at startup. */
export function createQualifiedDarwinProcessApi(artifact: { path: string; sha256: string }) {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.path.endsWith('.node')
  )
    return hold();
  const selected = lstatSync(artifact.path);
  const assertBinary = () => {
    const info = lstatSync(artifact.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      realpathSync(artifact.path) !== artifact.path ||
      info.dev !== selected.dev ||
      info.ino !== selected.ino ||
      info.size !== selected.size ||
      info.mtimeMs !== selected.mtimeMs ||
      info.ctimeMs !== selected.ctimeMs ||
      createHash('sha256').update(readFileSync(artifact.path)).digest('hex') !== artifact.sha256
    )
      hold();
  };
  assertBinary();
  const require = createRequire(import.meta.url);
  // One private composition loader; do not silently adopt a previously cached different artifact.
  if (require.cache[artifact.path]) return hold();
  const native = require(artifact.path) as NativeApi;
  assertBinary();
  const assertCurrent = () => {
    assertBinary();
    if (native.osBuild() !== '24G90') hold();
  };
  assertCurrent();
  return {
    /** Synchronous immediately after actual spawn, before yielding/reaping the original child. */
    captureRoot(child: ChildProcess, current: () => boolean) {
      if (!current() || !child.pid || child.exitCode !== null || child.signalCode !== null)
        return hold();
      assertCurrent();
      const root = identity(native.captureRoot(child.pid));
      if (root.auditToken[5] !== child.pid || root.sessionId !== child.pid || !current())
        return hold();
      let alive = true;
      child.once('exit', () => {
        alive = false;
      });
      return {
        capture(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture {
          if (!alive || !current() || child.exitCode !== null || child.signalCode !== null)
            return hold();
          assertCurrent();
          const captured = native.captureDescendant(root.bootId, root.auditToken, pid);
          const target = identity(captured);
          const admission = captured && typeof captured === 'object' && 'admission' in captured
            ? captured.admission : undefined;
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
            ...(ancestry ? { version: 2 as const, admission: 'live-ancestry-v1' as const } : { version: 1 as const }),
            registrar: structuredClone(registrar),
            target,
            root: structuredClone(root),
          };
        },
      };
    },
    /** Cold lookup uses immutable original identity, never recaptures a replacement root. */
    observe(capture: RegisteredProcessCapture): ProcessObservation {
      try {
        assertCurrent();
        const target = identity(capture.target);
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
      const target = identity(capture.target);
      // Throw after requested is persisted remains unknown; no false signalled:false result.
      const code = native.signalOriginal(target.bootId, target.auditToken, target.sessionId);
      if (!Number.isSafeInteger(code) || code < 0) return hold();
      return code === 0 ? 'accepted' : 'refused';
    },
  };
}
