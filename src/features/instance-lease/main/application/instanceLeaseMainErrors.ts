export type NodeInheritedInstanceLeaseErrorCode =
  | 'child_stdio_invalid'
  | 'closed'
  | 'control_fd_invalid'
  | 'evidence_invalid'
  | 'evidence_mismatch'
  | 'launcher_disconnected'
  | 'lease_fd_invalid'
  | 'platform_unsupported';

export class NodeInheritedInstanceLeaseError extends Error {
  constructor(readonly code: NodeInheritedInstanceLeaseErrorCode) {
    super(`node-inherited-instance-lease:${code}`);
    this.name = 'NodeInheritedInstanceLeaseError';
  }
}
