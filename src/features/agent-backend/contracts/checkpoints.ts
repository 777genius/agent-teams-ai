export const checkpointAvailabilityReasons = [
  'native-backing-unverified',
  'unsupported',
  'source-unavailable',
  'checkpoint-unavailable',
  'checkpoint-budget',
  'checkpoint-invalid',
  'payload-unavailable',
  'custody-unreleased',
  'history-changed',
  'configuration-changed',
  'generation-conflict',
  'sibling-unreleased',
] as const;

export type BackendCheckpointAvailabilityReason = (typeof checkpointAvailabilityReasons)[number];

/** Published application references only. Eligibility never promises native backing compatibility. */
export interface BackendMemberCheckpoints {
  memberId: string;
  sourceGeneration: string;
  status: 'owner-eligible' | 'unavailable';
  reason: BackendCheckpointAvailabilityReason;
  nativeBacking: 'unverified';
  checkpoints: {
    checkpointId: string;
    reference: string;
    status: 'owner-eligible' | 'unavailable';
    reason: BackendCheckpointAvailabilityReason;
  }[];
}
