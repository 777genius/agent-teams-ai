export enum RunEventProviderKind {
  Codex = "codex",
  Claude = "claude",
  Local = "local",
  AgentTask = "agent-task",
  Unknown = "unknown",
}

export function runEventProviderKindFromString(value: string): RunEventProviderKind {
  switch (value) {
    case RunEventProviderKind.Codex:
      return RunEventProviderKind.Codex;
    case RunEventProviderKind.Claude:
      return RunEventProviderKind.Claude;
    case RunEventProviderKind.Local:
      return RunEventProviderKind.Local;
    case RunEventProviderKind.AgentTask:
      return RunEventProviderKind.AgentTask;
    default:
      return RunEventProviderKind.Unknown;
  }
}

export function isRunEventProviderKind(value: string): value is RunEventProviderKind {
  return Object.values(RunEventProviderKind).includes(value as RunEventProviderKind);
}
