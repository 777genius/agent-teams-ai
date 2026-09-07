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

test('invalid target or model fails before allocation, preflight or spawn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unmarked-test-project-'));
  const allocation = t.mock.method(fs, 'mkdtempSync', () => {
    assert.fail('invalid inputs must not allocate owned state');
  });
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
    assert.equal(allocation.mock.callCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marked caller project survives spawn failure; explicit built launcher is preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-project-'));
  fs.writeFileSync(path.join(root, TEST_PROJECT_MARKER), TEST_PROJECT_MARKER_CONTENT);
  let home;
  let ownedProject;
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
          ownedProject = env.OPENCODE_E2E_OWNED_PROJECT_PATH;
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
    assert.equal(fs.existsSync(home), true);
    assert.equal(fs.existsSync(ownedProject), true);
  } finally {
    if (home) fs.rmSync(path.dirname(home), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed managed preflight preserves both lane projects and host diagnostics', async (t) => {
  for (const throws of [false, true]) {
    await t.test(throws ? 'thrown preflight' : 'unavailable preflight', async (t) => {
      let ownedRoot;
      const projects = [];
      const logs = [];
      t.after(() => {
        if (ownedRoot) fs.rmSync(ownedRoot, { recursive: true, force: true });
      });
      const run = runProvisioningSmoke({
        sourceEnv: { ...modelEnv, OPENCODE_E2E_DEFAULT_MODEL_LAUNCH: '1' },
        log: (line) => logs.push(line),
        preflight: async ({ projectPath, env, useManagedRuntimeModels }) => {
          ownedRoot = path.dirname(env.HOME);
          projects.push(projectPath);
          assert.equal(useManagedRuntimeModels, true);
          fs.writeFileSync(path.join(projectPath, 'host-diagnostics.json'), '{"testOnly":true}');
          if (projects.length === 1) return { ok: true };
          if (throws) throw new Error('mock preflight failure');
          return { ok: false, reason: 'test unavailable' };
        },
        spawn: () => assert.fail('must not spawn'),
      });
      if (throws) await assert.rejects(run, /mock preflight failure/);
      else assert.equal(await run, 1);
      assert.equal(projects.length, 2);
      assert.ok(fs.existsSync(ownedRoot));
      for (const project of projects) {
        assert.equal(
          fs.readFileSync(path.join(project, 'host-diagnostics.json'), 'utf8'),
          '{"testOnly":true}'
        );
      }
      assert.ok(
        logs.some((line) => line.includes('preserving owned state') && line.includes(ownedRoot))
      );
    });
  }
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

test('downstream cleanup requires proven success and never owns the marked caller parent', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cleanup-TEST-'));
  const sourcePath = path.join(fixtureRoot, 'auth.json');
  const source = '{"test-provider":{"type":"api","key":"cleanup-test-fixture"}}';
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(path.join(fixtureRoot, TEST_PROJECT_MARKER), TEST_PROJECT_MARKER_CONTENT);
  try {
    for (const [name, result, expectedStatus] of [
      ['failed exit', { status: 1 }, 1],
      ['spawn error', { status: null, error: new Error('mock spawn error') }],
      ['spawn error with zero status', { status: 0, error: new Error('mock spawn error') }],
      ['signaled child', { status: null, signal: 'SIGTERM' }, 1],
      ['null status', { status: null }, 1],
      ['absent status', {}, 1],
      ['successful exit', { status: 0 }, 0],
    ]) {
      await t.test(name, async (t) => {
        let ownedRoot;
        let project;
        let importedAuth;
        const logs = [];
        t.after(() => {
          if (ownedRoot) fs.rmSync(ownedRoot, { recursive: true, force: true });
          if (project) fs.rmSync(project, { recursive: true, force: true });
        });
        const run = runProvisioningSmoke({
          sourceEnv: {
            ...modelEnv,
            OPENCODE_E2E_PROJECT_PATH: fixtureRoot,
            OPENCODE_E2E_TEST_AUTH_PATH: sourcePath,
          },
          log: (line) => logs.push(line),
          preflight: async ({ env, projectPath }) => {
            ownedRoot = path.dirname(env.HOME);
            project = projectPath;
            importedAuth = path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json');
            assert.equal(fs.readFileSync(importedAuth, 'utf8'), source);
            fs.writeFileSync(path.join(project, 'host-state.json'), '{"testOnly":true}');
            return { ok: true };
          },
          spawn: () => result,
        });
        if (result.error) await assert.rejects(run, (error) => error === result.error);
        else assert.equal(await run, expectedStatus);
        const shouldPreserve = expectedStatus !== 0;
        assert.equal(fs.existsSync(ownedRoot), shouldPreserve);
        assert.equal(fs.existsSync(project), shouldPreserve);
        assert.equal(fs.existsSync(importedAuth), shouldPreserve);
        if (shouldPreserve) {
          assert.equal(
            fs.readFileSync(path.join(project, 'host-state.json'), 'utf8'),
            '{"testOnly":true}'
          );
          assert.ok(logs.some((line) => line.includes(ownedRoot) && line.includes(project)));
        }
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
        assert.equal(
          fs.readFileSync(path.join(fixtureRoot, TEST_PROJECT_MARKER), 'utf8'),
          TEST_PROJECT_MARKER_CONTENT
        );
        assert.equal(logs.join('\n').includes('cleanup-test-fixture'), false);
      });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
  let ownedRoot;
  const logs = [];
  try {
    await runProvisioningSmoke({
      sourceEnv: { ...modelEnv, OPENCODE_E2E_TEST_AUTH_PATH: sourcePath },
      log: (line) => logs.push(line),
      preflight: async ({ env }) => {
        ownedRoot = path.dirname(env.HOME);
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
    if (ownedRoot) fs.rmSync(ownedRoot, { recursive: true, force: true });
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
  const ownedRoots = [];
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
          ownedRoots.push(path.dirname(env.HOME));
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
    for (const root of ownedRoots) fs.rmSync(root, { recursive: true, force: true });
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

test('missing local Vitest entrypoint fails before allocation, preflight or spawn without installing', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-vitest-fixture-'));
  const allocation = t.mock.method(fs, 'mkdtempSync', () => {
    assert.fail('missing Vitest must not allocate owned state');
  });
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
    assert.equal(allocation.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(fixtureRoot), []);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
