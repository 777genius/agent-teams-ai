export function getMemberLifecycleOperationKey(teamName: string, memberName: string): string {
  return `${teamName.trim().toLowerCase()}\u0000${memberName.trim().toLowerCase()}`;
}

export function createMemberLifecycleOperationInProgressError(memberName: string): Error {
  return new Error(`Lifecycle operation for teammate "${memberName}" is already in progress`);
}

export function isMemberLifecycleOperationInProgressError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Lifecycle operation for teammate ".+" is already in progress$/.test(error.message)
  );
}
