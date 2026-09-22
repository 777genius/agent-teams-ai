export function getMemberLifecycleOperationKey(teamName: string, memberName: string): string {
  return `${teamName.trim().toLowerCase()}\u0000${memberName.trim().toLowerCase()}`;
}

class MemberLifecycleOperationInProgressError extends Error {}

export function createMemberLifecycleOperationInProgressError(memberName: string): Error {
  return new MemberLifecycleOperationInProgressError(
    `Lifecycle operation for teammate "${memberName}" is already in progress`
  );
}

export function isMemberLifecycleOperationInProgressError(error: unknown): boolean {
  return error instanceof MemberLifecycleOperationInProgressError;
}
