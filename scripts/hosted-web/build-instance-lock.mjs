#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourcePath = resolve(
  repositoryRoot,
  'native/hosted/instance-lock/agent_teams_instance_lock.c'
);

function usage() {
  throw new Error('usage: build-instance-lock.mjs [--test-hooks] --output ABS_OR_RELATIVE_OUTPUT');
}

if (process.platform !== 'linux') {
  throw new Error('agent-teams-instance-lock is a Linux-only artifact');
}

const args = process.argv.slice(2);
const testHooks = args[0] === '--test-hooks';
const outputArgs = testHooks ? args.slice(1) : args;
if (outputArgs.length !== 2 || outputArgs[0] !== '--output' || outputArgs[1].length === 0) {
  usage();
}

const outputPath = resolve(process.cwd(), outputArgs[1]);
const compiler = process.env.CC || 'cc';
const testHookFlags = testHooks ? ['-DAGENT_TEAMS_INSTANCE_LOCK_TEST_HOOKS=1'] : [];
const result = spawnSync(
  compiler,
  [
    '-std=c17',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Wconversion',
    '-Werror',
    ...testHookFlags,
    '-o',
    outputPath,
    sourcePath,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`instance-lock compiler exited with status ${String(result.status)}`);
}
