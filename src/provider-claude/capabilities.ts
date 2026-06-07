import type {
  AgentCapabilities,
  ProviderCapabilities,
  ProviderEnvironmentPolicy,
} from "@vioxen/subscription-runtime/core";

export const claudeProviderId = "claude";
export const claudeBgTaskAgentId = "claude-bg-task";
export const claudeSessionFormatVersion = "claude-oauth-session-v1";

export const claudeEnvironmentPolicy: ProviderEnvironmentPolicy = {
  inheritHostEnvironment: false,
  allowlist: ["PATH", "HOME", "CI", "CLAUDE_CONFIG_DIR"],
  denylist: [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_STATE",
    "NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "GIT_*",
    "*CLAUDE_CODE_OAUTH_TOKEN*",
    "*ANTHROPIC_API_KEY*",
    "*OPENAI_API_KEY*",
    "*OPENROUTER_API_KEY*",
    "*CODEX_AUTH_JSON*",
    "*REVIEW_ROUTER_COMMENT_TOKEN*",
    "*REVIEWROUTER_PROXY_NONCE*",
  ],
  credentialSourceOrder: ["claude-oauth-token", "claude-config-dir"],
};

export const claudeSessionCapabilities: ProviderCapabilities = {
  providerId: claudeProviderId,
  displayName: "Claude",
  sessionRequirement: {
    kind: "required",
    artifactKinds: ["json-file", "env-token"],
  },
  sessionArtifactKinds: ["json-file", "env-token"],
  refreshMode: "validate-only",
  sessionRotationMode: "never-rotates",
  environmentPolicy: claudeEnvironmentPolicy,
  supportsRefresh: false,
  refreshMayRotateSession: false,
  supportsNonInteractiveRuntime: true,
  requiresNetwork: true,
  requiresWorkspace: true,
  supportsStructuredOutput: true,
  supportsReadOnlySandbox: true,
  defaultTimeoutMs: 30 * 60 * 1000,
  setupModes: ["device-auth", "browser-auth", "import-local-session"],
};

export const claudeBgTaskAgentCapabilities: AgentCapabilities = {
  agentId: claudeBgTaskAgentId,
  providerId: claudeProviderId,
  taskModes: ["review", "structured-prompt", "health-check"],
  historyMode: "none",
  executionModes: ["task"],
  toolPolicyMode: "provider-enforced",
  outputModes: ["text", "json"],
  supportsReviewTasks: true,
  supportsStructuredOutput: true,
  supportsToolCalling: true,
  supportsRepositoryContext: true,
  supportsInlineFindings: true,
  requiresWritableWorkspace: false,
  supportsStreaming: true,
  supportsUsageTelemetry: true,
  supportsCostTelemetry: false,
  supportsProviderRunId: true,
  supportsAbort: true,
  supportsCleanup: true,
  maxRuntimeMs: 30 * 60 * 1000,
};
