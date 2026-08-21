import type { ChildProcess } from 'child_process';

export interface UnixProcessIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startIdentity: string;
}

type OwnedUnixProcessGroup =
  | Readonly<{ state: 'unproven' }>
  | {
      state: 'proven';
      processGroupId: number;
      rootIdentity: UnixProcessIdentity;
      members: Map<number, UnixProcessIdentity>;
    };

const ownedUnixProcessGroups = new WeakMap<ChildProcess, OwnedUnixProcessGroup>();

export function captureUnixProcessGroupOwnership(
  child: ChildProcess,
  processes: Map<number, UnixProcessIdentity> | null
): void {
  const rootIdentity = child.pid ? processes?.get(child.pid) : undefined;
  if (rootIdentity && rootIdentity.processGroupId === child.pid) {
    ownedUnixProcessGroups.set(child, {
      state: 'proven',
      processGroupId: rootIdentity.processGroupId,
      rootIdentity,
      members: new Map(
        [...processes!.values()]
          .filter((identity) => identity.processGroupId === rootIdentity.processGroupId)
          .map((identity) => [identity.pid, identity] as const)
      ),
    });
    return;
  }

  // A failed spawn-edge capture is permanently unproven. Never infer ownership
  // later from only a recycled numeric PID or process-group identifier.
  ownedUnixProcessGroups.set(child, Object.freeze({ state: 'unproven' }));
}

export function getCapturedUnixProcessGroupMembers(
  child: ChildProcess,
  parentPid: number,
  readProcesses: () => Map<number, UnixProcessIdentity>
): UnixProcessIdentity[] | null {
  const ownedGroup = ownedUnixProcessGroups.get(child);
  if (!ownedGroup) {
    return null;
  }
  if (ownedGroup.state === 'unproven') {
    throw new Error(
      `Failed to verify Unix process tree ${parentPid}: spawn-edge ownership was not proven`
    );
  }

  const processes = readProcesses();
  const currentRoot = processes.get(parentPid);
  if (currentRoot && currentRoot.startIdentity !== ownedGroup.rootIdentity.startIdentity) {
    throw new Error(
      `Failed to verify Unix process tree ${parentPid}: root pid was reused after ownership capture`
    );
  }
  if (currentRoot && currentRoot.processGroupId !== ownedGroup.processGroupId) {
    throw new Error(
      `Failed to verify Unix process tree ${parentPid}: owned root changed process groups`
    );
  }
  if (currentRoot) {
    const currentMembers = [...processes.values()].filter(
      (identity) => identity.processGroupId === ownedGroup.processGroupId
    );
    for (const identity of currentMembers) {
      ownedGroup.members.set(identity.pid, identity);
    }
    return currentMembers;
  }

  // Without the root anchor, only identities captured while it lived remain owned.
  return [...ownedGroup.members.values()].filter((identity) =>
    isSameUnixProcessIdentity(identity, processes.get(identity.pid))
  );
}

export function isSameUnixProcessIdentity(
  expected: UnixProcessIdentity,
  current: UnixProcessIdentity | undefined
): boolean {
  if (current === undefined || current.startIdentity !== expected.startIdentity) {
    return false;
  }
  if (current.processGroupId !== expected.processGroupId) {
    throw new Error(
      `Failed to verify Unix process ${expected.pid}: captured birth identity changed process groups`
    );
  }
  return true;
}
