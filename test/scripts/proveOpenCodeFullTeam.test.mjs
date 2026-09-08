import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { assertOwnedSmokeEnvironment, runFullTeamSmoke } from '../../scripts/prove-opencode-full-team.mjs';

function passingProof() {
  return {
    status: 'passed', cleanupConfirmed: true, model: 'selected/model',
    finalStopConfirmed: true, initialStopConfirmed: true, independentAssertionsPassed: true,
    runId: 'initial-run', initialSessions: { alice: 'session-a', bob: 'session-b' },
    tasks: ['alice', 'bob'].map((owner) => ({ owner, id: `initial-${owner}`, status: 'completed' })),
    toolProofs: ['alice', 'bob'].map((member) => ({ member, executionConfirmed: true,
      taskCompletionConfirmed: true, peerResponseConfirmed: true })),
    relaunch: { runId: 'relaunch-run', tasks: ['alice', 'bob'].map((owner) => ({ owner,
      taskId: `relaunch-${owner}`, status: 'completed' })) },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-team-wrapper-TEST-'));
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(
    auth,
    JSON.stringify({
      selected: { type: 'api', key: 'synthetic-secret' },
      unrelated: { type: 'api', key: 'unrelated-synthetic-secret' },
    })
  );
  fs.writeFileSync(path.join(root, 'vitest.mjs'), '// synthetic entry; never executed');
  return {
    root,
    env: {
      OPENCODE_E2E: '1',
      OPENCODE_E2E_FULL_TEAM: '1',
      OPENCODE_E2E_MODEL: 'selected/model',
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
    const status = await runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
      sourceEnv: {
        ...env,
        HOME: '/real-home',
        OPENCODE_CONFIG: '/real-config',
        ZAI_API_KEY: 'must-not-inherit',
      },
      log() {},
      preflight: async (value) => {
        input = value;
        assert.deepEqual(value.requiredModels, ['selected/model']);
        assert.equal(value.projectPath, fs.realpathSync(value.projectPath));
        assert.equal(value.env.OPENCODE_E2E_OWNED_PROJECT_PATH, value.projectPath);
        assert.ok(value.env.CLAUDE_MULTIMODEL_DATA_HOME.startsWith(path.dirname(value.env.HOME)));
        assert.notEqual(value.env.CLAUDE_MULTIMODEL_DATA_HOME, value.env.HOME);
        assert.equal(value.env.OPENCODE_CONFIG, undefined);
        assert.equal(value.env.ZAI_API_KEY, undefined);
        assert.notEqual(value.env.HOME, '/real-home');
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(value.env.XDG_DATA_HOME, 'opencode/auth.json'))),
          { selected: { type: 'api', key: 'synthetic-secret' } }
        );
        return { ok: true };
      },
      spawn: (_command, args, options) => {
        assert.equal(
          args.at(-1),
          'test/main/services/team/OpenCodeFullTeamCollaboration.live.test.ts'
        );
        assert.equal(options.env.OPENCODE_E2E_FULL_TEAM, '1');
        assert.equal(options.stdio, 'pipe');
        assert.equal(options.timeout, 30 * 60_000);
        fs.writeFileSync(
          path.join(options.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'),
          JSON.stringify(passingProof())
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
      'OPENCODE_E2E_MODEL',
      'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
      'CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
      'OPENCODE_E2E_TEST_AUTH_PATH',
    ]) {
      await assert.rejects(
        runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
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
    const status = await runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
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
      runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
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

test('requires both explicit opt-ins before any credential access or preflight', async () => {
  const { root, env } = fixture();
  try {
    for (const key of ['OPENCODE_E2E', 'OPENCODE_E2E_FULL_TEAM']) {
      for (const value of [undefined, '0', 'true']) {
        await assert.rejects(runFullTeamSmoke({
          vitestEntryPath: path.join(root, 'vitest.mjs'),
          sourceEnv: { ...env, [key]: value, OPENCODE_E2E_TEST_AUTH_PATH: '/must-not-read' },
          preflight: () => assert.fail('must not launch'),
          spawn: () => assert.fail('must not launch'),
        }), /opt-in required/);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('direct live entry rejects unowned state, ambient credentials, changed roots and symlinks', async () => {
  const { root, env } = fixture();
  let input;
  try {
    assert.throws(() => assertOwnedSmokeEnvironment({ ...env,
      OPENCODE_E2E_PROJECT_PATH: root, OPENCODE_E2E_OWNED_PROJECT_PATH: root,
    }, 'FULL'), /wrapper-owned/);
    await runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env, log() {},
      preflight: async (value) => {
        input = value;
        assert.doesNotThrow(() => assertOwnedSmokeEnvironment(value.env, 'FULL'));
        assert.throws(() => assertOwnedSmokeEnvironment(value.env, 'MIXED'));
        for (const change of [
          { HOME: root }, { XDG_CONFIG_HOME: root }, { CLAUDE_MULTIMODEL_DATA_HOME: root },
          { OPENCODE_CONFIG: 'synthetic-config' }, { ZAI_API_KEY: 'synthetic-secret' },
          { NODE_OPTIONS: '--require=/must-not-load' }, { CLAUDE_CONFIG_DIR: root },
          { OPENCODE_E2E_PROJECT_PATH: root, OPENCODE_E2E_OWNED_PROJECT_PATH: root },
        ]) assert.throws(() => assertOwnedSmokeEnvironment({ ...value.env, ...change }, 'FULL'));
        fs.rmdirSync(value.env.HOME);
        fs.symlinkSync(root, value.env.HOME, 'junction');
        assert.throws(() => assertOwnedSmokeEnvironment(value.env, 'FULL'));
        fs.unlinkSync(value.env.HOME);
        fs.mkdirSync(value.env.HOME);
        return { ok: false };
      }, spawn: () => assert.fail('no live process'),
    });
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});

test('incomplete full proof cannot authorize state deletion', async () => {
  const { root, env } = fixture();
  let input;
  try {
    for (const mutate of [
      (proof) => { delete proof.finalStopConfirmed; },
      (proof) => { delete proof.independentAssertionsPassed; },
      (proof) => { proof.tasks[1] = proof.tasks[0]; },
      (proof) => { proof.initialSessions.bob = proof.initialSessions.alice; },
      (proof) => { proof.relaunch.runId = proof.runId; },
      (proof) => { proof.toolProofs = [{}, {}]; },
    ]) {
      await assert.rejects(runFullTeamSmoke({
        vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env, log() {},
        preflight: async (value) => { input = value; return { ok: true }; },
        spawn: (_command, _args, { env: runEnv }) => {
          const proof = passingProof(); mutate(proof);
          fs.writeFileSync(path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(proof));
          return { status: 0 };
        },
      }), /complete cleanup-confirmed proof/);
      assert.ok(fs.existsSync(input.env.HOME));
      cleanup(input);
    }
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});

test('full runner preserves rotated selected OAuth before deleting successful state', async () => {
  const { root, env } = fixture();
  let input, handoff;
  const selected = { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' };
  fs.writeFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, JSON.stringify({ selected }));
  try {
    const status = await runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env,
      log(message) { if (message.startsWith('Rotated selected auth retained privately: ')) handoff = message.slice(message.indexOf(': ') + 2); },
      preflight: async (value) => { input = value; return { ok: true }; },
      spawn: (_command, _args, { env: runEnv }) => {
        fs.writeFileSync(path.join(runEnv.XDG_DATA_HOME, 'opencode/auth.json'),
          JSON.stringify({ selected: { ...selected, refresh: 'synthetic-rotated' } }));
        fs.writeFileSync(path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(passingProof()));
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(fs.existsSync(input.env.HOME), false);
    assert.equal(JSON.parse(fs.readFileSync(handoff, 'utf8')).selected.refresh, 'synthetic-rotated');
    assert.equal(fs.statSync(handoff).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, 'utf8'), JSON.stringify({ selected }));
  } finally {
    if (handoff) fs.rmSync(path.dirname(handoff), { recursive: true, force: true });
    cleanup(input); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full runner retains state and fails if OAuth recovery is incomplete', async () => {
  const { root, env } = fixture();
  let input;
  fs.writeFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, JSON.stringify({ selected:
    { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' } }));
  try {
    const status = await runFullTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env, log() {},
      preflight: async (value) => { input = value; return { ok: true }; },
      spawn: (_command, _args, { env: runEnv }) => {
        fs.writeFileSync(path.join(runEnv.XDG_DATA_HOME, 'opencode/auth.json'), JSON.stringify({ selected: { type: 'oauth' } }));
        fs.writeFileSync(path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(passingProof()));
        return { status: 0 };
      },
    });
    assert.equal(status, 1);
    assert.ok(fs.existsSync(input.env.HOME));
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});

test('uncertain child effects are submitted once, redacted and retained for targeted cleanup', async () => {
  const { root, env } = fixture();
  let input;
  try {
    for (const result of [
      { status: null, signal: 'SIGTERM', stderr: 'synthetic-provider-secret' },
      { status: null, error: new Error('synthetic-provider-secret') },
    ]) {
      let spawns = 0, preflights = 0;
      const logs = [];
      const run = runFullTeamSmoke({
        vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env,
        log(message) { logs.push(message); },
        preflight: async (value) => { input = value; preflights++; return { ok: true }; },
        spawn: () => { spawns++; return result; },
      });
      if (result.error) await assert.rejects(run, /Live test process failed; inspect owned state/);
      else assert.equal(await run, 1);
      assert.equal(spawns, 1); assert.equal(preflights, 1);
      assert.equal(logs.join('\n').includes('synthetic-provider-secret'), false);
      assert.ok(fs.existsSync(input.env.HOME)); cleanup(input);
    }
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});
