#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';
import { preflightOpenCodeLiveEnvironment } from './lib/opencode-live-preflight.mjs';
import { spawnSyncWithWindowsShell } from './lib/windows-shell-spawn.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-semantic-proof-'));
const projectPath = path.join(sandboxRoot, 'project');
fs.mkdirSync(projectPath, { recursive: true });

if (process.env.OPENCODE_E2E_PROJECT_PATH?.trim()) {
  console.warn(
    'Ignoring OPENCODE_E2E_PROJECT_PATH: semantic messaging proof always uses a fresh temp sandbox.'
  );
}

const env = {
  ...process.env,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_SEMANTIC_MESSAGING: '1',
  OPENCODE_E2E_PROJECT_PATH: projectPath,
  OPENCODE_E2E_MODEL: process.env.OPENCODE_E2E_MODEL?.trim() || 'opencode/big-pickle',
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
    env,
    repoRoot,
  });
}

console.log('Running OpenCode semantic messaging live smoke');
console.log(`Model: ${env.OPENCODE_E2E_MODEL}`);
console.log(`Project: ${env.OPENCODE_E2E_PROJECT_PATH}`);
console.log(`Orchestrator CLI: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);

try {
  const preflight = await preflightOpenCodeLiveEnvironment({ repoRoot, projectPath, env });
  if (!preflight.ok) {
    console.warn(`SKIPPED: ${preflight.reason}`);
    process.exitCode = process.env.OPENCODE_E2E_STRICT === '1' ? 1 : 0;
  } else {
    const result = spawnSyncWithWindowsShell(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--maxWorkers=1',
        'test/main/services/team/OpenCodeSemanticMessaging.live.test.ts',
      ],
      {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
      }
    );

    if (result.error) {
      console.error(`Failed to run OpenCode semantic messaging smoke: ${result.error.message}`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
} finally {
  if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
    console.info(`Preserved semantic proof sandbox: ${sandboxRoot}`);
  } else {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
