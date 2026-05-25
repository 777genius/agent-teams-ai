import path from 'node:path';

export function resolveLiveSmokeOrchestratorCliPath({
  env = process.env,
  repoRoot,
} = {}) {
  const explicitCliPath = env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
  if (explicitCliPath) {
    return explicitCliPath;
  }

  const configuredRuntimeRoot = env.CLAUDE_DEV_RUNTIME_ROOT?.trim();
  const baseRepoRoot = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const runtimeRoot = configuredRuntimeRoot
    ? path.resolve(configuredRuntimeRoot)
    : path.resolve(baseRepoRoot, '..', 'agent_teams_orchestrator');

  return path.join(runtimeRoot, 'cli-source');
}

export function resolveReleaseSmokeOrchestratorCliPath({
  env = process.env,
  repoRoot,
} = {}) {
  const explicitCliPath = env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
  if (explicitCliPath) {
    return explicitCliPath;
  }

  const configuredRuntimeRoot = env.CLAUDE_DEV_RUNTIME_ROOT?.trim();
  const baseRepoRoot = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const runtimeRoot = configuredRuntimeRoot
    ? path.resolve(configuredRuntimeRoot)
    : path.resolve(baseRepoRoot, '..', 'agent_teams_orchestrator');

  return path.join(runtimeRoot, 'cli');
}
