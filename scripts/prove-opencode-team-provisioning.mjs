#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';
import { preflightOpenCodeLiveEnvironment } from './lib/opencode-live-preflight.mjs';

// An explicit project must contain this exact opt-in; a name containing "test" is insufficient.
export const TEST_PROJECT_MARKER = '.opencode-team-provisioning-test-only';
export const TEST_PROJECT_MARKER_CONTENT = 'opencode-team-provisioning-test-only-v1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runProvisioningSmoke({
  sourceEnv = process.env,
  preflight = preflightOpenCodeLiveEnvironment,
  spawn = spawnSync,
  vitestEntryPath = path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
  log = console.log,
} = {}) {
  if (
    !path.isAbsolute(vitestEntryPath) ||
    !fs.existsSync(vitestEntryPath) ||
    !fs.statSync(vitestEntryPath).isFile()
  ) {
    throw new Error(
      'Existing local Vitest entrypoint is required; smoke never installs dependencies'
    );
  }
  const explicitProject = sourceEnv.OPENCODE_E2E_PROJECT_PATH;
  let projectPath;
  if (explicitProject !== undefined) {
    if (!explicitProject.trim() || !path.isAbsolute(explicitProject.trim())) {
      throw new Error('OPENCODE_E2E_PROJECT_PATH must be an absolute test-only directory');
    }
    projectPath = fs.realpathSync(explicitProject.trim());
    if (projectPath === fs.realpathSync(repoRoot) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error('The repository root cannot be a smoke project');
    }
    const marker = path.join(projectPath, TEST_PROJECT_MARKER);
    if (
      !fs.lstatSync(marker).isFile() ||
      fs.readFileSync(marker, 'utf8').trim() !== TEST_PROJECT_MARKER_CONTENT
    ) {
      throw new Error(
        `Explicit smoke project requires ${TEST_PROJECT_MARKER} containing ${TEST_PROJECT_MARKER_CONTENT}`
      );
    }
  }
  const model = sourceEnv.OPENCODE_E2E_MODEL?.trim();
  if (!model || !/^[^\s/]+\/[^\s]+$/.test(model)) {
    throw new Error('Set OPENCODE_E2E_MODEL explicitly to the authorized test provider/model');
  }
  const binaryPath =
    sourceEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim() ||
    sourceEnv.OPENCODE_BIN_PATH?.trim() ||
    sourceEnv.OPENCODE_BIN?.trim();
  if (!binaryPath || !path.isAbsolute(binaryPath) || binaryPath.includes('\0')) {
    throw new Error(
      'Set an explicit absolute OpenCode binary path via CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, OPENCODE_BIN_PATH, or OPENCODE_BIN'
    );
  }
  let credentials = {};
  if (sourceEnv.OPENCODE_E2E_TEST_CREDENTIALS_JSON !== undefined) {
    try {
      credentials = JSON.parse(sourceEnv.OPENCODE_E2E_TEST_CREDENTIALS_JSON);
      if (
        !credentials ||
        Array.isArray(credentials) ||
        typeof credentials !== 'object' ||
        Object.entries(credentials).some(
          ([key, value]) =>
            !/^[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) ||
            typeof value !== 'string' ||
            !value.trim() ||
            value.includes('\0')
        )
      )
        throw new Error();
    } catch {
      throw new Error(
        'OPENCODE_E2E_TEST_CREDENTIALS_JSON must be an object of test API_KEY/AUTH_TOKEN/ACCESS_TOKEN strings'
      );
    }
  }
  let selectedAuth;
  if (sourceEnv.OPENCODE_E2E_TEST_AUTH_PATH !== undefined) {
    try {
      const sourcePath = sourceEnv.OPENCODE_E2E_TEST_AUTH_PATH.trim();
      if (!path.isAbsolute(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error();
      const store = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      const provider = model.slice(0, model.indexOf('/'));
      if (
        !store ||
        typeof store !== 'object' ||
        Array.isArray(store) ||
        !Object.hasOwn(store, provider)
      )
        throw new Error();
      const entry = store[provider];
      const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        !(
          (entry.type === 'api' && nonempty(entry.key)) ||
          (entry.type === 'oauth' && (nonempty(entry.access) || nonempty(entry.refresh)))
        )
      )
        throw new Error();
      selectedAuth = JSON.stringify({ [provider]: entry });
    } catch {
      // Never attach filesystem/JSON errors: they can contain the source path or token text.
      throw new Error(
        'OPENCODE_E2E_TEST_AUTH_PATH must select an absolute auth file with a valid selected-provider api/oauth record'
      );
    }
  }
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-team-smoke-'));
  let ownedProject;
  let completedSuccessfully = false;
  try {
    // An explicit marked target is a test-only parent, never the mutable run project itself.
    ownedProject = projectPath
      ? fs.mkdtempSync(path.join(projectPath, 'opencode-team-smoke-'))
      : path.join(ownedRoot, 'project');
    projectPath = ownedProject;
    fs.mkdirSync(projectPath, { recursive: true });
    const env = {
      ...Object.fromEntries(
        Object.entries(sourceEnv).filter(([key]) =>
          [
            'PATH',
            'Path',
            'SystemRoot',
            'WINDIR',
            'COMSPEC',
            'PATHEXT',
            'LANG',
            'LC_ALL',
            'CLAUDE_DEV_RUNTIME_ROOT',
            'CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
          ].includes(key)
        )
      ),
      ...credentials,
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binaryPath,
      OPENCODE_E2E_DEFAULT_MODEL_LAUNCH:
        sourceEnv.OPENCODE_E2E_DEFAULT_MODEL_LAUNCH === '1' ? '1' : '0',
      OPENCODE_E2E: '1',
      OPENCODE_E2E_TEAM_PROVISIONING: '1',
      OPENCODE_E2E_PROJECT_PATH: projectPath,
      OPENCODE_E2E_OWNED_PROJECT_PATH: projectPath,
      OPENCODE_E2E_MODEL: model,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    // Credentials enter only via the explicit test input above; never inherit auth profiles.
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'TMP',
      'TEMP',
      'TMPDIR',
    ]) {
      env[key] = path.join(ownedRoot, key.toLowerCase());
      fs.mkdirSync(env[key], { recursive: true });
    }
    if (selectedAuth !== undefined) {
      const authDirectory = path.join(env.XDG_DATA_HOME, 'opencode');
      fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(authDirectory, 'auth.json'), selectedAuth, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
      env,
      repoRoot,
    });
    log(
      `OpenCode provisioning smoke: ${model}, project ${projectPath}, CLI ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`
    );
    const projects = [projectPath];
    if (env.OPENCODE_E2E_DEFAULT_MODEL_LAUNCH === '1') {
      const defaultProject = path.join(ownedRoot, 'default-model-project');
      fs.mkdirSync(defaultProject);
      fs.writeFileSync(
        path.join(defaultProject, 'opencode.json'),
        JSON.stringify({ model, small_model: model })
      );
      env.OPENCODE_E2E_DEFAULT_MODEL_PROJECT_PATH = defaultProject;
      projects.push(defaultProject);
    }
    for (const target of projects) {
      const readiness = await preflight({
        repoRoot,
        projectPath: target,
        env,
        requiredModels: [model],
        preserveSandboxDataHome: true,
        useManagedRuntimeModels: true,
      });
      if (!readiness.ok) {
        log(`SKIPPED: ${readiness.reason}`);
        return 1; // Missing prerequisites are never successful proof.
      }
    }
    const result = spawn(
      process.execPath,
      [
        vitestEntryPath,
        'run',
        '--maxWorkers=1',
        'test/main/services/team/OpenCodeTeamProvisioning.live.test.ts',
      ],
      { cwd: repoRoot, env, stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    completedSuccessfully = result.status === 0;
    return result.status ?? 1;
  } finally {
    // The caller's marked project is never owned by this wrapper.
    // Preflight can already start managed hosts; retain their state until success is proven.
    if (!completedSuccessfully) {
      log(
        `Smoke failed; preserving owned state for targeted cleanup: ${ownedRoot}, project ${ownedProject}`
      );
    } else {
      if (ownedProject) fs.rmSync(ownedProject, { recursive: true, force: true });
      fs.rmSync(ownedRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProvisioningSmoke()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`OpenCode provisioning smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
