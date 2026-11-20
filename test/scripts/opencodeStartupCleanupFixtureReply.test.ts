import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenCodeBridgeCommandClient } from '../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  isStartupCleanupData,
  executeOpenCodeStartupCleanup,
} from '../../src/main/services/team/opencode/bridge/OpenCodeStartupCleanupBridge';
import { OpenCodeStartupCleanupBudget } from '../../src/main/services/team/opencode/bridge/OpenCodeStartupCleanupBudget';

import type { OpenCodeBridgeProcessRunInput } from '../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';

const require = createRequire(import.meta.url);
const { answerStartupCleanup } = require('../../scripts/e2e/lib/opencodeStartupCleanupReply.cjs') as {
  answerStartupCleanup(
    args: string[],
    platform?: NodeJS.Platform
  ): { line: string; outputPath?: string } | null;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The denying fixture runtime of the desktop E2Es, as the bridge client talks to it on Windows. */
function fixtureRunner(platform: NodeJS.Platform) {
  const seen: string[][] = [];
  return {
    seen,
    async run(input: OpenCodeBridgeProcessRunInput) {
      seen.push(input.args);
      const reply = answerStartupCleanup(input.args, platform);
      if (!reply) return { stdout: '', stderr: 'denied', exitCode: 77, timedOut: false };
      if (reply.outputPath) await writeFile(reply.outputPath, `${reply.line}\n`);
      return { stdout: `${reply.line}\n`, stderr: '', exitCode: 0, timedOut: false };
    },
  };
}

async function clientFor(platform: NodeJS.Platform) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-cleanup-reply-'));
  roots.push(root);
  const runner = fixtureRunner(platform);
  const client = new OpenCodeBridgeCommandClient({
    binaryPath: path.join(root, 'fixture-runtime'),
    tempDirectory: path.join(root, 'bridge'),
    processRunner: runner,
    env: {},
  });
  return { client, runner, root };
}

describe('the fixture runtime answer to the Windows OpenCode startup cleanup', () => {
  it('is a result the real bridge client and the startup cleanup accept as drained and complete', async () => {
    const { client, runner } = await clientFor('win32');
    const result = await executeOpenCodeStartupCleanup(client, new OpenCodeStartupCleanupBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isStartupCleanupData(result.data)).toBe(true);
    expect(result.data.startupCleanup).toEqual({
      completion: 'drained',
      coverage: 'complete',
      survivingPids: [],
    });
    expect(result.data).toMatchObject({ cleaned: 0, remaining: 0, hosts: [] });
    // It is the documented bridge invocation, the one the audit already allows.
    expect(runner.seen[0].slice(0, 3)).toEqual(['runtime', 'opencode-command', '--json']);
  });

  it('answers on Windows only: Linux and macOS keep denying it', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const { client } = await clientFor(platform);
      const result = await executeOpenCodeStartupCleanup(client, new OpenCodeStartupCleanupBudget());
      expect(result.ok).toBe(false);
    }
  });

  it('answers nothing else: every other bridge command and other runtime call stays denied', async () => {
    const { root } = await clientFor('win32');
    const input = path.join(root, 'other-command.json');
    await writeFile(
      input,
      JSON.stringify({ schemaVersion: 1, requestId: 'r', command: 'opencode.launchTeam' })
    );
    expect(
      answerStartupCleanup(['runtime', 'opencode-command', '--json', '--input', input], 'win32')
    ).toBeNull();
    expect(answerStartupCleanup(['auth', 'status'], 'win32')).toBeNull();
    expect(answerStartupCleanup(['--print', '--output-format', 'stream-json'], 'win32')).toBeNull();
    expect(
      answerStartupCleanup(['runtime', 'opencode-command', '--json', '--input', path.join(root, 'missing')], 'win32')
    ).toBeNull();
    expect(await readFile(input, 'utf8')).toContain('opencode.launchTeam');
  });
});
