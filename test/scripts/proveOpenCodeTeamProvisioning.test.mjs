import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  runProvisioningSmoke,
  TEST_PROJECT_MARKER,
  TEST_PROJECT_MARKER_CONTENT,
} from '../../scripts/prove-opencode-team-provisioning.mjs';

const modelEnv = {
  OPENCODE_E2E_MODEL: 'test-provider/test-model',
  CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: process.execPath,
};

test('preflight and downstream receive identical selection and isolated environment', async () => {
  let input;
  const status = await runProvisioningSmoke({
    sourceEnv: {
      ...modelEnv,
      HOME: '/caller-home',
      OPENCODE_CONFIG: '/caller-config',
      CLAUDE_DEV_RUNTIME_ROOT: '/source-runtime',
    },
    log() {},
    preflight: async (value) => {
      input = value;
      assert.notEqual(value.projectPath, value.repoRoot);
      assert.equal(value.preserveSandboxDataHome, true);
      assert.equal(value.useManagedRuntimeModels, true);
      assert.equal(value.env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS, undefined);
      assert.ok(fs.statSync(value.projectPath).isDirectory());
      assert.deepEqual(value.requiredModels, [modelEnv.OPENCODE_E2E_MODEL]);
      assert.equal(value.env.OPENCODE_E2E_PROJECT_PATH, value.projectPath);
      assert.notEqual(value.env.HOME, '/caller-home');
      assert.equal(value.env.OPENCODE_CONFIG, undefined);
      assert.equal(
        value.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH,
        path.resolve('/source-runtime/cli-source')
      );
      return { ok: true };
    },
    spawn: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        path.join(input.repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--maxWorkers=1',
        'test/main/services/team/OpenCodeTeamProvisioning.live.test.ts',
      ]);
      assert.equal(options.cwd, input.repoRoot);
      assert.equal(options.env, input.env);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(input.projectPath), false);
  assert.equal(fs.existsSync(input.env.HOME), false);
});

test('invalid target or model fails before preflight or spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unmarked-test-project-'));
  let calls = 0;
  try {
    for (const sourceEnv of [
      {},
      { ...modelEnv, OPENCODE_E2E_PROJECT_PATH: '' },
      { ...modelEnv, OPENCODE_E2E_PROJECT_PATH: 'relative-test' },
      { ...modelEnv, OPENCODE_E2E_PROJECT_PATH: root },
    ]) {
      await assert.rejects(
        runProvisioningSmoke({
          sourceEnv,
          preflight: async () => {
            calls++;
          },
          spawn: () => {
            calls++;
          },
        })
      );
    }
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marked caller project survives spawn failure; explicit built launcher is preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-project-'));
  fs.writeFileSync(path.join(root, TEST_PROJECT_MARKER), TEST_PROJECT_MARKER_CONTENT);
  let home;
  try {
    await assert.rejects(
      runProvisioningSmoke({
        sourceEnv: {
          ...modelEnv,
          OPENCODE_E2E_PROJECT_PATH: root,
          CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: '/built/cli',
        },
        log() {},
        preflight: async ({ env }) => {
          home = env.HOME;
          assert.notEqual(env.OPENCODE_E2E_PROJECT_PATH, root);
          assert.equal(path.dirname(env.OPENCODE_E2E_PROJECT_PATH), fs.realpathSync(root));
          assert.equal(env.OPENCODE_E2E_OWNED_PROJECT_PATH, env.OPENCODE_E2E_PROJECT_PATH);
          assert.equal(env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH, '/built/cli');
          return { ok: true };
        },
        spawn: () => {
          throw new Error('mock spawn failure');
        },
      }),
      /mock spawn failure/
    );
    assert.equal(fs.existsSync(path.join(root, TEST_PROJECT_MARKER)), true);
    assert.equal(fs.existsSync(home), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable preflight fails proof and cleans its resources without launching test', async () => {
  let project;
  const status = await runProvisioningSmoke({
    sourceEnv: modelEnv,
    log() {},
    preflight: async ({ projectPath }) => {
      project = projectPath;
      return { ok: false, reason: 'test unavailable' };
    },
    spawn: () => {
      assert.fail('must not spawn');
    },
  });
  assert.equal(status, 1);
  assert.equal(fs.existsSync(project), false);
});

test('default lane preflights its own project with the selected model and same env', async () => {
  const inputs = [];
  await runProvisioningSmoke({
    sourceEnv: {
      ...modelEnv,
      OPENCODE_E2E_DEFAULT_MODEL_LAUNCH: '1',
      OPENAI_API_KEY: 'unapproved-inherited',
      OPENCODE_E2E_TEST_CREDENTIALS_JSON: '{"ZAI_API_KEY":"explicit-test-fixture"}',
    },
    log() {},
    preflight: async (input) => {
      inputs.push(input);
      return { ok: true };
    },
    spawn: (_command, _args, { env }) => {
      assert.equal(inputs.length, 2);
      assert.equal(inputs[1].projectPath, env.OPENCODE_E2E_DEFAULT_MODEL_PROJECT_PATH);
      assert.notEqual(inputs[0].projectPath, inputs[1].projectPath);
      for (const input of inputs) {
        assert.equal(input.env, env);
        assert.deepEqual(input.requiredModels, [modelEnv.OPENCODE_E2E_MODEL]);
      }
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(inputs[1].projectPath, 'opencode.json'), 'utf8')),
        { model: modelEnv.OPENCODE_E2E_MODEL, small_model: modelEnv.OPENCODE_E2E_MODEL }
      );
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.ZAI_API_KEY, 'explicit-test-fixture');
      assert.equal(env.OPENCODE_E2E_TEST_CREDENTIALS_JSON, undefined);
      return { status: 0 };
    },
  });
  for (const input of inputs) assert.equal(fs.existsSync(input.projectPath), false);
});

