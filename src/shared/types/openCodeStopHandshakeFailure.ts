/** Closed family of a deterministic handshake rejection message; never its text. */
export type OpenCodeStopHandshakeMessageFamily =
  | 'stop_authority_mismatch'
  | 'empty_lane_mismatch'
  | 'lane_authority_unavailable'
  | 'capability_snapshot_required'
  | 'run_authority_conflict'
  | 'run_authority_unavailable'
  | 'run_identity_required'
  | 'lane_scope_unavailable'
  | 'lane_scope_ambiguous'
  | 'lane_project_mismatch'
  | 'host_authority_ambiguous'
  | 'process_authority_ambiguous'
  | 'delivery_lane_stopped'
  | 'delivery_authority_required'
  | 'delivery_session_changed'
  | 'observation_launch_unavailable'
  | 'precondition_mismatch'
  | 'strict_launch_evidence'
  | 'strict_launch_model'
  | 'runtime_process_changed'
  | 'lock_operation'
  | 'lifecycle_rejection'
  | 'unclassified';

/** Closed handshake facts of a failed bridge operation; never message text. */
export interface OpenCodeStopHandshakeFailureFacts {
  kind: string;
  sdkCode?: string;
  nativeOperation?: string;
  nativeErrno?: number;
  lockCode?: 'ELOCKED' | 'ECOMPROMISED';
  lockCategory?: 'registry' | 'profile' | 'startup' | 'unknown';
  messageShape?: 'code' | 'lock_operation' | 'unclassified';
  messageFamily?: OpenCodeStopHandshakeMessageFamily;
  messageDigest?: string;
}
