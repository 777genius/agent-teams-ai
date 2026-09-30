import { TEAM_GET_RUNTIME_LOGS, TEAM_RETRY_FAILED_RUNTIME_LANES } from '../channels';

import type { RetryFailedOpenCodeSecondaryLanesResult as LegacyRetryResult } from '@shared/types';

export const TEAM_GET_CLAUDE_LOGS = TEAM_GET_RUNTIME_LOGS;
export const TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES = TEAM_RETRY_FAILED_RUNTIME_LANES;

export type RetryFailedOpenCodeSecondaryLanesResult = LegacyRetryResult;
