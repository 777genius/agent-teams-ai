import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runtimeDigest } from '../runtime/identity.js';
import { validateProcessCapture } from './validateProcessRecords.js';
import type {
  LinuxWarmProcessIdentity, LinuxWarmRegisteredProcessCapture,
  ProcessObservation, RegistrarBinding, RegisteredProcessCapture,
} from './registeredProcessContracts.js';

export interface LinuxWarmNativeApi {
  captureWarmRoot(pid: number): unknown;
  captureWarmDescendant(root: object, pid: number): unknown;
  readWarmRootExecutable(root: object): unknown;
  observeWarm(handle: object): string;
  signalWarm(handle: object): number;
  closeWarm(handle: object): void;
}
const hold = (): never => { throw new Error('Registered process custody unavailable'); };
export function linuxWarmIdentity(value: unknown): LinuxWarmProcessIdentity {
  if (!value || typeof value !== 'object') return hold();
  const row = value as LinuxWarmProcessIdentity;
  const decimal = (part: unknown) => typeof part === 'string' && /^[1-9]\d{0,19}$/.test(part) &&
    BigInt(part) <= 0xffffffffffffffffn;
  if ('pidfdId' in row || !Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pid > 0x7fffffff ||
      !Number.isSafeInteger(row.sessionId) || row.sessionId <= 1 || row.sessionId > 0x7fffffff ||
      !decimal(row.pidNamespaceId) || typeof row.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.bootId))
    return hold();
  return { pid: row.pid, sessionId: row.sessionId, pidNamespaceId: row.pidNamespaceId, bootId: row.bootId };
}
function retained(value: unknown): { identity: LinuxWarmProcessIdentity; handle: object } {
  const identity = linuxWarmIdentity(value);
  if (!value || typeof value !== 'object' || !('handle' in value) ||
      !value.handle || typeof value.handle !== 'object') return hold();
  return { identity, handle: value.handle };
}
interface Root {
  identity: LinuxWarmProcessIdentity;
  handle: object;
  key: string;
  current(): boolean;
}
interface Retained {
  capture: LinuxWarmRegisteredProcessCapture;
  root: Root;
  handle?: object;
  absent: boolean;
}