test('invalid credential input fails before any preflight or spawn without revealing secrets', async () => {
  for (const value of ['{"HOME":"secret"}', '{"ZAI_API_KEY":42}', 'secret', 'null', '[]']) {
    await assert.rejects(
      runProvisioningSmoke({
        sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_CREDENTIALS_JSON: value },
        preflight: async () => assert.fail('preflight must not run'),
        spawn: () => assert.fail('spawn must not run'),
      }),
      (error) =>
        !error.message.includes('secret') && error.message.includes('TEST_CREDENTIALS_JSON')
    );
  }
});

test('all binary aliases normalize to the identical canonical binary for preflight and launcher', async () => {
  for (const binaryEnv of [
    { OPENCODE_BIN: process.execPath },
    { OPENCODE_BIN_PATH: process.execPath },
    {
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: ` ${process.execPath} `,
      OPENCODE_BIN_PATH: '/ignored/opencode',
      OPENCODE_BIN: '/also-ignored/opencode',
    },
  ]) {
    const expected =
      binaryEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim() ||
      binaryEnv.OPENCODE_BIN_PATH ||
      binaryEnv.OPENCODE_BIN;
    let preflightEnv;
    await runProvisioningSmoke({
      sourceEnv: { OPENCODE_E2E_MODEL: modelEnv.OPENCODE_E2E_MODEL, ...binaryEnv },
      log() {},
      preflight: async ({ env }) => {
        preflightEnv = env;
        assert.equal(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, expected);
        return { ok: true };
      },
      spawn: (_command, _args, { env }) => {
        assert.equal(env, preflightEnv);
        assert.equal(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, expected);
        assert.equal(env.OPENCODE_BIN_PATH, undefined);
        assert.equal(env.OPENCODE_BIN, undefined);
        return { status: 0 };
      },
    });
  }
});

test('shared preflight ignores ambient data home unless sandbox preservation is explicit', async () => {
  const { __opencodeLivePreflightTestHooks: hooks } =
    await import('../../scripts/lib/opencode-live-preflight.mjs');
  const env = { XDG_DATA_HOME: '/caller-data' };
  assert.equal(hooks.shouldPreserveSandboxDataHome({}, env), false);
  assert.equal(hooks.shouldPreserveSandboxDataHome({ preserveSandboxDataHome: true }, env), true);
  assert.equal(hooks.shouldPreserveSandboxDataHome({ preserveSandboxDataHome: true }, {}), false);
});

