export type CompositeRuntimePlanErrorCode =
  | 'case_fold_ambiguity'
  | 'credential_exposure_missing'
  | 'credential_exposure_widened'
  | 'credential_metadata_only'
  | 'duplicate_execution_unit_id'
  | 'duplicate_lane_id'
  | 'duplicate_legacy_member_key'
  | 'duplicate_member_id'
  | 'invalid_field'
  | 'lane_plan_mismatch'
  | 'lane_plan_rejected'
  | 'missing_lane_binding'
  | 'missing_member_binding'
  | 'persisted_roster_mismatch'
  | 'persisted_roster_missing'
  | 'persisted_plan_invalid'
  | 'plan_hash_mismatch'
  | 'unsupported_topology'
  | 'unstable_ordering';

export class CompositeRuntimePlanValidationError extends TypeError {
  readonly code: CompositeRuntimePlanErrorCode;

  constructor(code: CompositeRuntimePlanErrorCode, message: string) {
    super(message);
    this.name = 'CompositeRuntimePlanValidationError';
    this.code = code;
  }
}
