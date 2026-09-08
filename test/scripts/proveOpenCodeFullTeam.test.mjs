import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { allocateSmokeOwnedRoot, assertOwnedSmokeEnvironment, runFullTeamSmoke, TEST_PROJECT_MARKER,
  TEST_PROJECT_MARKER_CONTENT, writeSmokeOwnership } from '../../scripts/prove-opencode-full-team.mjs';

import { runMixedTeamSmoke } from '../../scripts/prove-opencode-mixed-team.mjs';

for (const prefix of ['opencode-full-team-', 'opencode-mixed-team-']) {
  test(`${prefix} allocates private canonical Darwin roots with room for tsx sockets`, { skip: process.platform === 'win32' }, () => {
    const longTemp = '/private/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123456789/T';
    const socketSuffix = 'tmpdir/tsx-501/12345.pipe';
    assert.ok(Buffer.byteLength(path.join(longTemp, `${prefix}XXXXXX`, socketSuffix)) >= 104);
    const roots = [];
    try {
      roots.push(allocateSmokeOwnedRoot(prefix, 'darwin', longTemp));
      roots.push(allocateSmokeOwnedRoot(prefix, 'darwin', longTemp));
      assert.notEqual(roots[0], roots[1]);
      for (const root of roots) {
        assert.equal(path.dirname(root), fs.realpathSync('/tmp'));
        assert.equal(root, fs.realpathSync(root));
        assert.ok(path.basename(root).startsWith(prefix));
        assert.ok(Buffer.byteLength(path.join(root, socketSuffix)) < 104);
        if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o777, 0o700);
      }
    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${prefix} keeps the usual temporary parent on other platforms`, () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-root-TEST-'));
    try {
      for (const platform of ['linux', 'win32', 'freebsd']) {
        const root = allocateSmokeOwnedRoot(prefix, platform, parent);
        assert.equal(path.dirname(root), fs.realpathSync(parent));
        assert.equal(root, fs.realpathSync(root));
        assert.ok(path.basename(root).startsWith(prefix));
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
}

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
        assert.equal(path.basename(args[args.indexOf('--config') + 1]), 'vitest.opencode-proof.config.ts');
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
    if (process.platform !== 'win32') assert.equal(fs.statSync(handoff).mode & 0o777, 0o600);
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

for (const kind of ['FULL', 'MIXED']) {
  test(`${kind} rejects hostile and malformed matching manifests independently of saved.env`, async () => {
    const { root, env } = fixture();
    const run = kind === 'FULL' ? runFullTeamSmoke : runMixedTeamSmoke;
    const sourceEnv = kind === 'FULL' ? env : {
      ...env, OPENCODE_E2E_MIXED_TEAM: '1',
      OPENCODE_E2E_ZAI_MODEL: 'zai/model', OPENCODE_E2E_SUPERGROK_MODEL: 'xai/model',
    };
    if (kind === 'MIXED') fs.writeFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, JSON.stringify({
      zai: { type: 'api', key: 'synthetic' }, xai: { type: 'oauth', refresh: 'synthetic' },
    }));
    let input;
    try {
      await run({ sourceEnv, vitestEntryPath: path.join(root, 'vitest.mjs'), log() {},
        preflight: async (value) => {
          input = value;
          const runEnv = value.env;
          const manifest = path.join(runEnv.OPENCODE_E2E_OWNED_ROOT, '.opencode-proof-owned.json');
          const original = fs.readFileSync(manifest, 'utf8');
          const save = (data) => fs.writeFileSync(manifest, JSON.stringify(data));
          const assertRejected = (candidate = runEnv) => assert.throws(
            () => assertOwnedSmokeEnvironment(candidate, kind),
            { message: 'Live proof requires an intact wrapper-owned isolated environment' }
          );
          for (const [key, injected] of Object.entries({
            OPENCODE_CONFIG: '/TEST/ambient-config', OPENCODE_CONFIG_CONTENT: '{"provider":{}}',
            OPENCODE_CONFIG_DIR: root, OPENCODE_E2E_TEST_AUTH_PATH: env.OPENCODE_E2E_TEST_AUTH_PATH,
            CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, ZAI_API_KEY: 'synthetic-secret',
            OPENAI_API_KEY: 'synthetic-secret', AWS_PROFILE: 'synthetic',
            GOOGLE_APPLICATION_CREDENTIALS: root, NODE_OPTIONS: '--require=/TEST/no-load',
            NODE_PATH: root, LD_PRELOAD: '/TEST/no-load', HTTP_PROXY: 'http://TEST.invalid',
            AGENT_TEAMS_VITEST_TEMP_CLEANUP_DONE: '1',
          })) {
            const candidate = { ...runEnv, [key]: injected };
            save({ version: 1, kind, env: candidate });
            assertRejected(candidate);
          }
          for (const bad of [null, [], {}, { kind, env: runEnv },
            { version: 1, kind, env: null }, { version: 1, kind, env: [] },
            { version: 1, kind, env: {} }, { version: 1, kind, env: 'matching' },
            { version: 1, kind, env: { ...runEnv, HOME: 42 } },
          ]) { save(bad); assertRejected(); }
          for (const key of ['CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
            'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_E2E_PROOF_DIRECTORY',
            kind === 'FULL' ? 'OPENCODE_E2E_MODEL' : 'OPENCODE_E2E_SUPERGROK_MODEL']) {
            const candidate = { ...runEnv }; delete candidate[key];
            save({ version: 1, kind, env: candidate }); assertRejected(candidate);
          }
          fs.writeFileSync(manifest, '{malformed'); assertRejected();
          fs.writeFileSync(manifest, original);
          // Each shared-setup mutation fails on its own, including a matching changed manifest.
          assertRejected({ ...runEnv, HOME: root, USERPROFILE: root });
          save({ version: 1, kind, env: { ...runEnv, HOME: root, USERPROFILE: root } });
          assertRejected({ ...runEnv, HOME: root, USERPROFILE: root });
          fs.writeFileSync(manifest, original);
          assert.doesNotThrow(() => assertOwnedSmokeEnvironment({ ...runEnv,
            NODE_ENV: 'test', VITEST: 'true', TEST: 'true', VITEST_MODE: 'RUN',
            VITEST_WORKER_ID: '1', VITEST_POOL_ID: '1',
          }, kind));
          assertRejected({ ...runEnv, VITEST_MODE: 'WATCH' });

          // Even matching env AND self-authored project metadata cannot authorize arbitrary layout.
          const external = fs.mkdtempSync(path.join(root, 'external-TEST-'));
          const projectMarker = '.opencode-proof-project.json';
          const externalStat = fs.lstatSync(external);
          fs.writeFileSync(path.join(external, projectMarker), JSON.stringify({
            version: 1, kind, root: runEnv.OPENCODE_E2E_OWNED_ROOT, project: external,
            dev: externalStat.dev, ino: externalStat.ino,
          }), { mode: 0o600 });
          const candidate = { ...runEnv, OPENCODE_E2E_PROJECT_PATH: external,
            OPENCODE_E2E_OWNED_PROJECT_PATH: external };
          save({ version: 1, kind, env: candidate }); assertRejected(candidate);
          fs.writeFileSync(manifest, original);
          const ownershipPath = path.join(value.projectPath, projectMarker);
          const ownership = fs.readFileSync(ownershipPath, 'utf8');
          fs.unlinkSync(ownershipPath); assertRejected();
          fs.writeFileSync(ownershipPath, ownership, { mode: 0o600 });
          for (const change of [{ root }, { ino: -1 }, { kind: 'invalid' }, { project: external }]) {
            fs.writeFileSync(ownershipPath, JSON.stringify({ ...JSON.parse(ownership), ...change }));
            assertRejected();
          }
          fs.writeFileSync(ownershipPath, ownership);
          assert.throws(() => writeSmokeOwnership(runEnv, kind), /fresh and empty/);
          assert.doesNotThrow(() => assertOwnedSmokeEnvironment(runEnv, kind));
          return { ok: false };
        }, spawn: () => assert.fail('no live process'),
      });
    } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('explicit TEST parent permits only its fresh owned child and survives successful cleanup', async () => {
  const { root, env } = fixture();
  const parent = fs.mkdtempSync(path.join(root, 'parent-TEST-'));
  const marker = path.join(parent, TEST_PROJECT_MARKER);
  fs.writeFileSync(marker, TEST_PROJECT_MARKER_CONTENT);
  const sentinel = path.join(parent, 'keep.txt');
  fs.writeFileSync(sentinel, 'TEST parent content');
  let input;
  try {
    assert.equal(await runFullTeamSmoke({ sourceEnv: { ...env, OPENCODE_E2E_PROJECT_PATH: parent },
      vitestEntryPath: path.join(root, 'vitest.mjs'), log() {},
      preflight: async (value) => {
        input = value;
        assert.equal(path.dirname(value.projectPath), fs.realpathSync(parent));
        assert.notEqual(value.projectPath, parent);
        assert.deepEqual(fs.readdirSync(value.projectPath), ['.opencode-proof-project.json']);
        assert.doesNotThrow(() => assertOwnedSmokeEnvironment(value.env, 'FULL'));
        const manifest = path.join(value.env.OPENCODE_E2E_OWNED_ROOT, '.opencode-proof-owned.json');
        const original = fs.readFileSync(manifest, 'utf8');
        const candidate = { ...value.env, OPENCODE_E2E_PROJECT_PATH: parent,
          OPENCODE_E2E_OWNED_PROJECT_PATH: parent };
        fs.writeFileSync(manifest, JSON.stringify({ version: 1, kind: 'FULL', env: candidate }));
        assert.throws(() => assertOwnedSmokeEnvironment(candidate, 'FULL'), /wrapper-owned/);
        fs.writeFileSync(manifest, original);
        fs.unlinkSync(marker);
        assert.throws(() => assertOwnedSmokeEnvironment(value.env, 'FULL'), /wrapper-owned/);
        fs.writeFileSync(marker, 'incorrect TEST marker');
        assert.throws(() => assertOwnedSmokeEnvironment(value.env, 'FULL'), /wrapper-owned/);
        fs.writeFileSync(marker, TEST_PROJECT_MARKER_CONTENT);
        assert.doesNotThrow(() => assertOwnedSmokeEnvironment(value.env, 'FULL'));
        return { ok: true };
      },
      spawn: (_command, _args, { env: runEnv }) => {
        fs.writeFileSync(path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(passingProof()));
        return { status: 0 };
      },
    }), 0);
    assert.equal(fs.existsSync(input.projectPath), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'TEST parent content');
    assert.equal(fs.readFileSync(marker, 'utf8'), TEST_PROJECT_MARKER_CONTENT);
  } finally {
    if (input) fs.rmSync(input.projectPath, { recursive: true, force: true });
    cleanup(input); fs.rmSync(root, { recursive: true, force: true });
  }
});