test('failed downstream preserves only owned state for targeted host cleanup', async () => {
  let ownedRoot;
  let project;
  try {
    const status = await runProvisioningSmoke({
      sourceEnv: modelEnv,
      log() {},
      preflight: async ({ env, projectPath }) => {
        ownedRoot = path.dirname(env.HOME);
        project = projectPath;
        return { ok: true };
      },
      spawn: () => ({ status: 1 }),
    });
    assert.equal(status, 1);
    assert.ok(fs.existsSync(ownedRoot));
    assert.ok(fs.existsSync(project));
  } finally {
    if (ownedRoot) fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('absent or relative binary fails before preflight and spawn', async () => {
  for (const binaryEnv of [
    {},
    { OPENCODE_BIN: 'opencode' },
    { OPENCODE_BIN_PATH: './opencode' },
    { CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: 'relative/opencode' },
  ]) {
    await assert.rejects(
      runProvisioningSmoke({
        sourceEnv: { OPENCODE_E2E_MODEL: modelEnv.OPENCODE_E2E_MODEL, ...binaryEnv },
        preflight: async () => assert.fail('preflight must not run'),
        spawn: () => assert.fail('spawn must not run'),
      }),
      /explicit absolute OpenCode binary/
    );
  }
});

test('auth fixture seeds only selected provider and never forwards source path/blob', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-fixture-'));
  const sourcePath = path.join(fixtureRoot, 'source.json');
  const selected = { type: 'oauth', refresh: 'selected-refresh-fixture', expires: 0 };
  const source = JSON.stringify({
    'test-provider': selected,
    unrelated: { type: 'api', key: 'unrelated-secret-fixture' },
  });
  fs.writeFileSync(sourcePath, source);
  let target;
  const logs = [];
  try {
    await runProvisioningSmoke({
      sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_AUTH_PATH: sourcePath },
      log: (line) => logs.push(line),
      preflight: async ({ env }) => {
        target = path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
          'test-provider': selected,
        });
        if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        assert.equal(env.OPENCODE_E2E_TEST_AUTH_PATH, undefined);
        for (const forbidden of [
          sourcePath,
          'selected-refresh-fixture',
          'unrelated-secret-fixture',
        ])
          assert.equal(JSON.stringify(env).includes(forbidden), false);
        return { ok: true };
      },
      spawn: () => {
        fs.writeFileSync(target, '{"test-provider":{"type":"oauth","access":"rotated-fixture"}}');
        return { status: 0 };
      },
    });
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
    assert.equal(fs.existsSync(target), false);
    for (const forbidden of [sourcePath, 'selected-refresh-fixture', 'unrelated-secret-fixture'])
      assert.equal(logs.join('\n').includes(forbidden), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('malformed or missing selected auth fails before preflight/spawn without source details', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-fixture-'));
  const sourcePath = path.join(fixtureRoot, 'private-source.json');
  try {
    for (const source of [
      'secret-malformed-json',
      '{}',
      '{"test-provider":null}',
      '{"test-provider":{"type":"oauth"}}',
      '{"test-provider":{"type":"api","key":""}}',
    ]) {
      fs.writeFileSync(sourcePath, source);
      await assert.rejects(
        runProvisioningSmoke({
          sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_AUTH_PATH: sourcePath },
          preflight: async () => assert.fail('preflight must not run'),
          spawn: () => assert.fail('spawn must not run'),
        }),
        (error) =>
          error.message.includes('valid selected-provider') &&
          !error.message.includes(sourcePath) &&
          !error.message.includes('secret-malformed-json')
      );
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
    }
    await assert.rejects(
      runProvisioningSmoke({
        sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_AUTH_PATH: 'relative-auth.json' },
      }),
      /valid selected-provider/
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('auth import accepts api keys and access-only OAuth records', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-fixture-'));
  const sourcePath = path.join(fixtureRoot, 'source.json');
  try {
    for (const entry of [
      { type: 'api', key: 'fixture-api' },
      { type: 'oauth', access: 'fixture-access' },
    ]) {
      fs.writeFileSync(sourcePath, JSON.stringify({ 'test-provider': entry }));
      await runProvisioningSmoke({
        sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_AUTH_PATH: sourcePath },
        log() {},
        preflight: async ({ env }) => {
          assert.deepEqual(
            JSON.parse(
              fs.readFileSync(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8')
            ),
            { 'test-provider': entry }
          );
          return { ok: true };
        },
        spawn: () => ({ status: 0 }),
      });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('managed model catalog selection is independent of real app credential access', async () => {
  const { __opencodeLivePreflightTestHooks: hooks } =
    await import('../../scripts/lib/opencode-live-preflight.mjs');
  const sandboxEnv = {
    XDG_DATA_HOME: '/owned/data',
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
  };
  assert.equal(
    hooks.shouldUseManagedRuntimeModels({ useManagedRuntimeModels: true }, sandboxEnv),
    true
  );
  assert.equal(hooks.shouldUseManagedAppCredentials(sandboxEnv), false);
  assert.equal(hooks.shouldUseManagedRuntimeModels({}, sandboxEnv), false);
  assert.equal(
    hooks.shouldUseManagedRuntimeModels(
      {},
      { ...sandboxEnv, OPENCODE_E2E_USE_REAL_APP_CREDENTIALS: '1' }
    ),
    true
  );
  assert.equal(
    hooks.shouldPreserveSandboxDataHome({ useManagedRuntimeModels: true }, sandboxEnv),
    false
  );
  assert.equal(
    hooks.shouldPreserveSandboxDataHome(
      { useManagedRuntimeModels: true, preserveSandboxDataHome: true },
      sandboxEnv
    ),
    true
  );
});

test('missing local Vitest entrypoint fails before preflight or spawn without installing', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-vitest-fixture-'));
  try {
    await assert.rejects(
      runProvisioningSmoke({
        sourceEnv: modelEnv,
        vitestEntryPath: path.join(fixtureRoot, 'missing-vitest.mjs'),
        preflight: async () => assert.fail('preflight must not run'),
        spawn: () => assert.fail('spawn must not run'),
      }),
      /Existing local Vitest entrypoint is required/
    );
    assert.deepEqual(fs.readdirSync(fixtureRoot), []);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