/** Host-private original pidfds. Serialized keys only look up this exact owner; they never reopen a process. */
export function createLinuxWarmProcess(native: LinuxWarmNativeApi, assertCurrent: () => void) {
  const ownerInstance = randomUUID();
  const roots = new WeakMap<ChildProcess, Root>();
  const captures = new Map<string, Retained>();
  const handles = new Set<Retained>();
  let sweepCursor = handles.values();
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  const exact = (capture: RegisteredProcessCapture): Retained | undefined => {
    validateProcessCapture(capture);
    if (capture.version !== 4 || capture.ownerInstance !== ownerInstance) return undefined;
    const retained = captures.get(capture.captureKey);
    return retained && runtimeDigest(retained.capture) === runtimeDigest(capture) ? retained : undefined;
  };
  const observe = (value: Retained): ProcessObservation => {
    if (value.absent) return 'absent';
    if (!value.handle) return 'unknown';
    const state = native.observeWarm(value.handle);
    if (state === 'absent') {
      // Keep the terminal proof until its owner acknowledges it; only the descriptor is released here.
      native.closeWarm(value.handle); delete value.handle; value.absent = true;
      handles.delete(value);
      if (!handles.size && sweepTimer) { clearTimeout(sweepTimer); sweepTimer = undefined; }
      return 'absent';
    }
    return state === 'same-live' ? 'same-live' : 'unknown';
  };
  const scheduleSweep = () => {
    if (sweepTimer || !handles.size) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      // A bounded round-robin scan also covers descendants whose provider root has exited.
      // Unknown/failed native observations retain the original handle and its authority.
      for (let left = Math.min(128, handles.size); left > 0; left--) {
        let next = sweepCursor.next();
        if (next.done) { sweepCursor = handles.values(); next = sweepCursor.next(); }
        if (next.done) break;
        try { assertCurrent(); observe(next.value); } catch { /* Retain the original on uncertainty. */ }
      }
      scheduleSweep();
    }, 1000);
    sweepTimer.unref();
  };
  return {
    captureRoot(child: ChildProcess, current: () => boolean) {
      if (!(child instanceof ChildProcess) || roots.has(child) || !child.pid || !current() ||
          child.exitCode !== null || child.signalCode !== null) return hold();
      assertCurrent();
      // Caller has not yielded since spawn: Node/libuv has not reaped this direct child.
      const captured = retained(native.captureWarmRoot(child.pid));
      if (captured.identity.pid !== child.pid || captured.identity.sessionId !== child.pid || !current()) {
        native.closeWarm(captured.handle); return hold();
      }
      let alive = true;
      const root: Root = { ...captured, key: randomUUID(),
        current: () => alive && current() && child.exitCode === null && child.signalCode === null };
      child.once('exit', () => {
        alive = false;
        try { native.closeWarm(root.handle); } catch { /* The native finalizer retains original cleanup. */ }
      });
      roots.set(child, root);
      return {
        capture(pid: number, registrar: RegistrarBinding): LinuxWarmRegisteredProcessCapture {
          if (!root.current()) return hold();
          assertCurrent();
          const selected = retained(native.captureWarmDescendant(root.handle, pid));
          let saved = false;
          try {
            if (selected.identity.pid !== pid || !root.current()) return hold();
            for (const original of captures.values()) {
              if (original.capture.target.pid !== pid || observe(original) !== 'same-live') continue;
              if (original.root !== root || runtimeDigest(original.capture.registrar) !== runtimeDigest(registrar) ||
                  runtimeDigest(original.capture.target) !== runtimeDigest(selected.identity)) return hold();
              // Fresh lineage and two simultaneously live pidfds prove the same unreusable PID object.
              return structuredClone(original.capture);
            }
            if (captures.size >= 10000 || native.observeWarm(selected.handle) !== 'same-live' || !root.current())
              return hold();
            const capture: LinuxWarmRegisteredProcessCapture = { version: 4, platform: 'linux',
              admission: 'owner-pidfd-v1', ownerInstance, captureKey: randomUUID(),
              registrar: structuredClone(registrar), root: { ...root.identity }, target: selected.identity };
            validateProcessCapture(capture);
            const value = { capture: structuredClone(capture), root, handle: selected.handle, absent: false };
            captures.set(capture.captureKey, value);
            handles.add(value);
            saved = true;
            scheduleSweep();
            return capture;
          } finally { if (!saved) native.closeWarm(selected.handle); }
        },
      };
    },
    rootEvidence(child: ChildProcess) {
      const root = roots.get(child);
      if (!root?.current()) return hold();
      return { root: root.identity, current: root.current,
        startIdentity: ownerInstance + ':' + root.key,
        measure: () => native.readWarmRootExecutable(root.handle) };
    },
    observe(capture: RegisteredProcessCapture): ProcessObservation {
      assertCurrent();
      const selected = exact(capture);
      return selected ? observe(selected) : 'unknown';
    },
    /** Only the durable owner of an exact completed Stop may acknowledge this terminal proof. */
    acknowledgeAbsence(capture: RegisteredProcessCapture): void {
      assertCurrent();
      const selected = exact(capture);
      if (selected?.absent && capture.version === 4) captures.delete(capture.captureKey);
    },
    /** Called only after the original Team's durable purge; never discards live/unknown custody. */
    releaseTeam(binding: Pick<RegistrarBinding, 'backendId' | 'teamId'>): boolean {
      try {
        assertCurrent();
        const selected = [...captures.values()].filter(({ capture }) =>
          capture.registrar.backendId === binding.backendId && capture.registrar.teamId === binding.teamId);
        // Closing proven-absent descriptors is safe, but retire no metadata unless every proof succeeds.
        for (const value of selected) if (observe(value) !== 'absent') return false;
        assertCurrent();
        for (const value of selected) captures.delete(value.capture.captureKey);
        return true;
      } catch { return false; }
    },
    signal(capture: RegisteredProcessCapture): 'accepted' | 'refused' {
      assertCurrent();
      const selected = exact(capture);
      if (!selected || selected.absent || !selected.handle) return 'refused';
      return native.signalWarm(selected.handle) === 0 ? 'accepted' : 'refused';
    },
  };
}
