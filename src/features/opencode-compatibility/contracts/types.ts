export type Generation = 'v1' | 'v2';
export type NativeKey =
  | { generation: 'v1'; apiDialect: 'v1' }
  | { generation: 'v2'; apiDialect: 'v2-2.0.0' | 'v2-2.0.21' };
export type NativeIdentity = Readonly<
  NativeKey & {
    version: string;
    executablePath: string;
    executableSha256: string;
    launcherPath: string;
    packageName: 'opencode-ai' | '@opencode/cli' | null;
    source: 'app-managed' | 'explicit' | 'path';
  }
>;
export type ProcessBirth =
  | { format: 'linux-start-ticks'; value: string; bootId: string }
  | { format: 'utc-ms'; value: string; bootId: null };
export type Selection = Readonly<{
  native: NativeIdentity;
  selectionEpoch: string;
  profileEpoch: string;
  profileRootKey: string;
  profileGeneration: Generation;
  canonicalDirectory: string;
  projectId: string;
}>;
export type EndpointAuthority = Readonly<
  Selection & {
    baseUrl: string;
    pid: number;
    processBirth: ProcessBirth;
    observedSpawnAtUtcMs: number;
    hostInstanceId: string;
    ownership: 'spawned' | 'managed-reused';
    capabilitySnapshotId: string;
  }
>;
export type SessionAuthority = Readonly<{
  endpoint: EndpointAuthority;
  teamId: string;
  runId: string;
  laneId: string;
  memberName: string;
  sessionId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  bindingId: string;
  leaseId: string;
  leaseEpoch: string;
  sessionRevision: string;
}>;
export type SupportState =
  | 'not_installed'
  | 'unsupported_version'
  | 'unqualified_version'
  | 'runtime_upgrade_required'
  | 'binary_host_mismatch'
  | 'capabilities_pending'
  | 'configuration_blocked'
  | 'ready';
export type PermissionScope = Readonly<{
  kind: 'session';
  authority: SessionAuthority;
  requestId: string;
  relation: 'root' | 'child';
}>;
export interface OpenCodePermissionAnswer {
  kind: 'opencode-permission';
  approvalId: string;
  bindingId: string;
  expectedRevision: string;
  operationId: string;
  decision: 'once' | 'always' | 'reject';
  message?: string;
}
export type OwnerPermissionReply = Omit<OpenCodePermissionAnswer, 'kind'> & {
  schemaVersion: 1;
  scope: PermissionScope;
};
