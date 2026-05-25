#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';
import {
  exitForSkippedPreflight,
  preflightOpenCodeLiveEnvironment,
} from './lib/opencode-live-preflight.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const env = {
  ...process.env,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET: '1',
  OPENCODE_E2E_MODEL: process.env.OPENCODE_E2E_MODEL?.trim() || 'opencode/big-pickle',
  OPENCODE_E2E_GAUNTLET_RUNS: process.env.OPENCODE_E2E_GAUNTLET_RUNS?.trim() || '1',
  OPENCODE_E2E_GAUNTLET_MIN_AVERAGE_SCORE:
    process.env.OPENCODE_E2E_GAUNTLET_MIN_AVERAGE_SCORE?.trim() || '80',
  OPENCODE_E2E_GAUNTLET_MIN_SUCCESSFUL_RUNS:
    process.env.OPENCODE_E2E_GAUNTLET_MIN_SUCCESSFUL_RUNS?.trim() || '1',
  OPENCODE_E2E_GAUNTLET_MIN_CONSISTENCY_SCORE:
    process.env.OPENCODE_E2E_GAUNTLET_MIN_CONSISTENCY_SCORE?.trim() || '0',
  OPENCODE_E2E_GAUNTLET_REQUIRE_RECOMMENDED:
    process.env.OPENCODE_E2E_GAUNTLET_REQUIRE_RECOMMENDED?.trim() || '1',
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
    env,
    repoRoot,
  });
}

console.log('Running OpenCode semantic gauntlet live smoke');
console.log(`Models: ${env.OPENCODE_E2E_MODELS?.trim() || env.OPENCODE_E2E_MODEL}`);
console.log(`Runs per model: ${env.OPENCODE_E2E_GAUNTLET_RUNS}`);
console.log(`Orchestrator CLI: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);

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
    'test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts',
  ],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (result.error) {
  console.error(`Failed to run OpenCode semantic gauntlet smoke: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
