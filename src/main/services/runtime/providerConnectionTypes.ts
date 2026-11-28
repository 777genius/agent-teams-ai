export type ExternalCredential = {
  label: string;
  value: string;
} | null;

export interface StoredApiKeyAccessOptions {
  allowStoredApiKeyDecryption?: boolean;
  allowedStoredApiKeyEnvVarNames?: readonly string[];
  allowClaudeUserSettingsAuthEnv?: boolean;
}

export interface CodexLaunchSnapshotRefreshOptions {
  refreshRuntimeMissing?: boolean;
  refreshBlockedLaunch?: boolean;
}
