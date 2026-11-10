type RevisionOperation = 'send' | 'cancel';

const operations = new Map<string, RevisionOperation>();

export function acquireRevisionOperation(requestId: string, operation: RevisionOperation): boolean {
  if (operations.has(requestId)) return false;
  operations.set(requestId, operation);
  return true;
}

export function releaseRevisionOperation(requestId: string, operation: RevisionOperation): void {
  if (operations.get(requestId) === operation) operations.delete(requestId);
}
