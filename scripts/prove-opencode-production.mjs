#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultEvidencePath = path.join(
  resolveAppDataDir(),
  'claude-agent-teams-ui',
  'opencode-bridge',
  'production-e2e-evidence.json'
);
const orchestratorRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim();
const siblingOrchestrator = path.resolve(repoRoot, '..', 'agent_teams_orchestrator');

const env = {
  ...process.env,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_PROJECT_PATH: process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || repoRoot,
  OPENCODE_E2E_MODEL: process.env.OPENCODE_E2E_MODEL?.trim() || 'opencode/big-pickle',
  OPENCODE_E2E_WRITE_APP_EVIDENCE: '1',
  OPENCODE_E2E_WRITE_EVIDENCE_PATH:
    process.env.OPENCODE_E2E_WRITE_EVIDENCE_PATH?.trim() ||
    process.env.CLAUDE_TEAM_OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH?.trim() ||
    defaultEvidencePath,
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  const runtimeRoot = orchestratorRoot ? path.resolve(orchestratorRoot) : siblingOrchestrator;
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = path.join(runtimeRoot, 'cli');
}

console.log('Running OpenCode production proof');
console.log(`Model: ${env.OPENCODE_E2E_MODEL}`);
console.log(`Project: ${env.OPENCODE_E2E_PROJECT_PATH}`);
console.log(`Evidence: ${env.OPENCODE_E2E_WRITE_EVIDENCE_PATH}`);
console.log(`Orchestrator CLI: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'test/main/services/team/OpenCodeProductionGate.live.test.ts'],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (result.error) {
  console.error(`Failed to run OpenCode production proof: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function resolveAppDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }

  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
