#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const env = {
  ...process.env,
  AGENT_CLI_LAUNCH_LIVE_E2E: '1',
  CLAUDE_TEAM_CLI_FLAVOR: process.env.CLAUDE_TEAM_CLI_FLAVOR || 'agent_teams_orchestrator',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
    env,
    repoRoot,
  });
}

console.log('Running agent CLI launch live smoke');
console.log(`Claude runtime: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--maxWorkers',
    '1',
    '--minWorkers',
    '1',
    'test/main/utils/AgentCliLaunch.live-e2e.test.ts',
  ],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (result.error) {
  console.error(`Failed to run agent CLI launch smoke: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
