/** Safe catalog metadata, separate from conversation Session SPI and native config/auth values. */
export interface ClaudeMetadataSnapshot {
  profileId: string;
  configRevision: string;
  /** Credential routing observations, never an authentication or model execution proof. */
  account: {
    apiProvider: string | null;
    tokenSource: string | null;
    apiKeySource: string | null;
    subscriptionType: string | null;
  };
  models: {
    modelId: string;
    resolvedModel: string | null;
    displayName: string;
    description: string;
    supportedEffortLevels: (
      | 'none'
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max'
      | 'ultra'
    )[];
    supportsFastMode: boolean | null;
  }[];
}

export interface ProviderCredentialReceipt {
  commandId: string;
  profileId: string;
  configRevision: string;
  kind: 'credential.set' | 'credential.forget' | 'credential.refresh';
  providerId: string;
  phase: 'completed' | 'held';
}

export interface ProviderModelProbeLimits {
  contextTokens: number;
  outputTokens: number;
}

/** Explicit one-off model request. No native session IDs, text, paths or auth values. */
export interface ProviderModelProbeSnapshot {
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  modelContext?: 'model-default' | 'one-million';
  context?: string;
  commandId: string;
  profileId: string;
  configRevision: string;
  providerId: string;
  modelId: string;
  phase: 'running' | 'completed' | 'cancelled' | 'held';
  ok: boolean;
  limits?: ProviderModelProbeLimits;
  expiresAt: number;
}

/** Safe progress only. Authorization URLs/codes and native instructions are Main-only. */
export interface ProviderOAuthSnapshot {
  operationId: string;
  profileId: string;
  configRevision: string;
  providerId: string;
  methodIndex: number;
  phase:
    | 'authorizing'
    | 'waiting-for-code'
    | 'waiting-for-browser'
    | 'completing'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'held';
  completionMethod: 'auto' | 'code' | null;
  sequence: number;
  expiresAt: number;
  reason?: 'cancelled' | 'expired' | 'native-outcome-unknown' | 'owner-changed';
}

export interface ProviderManagementCatalog {
  profileId: string;
  configRevision: string;
  /** Effective native config only, before Desktop project/global product preferences. */
  configuredDefaultModelId?: string | null;
  providers: {
    providerId: string;
    displayName: string;
    source: 'env' | 'config' | 'custom' | 'api' | null;
    connected: boolean;
    configured: boolean;
    configuredAuthless?: boolean;
    defaultModelId: string | null;
    modelCount: number;
    /** Populated only for an explicit provider selection, keeping directory reads bounded. */
    models: {
      modelId: string;
      displayName: string;
      contextTokens: number | null;
      outputTokens: number | null;
      free: boolean | null;
      declaredInputModalities?: readonly string[] | null;
    }[];
    authMethods: ('api' | 'oauth')[];
    /** Explicit provider reads only; native indices remain stable across omitted unknown methods. */
    authOptions?: ProviderAuthenticationMethod[];
  }[];
}

export interface ProviderAuthenticationMethod {
  methodIndex: number;
  type: 'api' | 'oauth';
  label: string;
  supported: boolean;
  prompts: {
    key: string;
    type: 'text' | 'select';
    label: string;
    placeholder: string | null;
    options: { label: string; value: string; hint: string | null }[];
    when: { key: string; op: string; value: string } | null;
  }[];
}

/** Read-only native Codex projection. No credentials, native home, executable or thread IDs. */
export interface CodexMetadataSnapshot {
  rateLimits?: {
    state: 'ready' | 'not-requested' | 'not-authenticated' | 'unavailable';
    snapshot: CodexQuotaSnapshot | null;
  };
  profileId: string;
  configRevision: string;
  account: { type: 'apiKey' } | { type: 'chatgpt'; email: string; planType: string } | null;
  requiresOpenaiAuth: boolean;
  configuration: {
    model: string | null;
    modelProvider: string | null;
    reasoningEffort: string | null;
  };
  models: {
    id: string;
    model: string;
    displayName: string;
    description: string | null;
    hidden: boolean;
    isDefault: boolean;
    supportedReasoningEfforts: readonly string[];
    defaultReasoningEffort: string | null;
    inputModalities: readonly string[];
    supportsPersonality: boolean;
  }[];
}

export interface CodexQuotaSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  secondary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
}
