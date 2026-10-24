import { randomUUID } from 'node:crypto';

import type { UnixProcessIdentity } from './unixProcessTable';
import type { ChildProcess } from 'node:child_process';

export interface OwnedUnixProcessGroup {
  processGroupId: number | null;
  rootProcessGroupId: number;
  rootStartIdentity: string | null;
}
export interface VerifiedCliProcessRelease {
  version: 1;
  ownerIncarnation: string;
  rootPid: number;
  rootStartIdentity: string;
  processGroupId: number;
  processes: UnixProcessIdentity[];
}
/** Opaque, instance-bound capability; serialized data cannot recreate it. */
export interface CapturedCliProcessStop {
  readonly rootPid: number;
  readonly rootStartIdentity: string;
  readonly processGroupId: number;
}

const ownerIncarnation = randomUUID();
const groups = new WeakMap<ChildProcess, OwnedUnixProcessGroup>();
const captures = new WeakMap<CapturedCliProcessStop, ChildProcess>();
const releases = new WeakMap<ChildProcess, VerifiedCliProcessRelease>();

export function recordOwnedUnixProcessGroup(child: ChildProcess, root: UnixProcessIdentity): void {
  if (!child.pid || root.pid !== child.pid) return;
  releases.delete(child);
  groups.set(child, {
    processGroupId: root.processGroupId === child.pid ? child.pid : null,
    rootProcessGroupId: root.processGroupId,
    rootStartIdentity: root.startIdentity,
  });
}

export function getOwnedUnixProcessGroup(child: ChildProcess): OwnedUnixProcessGroup | undefined {
  const group = groups.get(child);
  return group && { ...group };
}

/** No OS lookup: this is the identity captured by spawnCli's original owner. */
export function captureCliProcessStop(child: ChildProcess): CapturedCliProcessStop | null {
  const group = groups.get(child);
  if (!child.pid || !group?.rootStartIdentity || group.processGroupId !== child.pid) return null;
  const capture = Object.freeze({
    rootPid: child.pid,
    rootStartIdentity: group.rootStartIdentity,
    processGroupId: group.processGroupId,
  });
  captures.set(capture, child);
  return capture;
}

/** Called only after the existing Unix termination/identity wait completed. */
export function recordVerifiedCliProcessRelease(
  child: ChildProcess,
  processes: readonly UnixProcessIdentity[]
): void {
  const identity = captureCliProcessStop(child);
  if (
    !identity ||
    processes.length > 256 ||
    processes.some((process) => process.processGroupId !== identity.processGroupId)
  )
    return;
  releases.set(child, {
    version: 1,
    ownerIncarnation,
    ...identity,
    processes: structuredClone([...processes]),
  });
}

export function readVerifiedCliProcessRelease(
  capture: CapturedCliProcessStop
): VerifiedCliProcessRelease | null {
  const child = captures.get(capture);
  const release = child && releases.get(child);
  const current = child && groups.get(child);
  if (
    !release ||
    release.rootPid !== capture.rootPid ||
    release.rootStartIdentity !== capture.rootStartIdentity ||
    release.processGroupId !== capture.processGroupId ||
    current?.rootStartIdentity !== capture.rootStartIdentity ||
    current.processGroupId !== capture.processGroupId
  )
    return null;
  return structuredClone(release);
}
