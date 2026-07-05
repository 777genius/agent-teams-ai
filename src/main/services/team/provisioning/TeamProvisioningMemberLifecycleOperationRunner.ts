import {
  createMemberLifecycleOperationInProgressError,
  getMemberLifecycleOperationKey,
} from './TeamProvisioningMemberLifecycleKeys';

export type MemberLifecycleOperationKind =
  | 'manual_restart'
  | 'opencode_retry'
  | 'opencode_member_added'
  | 'opencode_member_updated'
  | 'opencode_member_removed'
  | 'primary_member_added'
  | 'primary_member_restored'
  | 'primary_member_updated'
  | 'primary_member_removed';

export interface MemberLifecycleOperation {
  kind: MemberLifecycleOperationKind;
  token: symbol;
  startedAtMs: number;
}

export interface TeamProvisioningMemberLifecycleOperationRunnerPorts {
  memberLifecycleOperations: Map<string, MemberLifecycleOperation>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  nowMs(): number;
}

export interface TeamProvisioningMemberLifecycleOperationRunner {
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  runMemberLifecycleOperation<T>(
    teamName: string,
    memberName: string,
    kind: MemberLifecycleOperationKind,
    operation: () => Promise<T>
  ): Promise<T>;
}

export function createTeamProvisioningMemberLifecycleOperationRunner(
  ports: TeamProvisioningMemberLifecycleOperationRunnerPorts
): TeamProvisioningMemberLifecycleOperationRunner {
  return {
    isMemberLifecycleOperationActive(teamName, memberName) {
      return getActiveMemberLifecycleOperation(ports, teamName, memberName) !== null;
    },
    async runMemberLifecycleOperation(teamName, memberName, kind, operation) {
      return runMemberLifecycleOperationWithPorts(ports, teamName, memberName, kind, operation);
    },
  };
}

function getActiveMemberLifecycleOperation(
  ports: TeamProvisioningMemberLifecycleOperationRunnerPorts,
  teamName: string,
  memberName: string
): MemberLifecycleOperation | null {
  return (
    ports.memberLifecycleOperations.get(getMemberLifecycleOperationKey(teamName, memberName)) ??
    null
  );
}

async function runMemberLifecycleOperationWithPorts<T>(
  ports: TeamProvisioningMemberLifecycleOperationRunnerPorts,
  teamName: string,
  memberName: string,
  kind: MemberLifecycleOperationKind,
  operation: () => Promise<T>
): Promise<T> {
  const key = getMemberLifecycleOperationKey(teamName, memberName);
  if (ports.memberLifecycleOperations.has(key)) {
    throw createMemberLifecycleOperationInProgressError(memberName);
  }

  const token = Symbol(`${kind}:${teamName}:${memberName}`);
  ports.memberLifecycleOperations.set(key, {
    kind,
    token,
    startedAtMs: ports.nowMs(),
  });
  ports.invalidateRuntimeSnapshotCaches(teamName);
  try {
    return await operation();
  } finally {
    if (ports.memberLifecycleOperations.get(key)?.token === token) {
      ports.memberLifecycleOperations.delete(key);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
  }
}
