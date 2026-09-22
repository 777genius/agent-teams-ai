import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { runFullTeamSmoke } from '../../scripts/prove-opencode-full-team.mjs';
import { runMixedTeamSmoke } from '../../scripts/prove-opencode-mixed-team.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const vitestEntryPath = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const probe = 'test/scripts/fixtures/opencodeProofBoundary.test.ts';

test('both wrappers cross the real Vitest config/setup/guard boundary offline', {
  skip: !fs.existsSync(vitestEntryPath)
    ? 'Pinned Vitest unavailable; coordinator: node --test test/scripts/opencodeProofVitest.integration.test.mjs'
    : false,
  timeout: 300_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-vitest-boundary-TEST-'));
  const auth = path.join(root, 'synthetic-auth.json');
  fs.writeFileSync(auth, JSON.stringify({
    selected: { type: 'api', key: 'synthetic-only' },
    zai: { type: 'api', key: 'synthetic-only' },
    xai: { type: 'oauth', refresh: 'synthetic-only' },
  }), { mode: 0o600 });
  try {
    for (const [kind, run] of [['FULL', runFullTeamSmoke], ['MIXED', runMixedTeamSmoke]]) {
      let input;
      let preflights = 0, spawns = 0;
      try {
        // Only preflight is replaced: there is no provider check/inference. The child runs
        // installed Vitest with the wrapper's exact config, setup and unmodified environment.
        await assert.rejects(run({
          vitestEntryPath,
          sourceEnv: {
            OPENCODE_E2E: '1', [`OPENCODE_E2E_${kind}_TEAM`]: '1',
            ...(kind === 'FULL' ? { OPENCODE_E2E_MODEL: 'selected/model' } : {
              OPENCODE_E2E_ZAI_MODEL: 'zai/model', OPENCODE_E2E_SUPERGROK_MODEL: 'xai/model',
            }),
            CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: process.execPath,
            CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
            OPENCODE_E2E_TEST_AUTH_PATH: auth,
            // The wrapper must drop ambient inputs before entering the real test process.
            OPENCODE_CONFIG: '/TEST/must-not-read', OPENAI_API_KEY: 'synthetic-must-not-inherit',
          },
          log() {},
          preflight: async (value) => { input = value; preflights++; return { ok: true }; },
          spawn: (command, args, options) => {
            spawns++;
            assert.equal(args[args.indexOf('--config') + 1], path.join(repoRoot, 'vitest.opencode-proof.config.ts'));
            const probeArgs = [...args.slice(0, -1), probe];
            const result = spawnSync(command, probeArgs, { ...options, timeout: 60_000 });
            assert.ifError(result.error);
            assert.equal(result.status, 0, `${kind}: ${result.stdout}\n${result.stderr}`);
            const receipt = path.join(options.env.OPENCODE_E2E_PROOF_DIRECTORY, 'boundary.json');
            assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')),
              { kind, guardPassed: true, sentryStubbed: true });
            fs.unlinkSync(receipt);
            // Negative control executes the actual shared setup. Its HOME/bookkeeping
            // mutations must fail the actual guard, so a mocked/omitted setup cannot pass.
            const defaultArgs = [...probeArgs];
            defaultArgs[defaultArgs.indexOf('--config') + 1] = path.join(repoRoot, 'vitest.config.ts');
            const control = spawnSync(command, defaultArgs, { ...options, timeout: 60_000 });
            assert.ifError(control.error);
            assert.notEqual(control.status, 0);
            assert.match(`${control.stdout}\n${control.stderr}`, /Live proof requires an intact wrapper-owned isolated environment/);
            assert.equal(fs.existsSync(receipt), false);
            return result;
          },
        }), /ENOENT.*proof\.json/);
        // A harmless boundary pass is deliberately not a paid-team proof or cleanup authorization.
        assert.equal(preflights, 1);
        assert.equal(spawns, 1);
        assert.ok(fs.existsSync(input.env.OPENCODE_E2E_OWNED_ROOT));
      } finally {
        if (input) {
          fs.rmSync(input.env.OPENCODE_E2E_OWNED_ROOT, { recursive: true, force: true });
          fs.rmSync(input.env.OPENCODE_E2E_PROOF_DIRECTORY, { recursive: true, force: true });
        }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
