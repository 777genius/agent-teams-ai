export type CodexAccountAuthMode = 'auto' | 'chatgpt' | 'api_key';
export type CodexAccountEffectiveAuthMode = 'chatgpt' | 'api_key' | null;
export type CodexAccountPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'team'
  | 'business'
  | 'enterprise'
  | 'edu'
  | 'unknown';
export type CodexAccountAppServerState =
  | 'healthy'
  | 'degraded'
  | 'runtime-missing'
  | 'incompatible';
export type CodexAccountLoginStatus = 'idle' | 'starting' | 'pending' | 'failed' | 'cancelled';
export type CodexLaunchReadinessState =
  | 'ready_chatgpt'
  | 'ready_api_key'
  | 'ready_both'
  | 'missing_auth'
  | 'warning_degraded_but_launchable'
  | 'runtime_missing'
  | 'incompatible';

export interface CodexManagedAccountDto {
  type: 'chatgpt' | 'api_key';
  email: string | null;
  planType: CodexAccountPlanType | null;
}

export interface CodexApiKeyAvailabilityDto {
  available: boolean;
  source: 'stored' | 'environment' | null;
  sourceLabel: string | null;
}

export interface CodexRateLimitWindowDto {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCreditsSnapshotDto {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshotDto {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindowDto | null;
  secondary: CodexRateLimitWindowDto | null;
  credits: CodexCreditsSnapshotDto | null;
  planType: CodexAccountPlanType | null;
}

export interface CodexLoginStateDto {
  status: CodexAccountLoginStatus;
  error: string | null;
  startedAt: string | null;
}

export interface CodexAccountSnapshotDto {
  preferredAuthMode: CodexAccountAuthMode;
  effectiveAuthMode: CodexAccountEffectiveAuthMode;
  launchAllowed: boolean;
  launchIssueMessage: string | null;
  launchReadinessState: CodexLaunchReadinessState;
  appServerState: CodexAccountAppServerState;
  appServerStatusMessage: string | null;
  managedAccount: CodexManagedAccountDto | null;
  apiKey: CodexApiKeyAvailabilityDto;
  requiresOpenaiAuth: boolean | null;
  localAccountArtifactsPresent?: boolean;
  localActiveChatgptAccountPresent?: boolean;
  login: CodexLoginStateDto;
  rateLimits: CodexRateLimitSnapshotDto | null;
  updatedAt: string;
}
