#!/usr/bin/env bun
// TEST-only scoped catalog fixture. Every other command uses the real source runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, readFile, realpath } from 'node:fs/promises';

interface FixtureConfig {
  runtimeSource: string;
  project: string;
  delayedProject: string;
  release: string;
  journal: string;
  models: Array<{ modelId: string; declaredInputModalities: string[] | null }>;
}
const file = process.env.OPENCODE_MODALITIES_E2E_CONFIG;
assert(file, 'OPENCODE_MODALITIES_E2E_CONFIG is required');
const config = JSON.parse(await readFile(file, 'utf8')) as FixtureConfig;
const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--provider');
const source = sourceIndex < 0 ? undefined : args[sourceIndex + 1];
const runtimeIndex = args.indexOf('--runtime');
const runtime = runtimeIndex < 0 ? undefined : args[runtimeIndex + 1];
const isModelRequest = args.slice(0, 3).join(' ') === 'runtime providers models';
const cwd = isModelRequest ? await realpath(process.cwd()) : null;
if (
  isModelRequest &&
  runtime === 'opencode' &&
  source === 'openrouter' &&
  (cwd === config.project || cwd === config.delayedProject)
) {
  if (cwd === config.delayedProject) {
    await appendFile(config.journal, `${JSON.stringify({ event: 'pending', cwd })}\n`);
    const deadline = Date.now() + 20000;
    // An ungrouped main subscriber keeps this shared catalog request alive after UI cancellation.
    while (true) {
      assert(Date.now() < deadline, 'TEST catalog gate was not released');
      if ((await readFile(config.release, 'utf8').catch(() => '')) === 'release') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const response = {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: source,
      defaultModelId: null,
      diagnostics: [],
      catalogState: 'fresh',
      totalCount: config.models.length,
      returnedCount: config.models.length,
      cursor: null,
      nextCursor: null,
      models: config.models.map((model) => ({
        ...model,
        providerId: source,
        displayName: model.modelId,
        sourceLabel: 'scripted TEST catalog',
        free: true,
        default: false,
        availability: 'available',
      })),
    },
  };
  await appendFile(
    config.journal,
    `${JSON.stringify({ event: 'response', cwd, args, response })}\n`
  );
  process.stdout.write(`${JSON.stringify(response)}\n`);
} else {
  const child = spawn(config.runtimeSource, args, { stdio: 'inherit', env: process.env });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
