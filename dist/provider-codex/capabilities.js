export const codexProviderId = "codex";
export const codexAgentId = "codex-cli";
export const codexJsonAgentId = "codex-json";
export const codexAuthJsonFormatVersion = "codex-auth-json-v1";
export const codexEnvironmentPolicy = {
    inheritHostEnvironment: false,
    allowlist: ["PATH", "HOME", "CI", "CODEX_HOME"],
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
        "INPUT_AUTH*",
        "*CODEX_AUTH_JSON*",
        "*OPENAI_API_KEY*",
        "*CLAUDE_CODE_OAUTH_TOKEN*",
        "*OPENROUTER_API_KEY*",
        "*REVIEW_ROUTER_COMMENT_TOKEN*",
        "*REVIEWROUTER_PROXY_NONCE*",
    ],
    credentialSourceOrder: ["codex-auth-json-file"],
};
export const codexSessionCapabilities = {
    providerId: codexProviderId,
    displayName: "Codex",
    sessionRequirement: {
        kind: "required",
        artifactKinds: ["json-file"],
    },
    sessionArtifactKinds: ["json-file"],
    refreshMode: "always-before-run",
    sessionRotationMode: "may-rotate",
    environmentPolicy: codexEnvironmentPolicy,
    supportsRefresh: true,
    refreshMayRotateSession: true,
    supportsNonInteractiveRuntime: true,
    requiresNetwork: true,
    requiresWorkspace: true,
    supportsStructuredOutput: true,
    supportsReadOnlySandbox: true,
    defaultTimeoutMs: 600_000,
    setupModes: ["device-auth", "import-local-session"],
};
export const codexAgentCapabilities = {
    agentId: codexAgentId,
    providerId: codexProviderId,
    taskModes: ["review", "structured-prompt", "health-check"],
    historyMode: "none",
    supportsReviewTasks: true,
    supportsStructuredOutput: true,
    supportsToolCalling: false,
    supportsRepositoryContext: true,
    supportsInlineFindings: true,
    requiresWritableWorkspace: false,
    maxRuntimeMs: 600_000,
};
export const codexJsonAgentCapabilities = {
    ...codexAgentCapabilities,
    agentId: codexJsonAgentId,
};
//# sourceMappingURL=capabilities.js.map