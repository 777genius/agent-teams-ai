import type { RuntimeActivityEvent } from './activityContracts.js';

/** Host-owned observation only; it cannot change Runtime input, interaction or control outcomes. */
export interface RuntimeProviderActivity {
  inputId?: string;
  operationRef?: string;
  data: RuntimeActivityEvent['data'] & { kind: 'subagent' };
}

/** Original member process diagnostic only; deliberately has no input or task attribution. */
export type RuntimeProcessOutput =
  | { kind: 'process-output'; stream: 'stderr'; text: string }
  | { kind: 'gap'; reason: 'oversized' };
