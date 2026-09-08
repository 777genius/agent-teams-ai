import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import {
  preserveRotatedSelectedOAuth,
  runMixedTeamSmoke,
} from '../../scripts/prove-opencode-mixed-team.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-team-wrapper-TEST-'));
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(
    auth,
    JSON.stringify({
      'zai-coding-plan': { type: 'api', key: 'synthetic-secret' },
      xai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' },
      unrelated: { type: 'api', key: 'unrelated-synthetic-secret' },
    })
  );
  return {
    root,
    env: {
      OPENCODE_E2E_ZAI_MODEL: 'zai-coding-plan/model',
      OPENCODE_E2E_SUPERGROK_MODEL: 'xai/grok-test',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
      OPENCODE_E2E_TEST_AUTH_PATH: auth,
    },
  };
}
function cleanup(input) {
  if (!input) return;
  fs.rmSync(path.dirname(input.env.HOME), { recursive: true, force: true });
  fs.rmSync(input.env.OPENCODE_E2E_PROOF_DIRECTORY, { recursive: true, force: true });
}

test('isolates auth/home/config and retains cleanup-confirmed proof after success', async () => {
  const { root, env } = fixture();
  let input;
  try {
    const status = await runMixedTeamSmoke({
      sourceEnv: {
        ...env,
        HOME: '/real-home',
        OPENCODE_CONFIG: '/real-config',
        ZAI_API_KEY: 'must-not-inherit',
      },
      log() {},
      preflight: async (value) => {
        input = value;
        assert.deepEqual(value.requiredModels, ['zai-coding-plan/model', 'xai/grok-test']);
        assert.equal(value.projectPath, fs.realpathSync(value.projectPath));
        assert.equal(value.env.OPENCODE_E2E_OWNED_PROJECT_PATH, value.projectPath);
        assert.ok(value.env.CLAUDE_MULTIMODEL_DATA_HOME.startsWith(path.dirname(value.env.HOME)));
        assert.notEqual(value.env.CLAUDE_MULTIMODEL_DATA_HOME, value.env.HOME);
        assert.equal(value.env.OPENCODE_CONFIG, undefined);
        assert.equal(value.env.ZAI_API_KEY, undefined);
        assert.notEqual(value.env.HOME, '/real-home');
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(value.env.XDG_DATA_HOME, 'opencode/auth.json'))),
          {
            'zai-coding-plan': { type: 'api', key: 'synthetic-secret' },
            xai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' },
          }
        );
        return { ok: true };
      },
      spawn: (_command, args, options) => {
        assert.equal(
          args.at(-1),
          'test/main/services/team/OpenCodeMixedTeamCollaboration.live.test.ts'
        );
        assert.equal(options.env.OPENCODE_E2E_MIXED_TEAM, '1');
        assert.equal(options.stdio, 'pipe');
        assert.equal(options.timeout, 30 * 60_000);
        fs.writeFileSync(
          path.join(options.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'),
          JSON.stringify({
            status: 'passed',
            cleanupConfirmed: true,
            models: ['zai-coding-plan/model', 'xai/grok-test'],
            finalStopConfirmed: true,
            independentAssertionsPassed: true,
            evidence: [{}, {}, {}, {}],
            peerAcknowledgements: [{}, {}, {}, {}],
          })
        );
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(fs.existsSync(input.projectPath), false);
    assert.equal(fs.existsSync(input.env.HOME), false);
    assert.ok(fs.existsSync(path.join(input.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json')));
  } finally {
    cleanup(input);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails missing explicit prerequisites before launching or reading source credentials', async () => {
  const { root, env } = fixture();
  try {
    for (const key of [
      'OPENCODE_E2E_ZAI_MODEL',
      'OPENCODE_E2E_SUPERGROK_MODEL',
      'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
      'CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
      'OPENCODE_E2E_TEST_AUTH_PATH',
    ]) {
      await assert.rejects(
        runMixedTeamSmoke({
          sourceEnv: { ...env, [key]: '' },
          preflight: () => assert.fail('must not launch'),
          spawn: () => assert.fail('must not launch'),
        })
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not count missing model or zero exit without proof as successful cleanup', async () => {
  const { root, env } = fixture();
  let input;
  try {
    const status = await runMixedTeamSmoke({
      sourceEnv: env,
      log() {},
      preflight: async (value) => {
        input = value;
        return { ok: false, reason: 'synthetic-secret' };
      },
      spawn: () => assert.fail('missing model must not fall back'),
    });
    assert.equal(status, 1);
    assert.ok(fs.existsSync(input.projectPath));
    cleanup(input);
    await assert.rejects(
      runMixedTeamSmoke({
        sourceEnv: env,
        log() {},
        preflight: async (value) => {
          input = value;
          return { ok: true };
        },
        spawn: () => ({ status: 0 }),
      })
    );
    assert.ok(fs.existsSync(input.projectPath));
  } finally {
    cleanup(input);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects external project and absent/non-OAuth SuperGrok before preflight', async () => {
  const { root, env } = fixture();
  try {
    const mustReject = (sourceEnv) =>
      assert.rejects(
        runMixedTeamSmoke({
          sourceEnv,
          log() {},
          preflight: () => assert.fail('must not launch'),
          spawn: () => assert.fail('must not launch'),
        })
      );
    await mustReject({ ...env, OPENCODE_E2E_PROJECT_PATH: root });
    for (const xai of [undefined, { type: 'api', key: 'synthetic-api-secret' }]) {
      fs.writeFileSync(
        env.OPENCODE_E2E_TEST_AUTH_PATH,
        JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'synthetic-secret' }, xai })
      );
      await mustReject(env);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains rotated OAuth only in a private selected-auth handoff', () => {
  const { root, env } = fixture();
  let handoff;
  try {
    const initial = fs.readFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, 'utf8');
    assert.equal(preserveRotatedSelectedOAuth(initial, env.OPENCODE_E2E_TEST_AUTH_PATH), null);
    const current = JSON.parse(initial);
    delete current.unrelated;
    current.xai.refresh = 'synthetic-rotated-refresh';
    current.unexpected = { type: 'api', key: 'must-not-copy' };
    fs.writeFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, JSON.stringify(current));
    // The runner supplies only selected providers as initialJson.
    const selected = JSON.stringify({
      'zai-coding-plan': JSON.parse(initial)['zai-coding-plan'],
      xai: JSON.parse(initial).xai,
    });
    handoff = preserveRotatedSelectedOAuth(selected, env.OPENCODE_E2E_TEST_AUTH_PATH);
    assert.equal(fs.statSync(handoff).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(handoff)).mode & 0o777, 0o700);
    const saved = JSON.parse(fs.readFileSync(handoff, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['xai', 'zai-coding-plan']);
    assert.equal(saved.xai.refresh, 'synthetic-rotated-refresh');
  } finally {
    if (handoff) fs.rmSync(path.dirname(handoff), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails successful inference cleanup if selected OAuth cannot be recovered', async () => {
  const { root, env } = fixture();
  let input;
  try {
    const status = await runMixedTeamSmoke({
      sourceEnv: env,
      log() {},
      preflight: async (value) => {
        input = value;
        return { ok: true };
      },
      spawn: (_command, _args, { env: runEnv }) => {
        fs.writeFileSync(
          path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'),
          JSON.stringify({
            status: 'passed',
            cleanupConfirmed: true,
            finalStopConfirmed: true,
            independentAssertionsPassed: true,
            models: ['zai-coding-plan/model', 'xai/grok-test'],
            evidence: [{}, {}, {}, {}],
            peerAcknowledgements: [{}, {}, {}, {}],
          })
        );
        fs.writeFileSync(path.join(runEnv.XDG_DATA_HOME, 'opencode/auth.json'), '{}');
        return { status: 0 };
      },
    });
    assert.equal(status, 1);
    assert.ok(fs.existsSync(input.env.HOME));
  } finally {
    cleanup(input);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
