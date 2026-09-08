#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';
import { preflightOpenCodeLiveEnvironment } from './lib/opencode-live-preflight.mjs';

import {
  allocateSmokeOwnedRoot,
  assertOwnedSmokeEnvironment,
  isCompleteSmokeProof,
  ISOLATED_PATH_KEYS,
  preserveSelectedOAuth,
  writeSmokeOwnership,
} from './prove-opencode-full-team.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runMixedTeamSmoke({
  sourceEnv = process.env,
  preflight = preflightOpenCodeLiveEnvironment,
  spawn = spawnSync,
  vitestEntryPath = path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
  log = console.log,
} = {}) {
  if (sourceEnv.OPENCODE_E2E !== '1' || sourceEnv.OPENCODE_E2E_MIXED_TEAM !== '1') {
    throw new Error('Explicit OPENCODE_E2E=1 and OPENCODE_E2E_MIXED_TEAM=1 opt-in required');
  }
  if (
    !path.isAbsolute(vitestEntryPath) ||
    !fs.existsSync(vitestEntryPath) ||
    !fs.statSync(vitestEntryPath).isFile()
  ) {
    throw new Error(
      'Existing local Vitest entrypoint is required; smoke never installs dependencies'
    );
  }
  if (sourceEnv.OPENCODE_E2E_PROJECT_PATH !== undefined) {
    throw new Error(
      'Mixed proof always creates a new disposable project; omit OPENCODE_E2E_PROJECT_PATH'
    );
  }
  let projectPath;
  const models = [
    sourceEnv.OPENCODE_E2E_ZAI_MODEL?.trim(),
    sourceEnv.OPENCODE_E2E_SUPERGROK_MODEL?.trim(),
  ];
  if (
    !models[0] ||
    !/^zai[^\s/]*\/[^\s]+$/.test(models[0]) ||
    !models[1] ||
    !/^xai\/[^\s]+$/.test(models[1])
  ) {
    throw new Error(
      'Set explicit OPENCODE_E2E_ZAI_MODEL=zai-provider/model and OPENCODE_E2E_SUPERGROK_MODEL=xai/model'
    );
  }
  const [model, supergrokModel] = models;
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
      const selected = {};
      for (const selectedModel of models) {
        const provider = selectedModel.slice(0, selectedModel.indexOf('/'));
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
        if (provider === 'xai' && entry.type !== 'oauth') throw new Error();
        selected[provider] = entry;
      }
      selectedAuth = JSON.stringify(selected);
    } catch {
      // Never attach filesystem/JSON errors: they can contain the source path or token text.
      throw new Error(
        'OPENCODE_E2E_TEST_AUTH_PATH must select an absolute auth file with a valid selected-provider api/oauth record'
      );
    }
  }
  const ownedRoot = allocateSmokeOwnedRoot('opencode-mixed-team-');
  let ownedProject;
  let isolatedAuthPath;
  const proofDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mixed-team-proof-'));
  let completedSuccessfully = false;
  let exitStatus = 1;
  try {
    ownedProject = path.join(ownedRoot, 'project');
    projectPath = ownedProject;
    fs.mkdirSync(projectPath, { recursive: true, mode: 0o700 });
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
      OPENCODE_E2E_OWNED_ROOT: ownedRoot,
      OPENCODE_E2E: '1',
      OPENCODE_E2E_MIXED_TEAM: '1',
      OPENCODE_E2E_PROJECT_PATH: projectPath,
      OPENCODE_E2E_OWNED_PROJECT_PATH: projectPath,
      OPENCODE_E2E_ZAI_MODEL: model,
      OPENCODE_E2E_SUPERGROK_MODEL: supergrokModel,
      OPENCODE_E2E_PROOF_DIRECTORY: proofDirectory,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    // Credentials enter only via the explicit test input above; never inherit auth profiles.
    for (const key of ISOLATED_PATH_KEYS) {
      env[key] = path.join(ownedRoot, key.toLowerCase());
      fs.mkdirSync(env[key], { recursive: true });
    }
    if (selectedAuth !== undefined) {
      const authDirectory = path.join(env.XDG_DATA_HOME, 'opencode');
      fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
      isolatedAuthPath = path.join(authDirectory, 'auth.json');
      fs.writeFileSync(isolatedAuthPath, selectedAuth, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
      env,
      repoRoot,
    });
    writeSmokeOwnership(env, 'MIXED');
    assertOwnedSmokeEnvironment(env, 'MIXED');
    log(
      `OpenCode mixed team proof: ${model}, project ${projectPath}, CLI ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`
    );
    log(`Sanitized progress/proof: ${proofDirectory}`);
    const readiness = await preflight({
      repoRoot,
      projectPath,
      env,
      requiredModels: models,
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
        '--config',
        path.join(repoRoot, 'vitest.opencode-proof.config.ts'),
        '--maxWorkers=1',
        'test/main/services/team/OpenCodeMixedTeamCollaboration.live.test.ts',
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
      if (!isCompleteSmokeProof(proof, 'MIXED', models)) {
        throw new Error('Live test did not produce complete cleanup-confirmed proof');
      }
      completedSuccessfully = true;
      log(`Sanitized proof preserved: ${proofDirectory}`);
    }
    exitStatus = result.status ?? 1;
  } finally {
    // A provider may rotate single-use OAuth refresh tokens during this one run.
    // Preserve only selected credentials privately before deleting the isolated home.
    if (isolatedAuthPath) {
      try {
        const handoff = preserveRotatedSelectedOAuth(selectedAuth, isolatedAuthPath);
        if (handoff) log(`Rotated selected auth retained privately: ${handoff}`);
      } catch {
        completedSuccessfully = false;
        log(`Auth handoff not confirmed; retaining owned state for recovery: ${ownedRoot}`);
      }
    }
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
  return completedSuccessfully ? 0 : exitStatus || 1;
}

export function preserveRotatedSelectedOAuth(initialJson, isolatedAuthPath) {
  return preserveSelectedOAuth(initialJson, isolatedAuthPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMixedTeamSmoke()
    .then((status) => {
      process.exitCode = status;
    })
    .catch(() => {
      console.error('OpenCode mixed team proof failed; inspect the preserved owned state.');
      process.exitCode = 1;
    });
}
