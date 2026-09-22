// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { afterEach, describe, expect, it, vi } from 'vitest';

const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }));

// Only credential/environment ports are replaced; execution and parsing stay real.
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildPassiveProviderStatusCliEnv: () => ({ env: isolated.env, connectionIssues: {} }),
}));
vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    applyPassiveProviderStatusConnectionEnv: (env: NodeJS.ProcessEnv) => Promise.resolve(env),
  },
}));

// This disposable program accepts only the passive summary, never launches a team,
// and exits naturally after its single delayed response (also if the test fails).
const summaryProgram = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const providerId = args[4];
if (!['opencode', 'anthropic'].includes(providerId) ||
    JSON.stringify(args) !== JSON.stringify(['runtime', 'status', '--json', '--provider', providerId, '--summary'])) {
  throw new Error('Sandbox fixture only accepts provider summary');
}
const startedAt = Date.now();
const capture = {
  args, pid: process.pid, home: process.env.HOME,
  config: process.env.XDG_CONFIG_HOME, shim: process.env.SUMMARY_CMD_SHIM,
};
fs.appendFileSync(path.join(process.env.HOME, 'calls.jsonl'), JSON.stringify(capture) + '\\n');
setTimeout(() => {
  console.log(JSON.stringify({ providers: { [providerId]: {
    providerId, supported: true, authenticated: false, authMethod: null,
    verificationState: 'unknown', canLoginFromUi: false,
    capabilities: { teamLaunch: false, oneShot: false, extensions: {} },
    selectedBackendId: null, resolvedBackendId: null, availableBackends: [],
    externalRuntimeDiagnostics: [], backend: null, models: [],
    statusCheckOutcome: 'authoritative', statusMessage: 'Sandbox delayed summary',
    detailMessage: String(Date.now() - startedAt),
  } } }));
}, 8000);
`;

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('Provider summary timeout subprocess integration', () => {
  let sandbox: string | undefined;

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      sandbox = undefined;
    }
  });

  it.each(['opencode', 'anthropic'] as const)(
    'parses an authoritative %s summary after eight seconds',
    async (providerId) => {
      sandbox = await mkdtemp(path.join(os.tmpdir(), 'provider summary sandbox '));
      const config = path.join(sandbox, 'fresh config');
      await mkdir(config);
      isolated.env = {
        HOME: sandbox,
        USERPROFILE: sandbox,
        XDG_CONFIG_HOME: config,
        CLAUDE_CONFIG_DIR: config,
        APPDATA: config,
        LOCALAPPDATA: config,
        XDG_DATA_HOME: config,
        XDG_CACHE_HOME: config,
        TEMP: sandbox,
        TMP: sandbox,
        PATH: '',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      };
      const program = path.join(sandbox, 'summary fixture.cjs');
      const launcher = path.join(sandbox, process.platform === 'win32' ? 'summary.cmd' : 'summary');
      await writeFile(program, summaryProgram);
      // Deliberately not an npm/Bun shim: Windows must execute the actual .cmd
      // fallback. Its environment marker proves the batch body was evaluated.
      await writeFile(
        launcher,
        process.platform === 'win32'
          ? `@echo off\r\nset "SUMMARY_CMD_SHIM=executed"\r\n"${process.execPath}" "${program}" %*\r\n`
          : `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(program)} "$@"\n`
      );
      await chmod(launcher, 0o755);

      const status = await new ClaudeMultimodelBridgeService().getProviderStatus(
        launcher,
        providerId
      );

      expect(status).toMatchObject({
        providerId,
        supported: true,
        authenticated: false,
        statusCheckOutcome: 'authoritative',
        statusMessage: 'Sandbox delayed summary',
        capabilities: { teamLaunch: false },
      });
      expect(status.statusCheckErrorCode).toBeUndefined();
      expect(Number(status.detailMessage)).toBeGreaterThanOrEqual(8000);
      const calls = (await readFile(path.join(sandbox, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        expect.objectContaining({
          args: ['runtime', 'status', '--json', '--provider', providerId, '--summary'],
          home: sandbox,
          config,
          ...(process.platform === 'win32' ? { shim: 'executed' } : {}),
        }),
      ]);
      expect(calls[0].pid).not.toBe(process.pid);
    },
    20_000
  );
});
