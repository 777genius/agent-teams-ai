#!/usr/bin/env node
// Fixture-only executable. Typechecked with the desktop harness; no provider is ever started.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

const audit = process.env.TASK_FOLDERS_E2E_RUNTIME_AUDIT;
const version = process.env.TASK_FOLDERS_E2E_RUNTIME_VERSION;
assert(audit && version, 'Missing disposable runtime fixture environment');
const args = process.argv.slice(2);
appendFileSync(audit, JSON.stringify(args) + '\n');
if (args.length === 1 && args[0] === '--version') console.log(version);
else process.exitCode = 77;
