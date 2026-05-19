export type CodexAppServerPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'team'
  | 'business'
  | 'enterprise'
  | 'edu'
  | 'unknown';

export type CodexAppServerAuthMode = 'apikey' | 'chatgpt' | 'chatgptAuthTokens';

export interface CodexAppServerInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type CodexAppServerAccount =
  | { type: 'apiKey' }
  | {
      type: 'chatgpt';
      email: string;
      planType: CodexAppServerPlanType;
    };

export interface CodexAppServerGetAccountResponse {
  account: CodexAppServerAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexAppServerGetAccountParams {
  refreshToken: boolean;
}

export type CodexAppServerLoginAccountParams =
  | {
      type: 'apiKey';
      apiKey: string;
    }
  | {
      type: 'chatgpt';
    }
  | {
      type: 'chatgptAuthTokens';
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType?: string | null;
    };

export type CodexAppServerLoginAccountResponse =
  | { type: 'apiKey' }
  | {
      type: 'chatgpt';
      loginId: string;
      authUrl: string;
    }
  | { type: 'chatgptAuthTokens' };

export type CodexAppServerLogoutAccountResponse = Record<string, never>;

export interface CodexAppServerRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexAppServerCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexAppServerRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexAppServerRateLimitWindow | null;
  secondary: CodexAppServerRateLimitWindow | null;
  credits: CodexAppServerCreditsSnapshot | null;
  planType: CodexAppServerPlanType | null;
}

export interface CodexAppServerGetAccountRateLimitsResponse {
  rateLimits: CodexAppServerRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexAppServerRateLimitSnapshot | undefined> | null;
}

export interface CodexAppServerAccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface CodexAppServerAccountUpdatedNotification {
  authMode: CodexAppServerAuthMode | null;
  planType: CodexAppServerPlanType | null;
}

export interface CodexAppServerAccountRateLimitsUpdatedNotification {
  rateLimits: CodexAppServerRateLimitSnapshot;
}

export interface CodexAppServerCancelLoginAccountParams {
  loginId: string;
}

export type CodexAppServerCancelLoginAccountStatus = 'canceled' | 'notFound';

export interface CodexAppServerCancelLoginAccountResponse {
  status: CodexAppServerCancelLoginAccountStatus;
}

export type CodexAppServerReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface CodexAppServerReasoningEffortOption {
  reasoningEffort?: string;
  description?: string | null;
}

export interface CodexAppServerModel {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: (string | CodexAppServerReasoningEffortOption)[];
  defaultReasoningEffort?: string | null;
  inputModalities?: string[] | null;
  supportsPersonality?: boolean;
  isDefault?: boolean;
  upgrade?: boolean | string | null;
  upgradeInfo?: unknown;
}

export interface CodexAppServerListModelsParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean;
}

export interface CodexAppServerListModelsResponse {
  data?: CodexAppServerModel[];
  models?: CodexAppServerModel[];
  nextCursor?: string | null;
  truncated?: boolean;
}

export interface CodexAppServerReadConfigParams {
  cwd?: string;
  profile?: string;
}

export interface CodexAppServerReadConfigResponse {
  config?: Record<string, unknown>;
  origins?: Record<string, unknown>;
}
