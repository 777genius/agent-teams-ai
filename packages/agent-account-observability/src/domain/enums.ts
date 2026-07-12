export enum AgentProvider {
  Codex = "codex",
  ClaudeCode = "claude_code",
}

export enum AuthSessionStatus {
  Authenticated = "authenticated",
  ReloginRequired = "relogin_required",
  Unknown = "unknown",
  Unavailable = "unavailable",
}

export enum AccountAvailability {
  Available = "available",
  Limited = "limited",
  ReloginRequired = "relogin_required",
  AuthUnknown = "auth_unknown",
  Unhealthy = "unhealthy",
  Unknown = "unknown",
}

export enum AccountRecommendedAction {
  None = "none",
  Wait = "wait",
  Relogin = "relogin",
  Inspect = "inspect",
}

export enum ObservationEvidenceSource {
  CodexAppServer = "codex_app_server",
  CodexAuthJson = "codex_auth_json",
  CodexExecProbe = "codex_exec_probe",
  ClaudeCodeAuthStatus = "claude_code_auth_status",
  ClaudeCodeStatusline = "claude_code_statusline",
  Cache = "cache",
}

export enum ObservationEvidenceKind {
  Auth = "auth",
  Quota = "quota",
  Probe = "probe",
  Cache = "cache",
}

export enum ObservationEvidenceConfidence {
  High = "high",
  Medium = "medium",
  Low = "low",
}

export enum QuotaWindowKind {
  FiveHour = "five_hour",
  SevenDay = "seven_day",
  Rolling = "rolling",
  WorkspaceCredits = "workspace_credits",
  Unknown = "unknown",
}

export enum QuotaLimitState {
  Clear = "clear",
  Limited = "limited",
  Unknown = "unknown",
}
