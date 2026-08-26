export interface OpenCodeCleanupHostsCommandBody {
  reason: 'startup' | 'shutdown' | 'manual' | string;
  mode?: 'stale' | 'force';
  projectPath?: string;
  staleAgeMs?: number | null;
  leaseStaleAgeMs?: number | null;
  preflightLeaseStaleAgeMs?: number | null;
}

export interface OpenCodeCleanupHostsCommandData {
  cleaned: number;
  remaining: number;
  hosts: {
    hostKey: string;
    projectPath: string;
    pid: number;
    port: number;
    action:
      | 'disposed'
      | 'removed_dead'
      | 'kept_active'
      | 'kept_leased'
      | 'kept_recent'
      | 'kept_filtered'
      | 'failed';
    reason: string;
    leaseCount: number;
  }[];
  diagnostics: string[];
}
