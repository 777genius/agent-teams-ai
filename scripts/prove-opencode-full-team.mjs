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
export const TEST_PROJECT_MARKER = '.opencode-full-team-test-only';
export const TEST_PROJECT_MARKER_CONTENT = 'opencode-full-team-test-only-v1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runFullTeamSmoke({
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
  const runtimeCli = sourceEnv.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
  if (!runtimeCli || !path.isAbsolute(runtimeCli)) {
    throw new Error('Set an explicit absolute CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH');
  }
  if (!sourceEnv.OPENCODE_E2E_TEST_AUTH_PATH?.trim()) {
    throw new Error(
      'Set OPENCODE_E2E_TEST_AUTH_PATH explicitly to the selected provider auth store'
    );
  }
  fs.accessSync(runtimeCli, fs.constants.X_OK);
  fs.accessSync(binaryPath, fs.constants.X_OK);
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
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-full-team-'));
  let ownedProject;
  const proofDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-full-team-proof-'));
  let completedSuccessfully = false;
  try {
    // An explicit marked target is a test-only parent, never the mutable run project itself.
    ownedProject = projectPath
      ? fs.mkdtempSync(path.join(projectPath, 'opencode-full-team-'))
      : path.join(ownedRoot, 'project');
    projectPath = ownedProject;
    fs.mkdirSync(projectPath, { recursive: true });
    projectPath = fs.realpathSync(projectPath);
    ownedProject = projectPath;
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
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binaryPath,
      OPENCODE_E2E: '1',
      OPENCODE_E2E_FULL_TEAM: '1',
      OPENCODE_E2E_PROJECT_PATH: projectPath,
      OPENCODE_E2E_OWNED_PROJECT_PATH: projectPath,
      OPENCODE_E2E_MODEL: model,
      OPENCODE_E2E_PROOF_DIRECTORY: proofDirectory,
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
      'CLAUDE_MULTIMODEL_DATA_HOME',
      'CLAUDE_MULTIMODEL_CACHE_HOME',
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
      `OpenCode full team proof: ${model}, project ${projectPath}, CLI ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`
    );
    log(`Sanitized progress/proof: ${proofDirectory}`);
    const readiness = await preflight({
      repoRoot,
      projectPath,
      env,
      requiredModels: [model],
      preserveSandboxDataHome: true,
      useManagedRuntimeModels: true,
    });
    if (!readiness.ok) {
      // Provider/CLI failures may include secret material; keep raw state, never print it.
      log('Prerequisite check failed; no inference submitted. Inspect owned state locally.');
      return 1;
    }
    const result = spawn(
      process.execPath,
      [
        vitestEntryPath,
        'run',
        '--maxWorkers=1',
        'test/main/services/team/OpenCodeFullTeamCollaboration.live.test.ts',
      ],
      {
        cwd: repoRoot,
        env,
        stdio: 'pipe',
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30 * 60_000,
        killSignal: 'SIGTERM',
      }
    );
    // Do not echo provider/CLI output: runtime errors can contain credential text.
    if (result.error) throw new Error('Live test process failed; inspect owned state');
    if (result.status === 0) {
      const proof = JSON.parse(fs.readFileSync(path.join(proofDirectory, 'proof.json'), 'utf8'));
      if (proof.status !== 'passed' || proof.cleanupConfirmed !== true || proof.model !== model) {
        throw new Error('Live test did not produce complete cleanup-confirmed proof');
      }
      completedSuccessfully = true;
      log(`Sanitized proof preserved: ${proofDirectory}`);
    }
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
  runFullTeamSmoke()
    .then((status) => {
      process.exitCode = status;
    })
    .catch(() => {
      console.error('OpenCode full team proof failed; inspect the preserved owned state.');
      process.exitCode = 1;
    });
}
