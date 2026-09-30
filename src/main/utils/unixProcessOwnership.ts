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
      ownership: 'process-group' | 'process-tree';
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
  if (rootIdentity) {
    const ownsProcessGroup = rootIdentity.processGroupId === child.pid;
    ownedUnixProcessGroups.set(child, {
      state: 'proven',
      ownership: ownsProcessGroup ? 'process-group' : 'process-tree',
      processGroupId: rootIdentity.processGroupId,
      rootIdentity,
      members: new Map(
        [...processes!.values()]
          .filter((identity) =>
            ownsProcessGroup
              ? identity.processGroupId === rootIdentity.processGroupId
              : identity === rootIdentity
          )
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
    const currentMembers =
      ownedGroup.ownership === 'process-group'
        ? [...processes.values()].filter(
            (identity) => identity.processGroupId === ownedGroup.processGroupId
          )
        : collectUnixProcessTree(processes, parentPid);
    for (const identity of currentMembers) {
      ownedGroup.members.set(identity.pid, identity);
    }
    return currentMembers;
  }

  if (ownedGroup.ownership === 'process-tree') {
    throw new Error(
      `Failed to verify exited Unix process tree ${parentPid}: non-group root is no longer observable`
    );
  }

  // Without the root anchor, only identities captured while it lived remain owned.
  return [...ownedGroup.members.values()].filter((identity) =>
    isSameUnixProcessIdentity(identity, processes.get(identity.pid))
  );
}

function collectUnixProcessTree(
  processes: ReadonlyMap<number, UnixProcessIdentity>,
  rootPid: number
): UnixProcessIdentity[] {
  const root = processes.get(rootPid);
  if (!root) return [];
  const childrenByParent = new Map<number, number[]>();
  for (const identity of processes.values()) {
    const children = childrenByParent.get(identity.parentPid) ?? [];
    children.push(identity.pid);
    childrenByParent.set(identity.parentPid, children);
  }
  const descendants = [root];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid) || pid === process.pid) continue;
    seen.add(pid);
    const identity = processes.get(pid);
    if (!identity) continue;
    descendants.push(identity);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
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
