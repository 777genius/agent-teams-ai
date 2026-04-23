#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  exitForSkippedPreflight,
  preflightOpenCodeLiveEnvironment,
} from './lib/opencode-live-preflight.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const orchestratorRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim();
const siblingOrchestrator = path.resolve(repoRoot, '..', 'agent_teams_orchestrator');

const env = {
  ...process.env,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_MIXED_RECOVERY: '1',
  OPENCODE_E2E_MIXED_RECOVERY_MULTI: process.env.OPENCODE_E2E_MIXED_RECOVERY_MULTI ?? '0',
  OPENCODE_E2E_PROJECT_PATH: process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || repoRoot,
  OPENCODE_E2E_MODEL: process.env.OPENCODE_E2E_MODEL?.trim() || 'opencode/big-pickle',
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  const runtimeRoot = orchestratorRoot ? path.resolve(orchestratorRoot) : siblingOrchestrator;
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = path.join(runtimeRoot, 'cli');
}

console.log('Running OpenCode mixed recovery live smoke');
console.log(`Model: ${env.OPENCODE_E2E_MODEL}`);
console.log(`Project: ${env.OPENCODE_E2E_PROJECT_PATH}`);
console.log(`Orchestrator CLI: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);
console.log(`Multi-lane: ${env.OPENCODE_E2E_MIXED_RECOVERY_MULTI === '1' ? 'enabled' : 'disabled'}`);

const preflight = await preflightOpenCodeLiveEnvironment({ repoRoot });
exitForSkippedPreflight(preflight);

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
    'test/main/services/team/OpenCodeMixedRecovery.live.test.ts',
  ],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (result.error) {
  console.error(`Failed to run OpenCode mixed recovery smoke: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
