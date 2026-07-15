export const projectAdmissionWorkerRoleSchemaValues = [
  "producer",
  "fastgate",
  "reviewer",
  "integration",
  "adoption",
  "read_only",
] as const;

export const projectAdmissionRefillWorkerRoleSchemaValues = [
  "producer",
  "fastgate",
  "reviewer",
  "adoption",
] as const;

export const projectAdmissionOperationSchemaValues = [
  "create_job",
  "start_worker",
  "create_worktree",
] as const;

export const controllerProviderKindSchemaValues = [
  "codex",
  "claude",
] as const;
