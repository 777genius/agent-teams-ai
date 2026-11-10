#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSyncWithWindowsShell } from './lib/windows-shell-spawn.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const stageScriptPath = path.join(scriptDir, 'stage-terminal-platform-runtime.mjs');

function runOrExit(cmd, args) {
  const result = spawnSyncWithWindowsShell(cmd, args, {
    cwd: path.resolve(scriptDir, '..'),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runOrExit(process.execPath, [stageScriptPath, '--ensure', ...process.argv.slice(2)]);
