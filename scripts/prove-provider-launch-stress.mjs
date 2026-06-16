#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveLiveSmokeOrchestratorCliPath } from './lib/live-smoke-runtime.mjs';
import { preflightOpenCodeLiveEnvironment } from './lib/opencode-live-preflight.mjs';
import { spawnSyncWithWindowsShell } from './lib/windows-shell-spawn.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';
const requestedOrder =
  process.env.PROVIDER_LAUNCH_STRESS_ORDER?.trim() || 'anthropic,codex,opencode,mixed';

const env = {
  ...process.env,
  PROVIDER_LAUNCH_STRESS_LIVE: '1',
  PROVIDER_LAUNCH_STRESS_ORDER: requestedOrder,
  PROVIDER_LAUNCH_STRESS_MEMBER_COUNT:
    process.env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT?.trim() || '5',
  PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH:
    process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH?.trim() ||
    (process.env.ANTHROPIC_API_KEY?.trim() ? 'api-key' : 'subscription'),
  CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS:
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '90000',
  CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS:
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS?.trim() || '30000',
  PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL:
    process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_USE_REAL_APP_CREDENTIALS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};

if (!env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim()) {
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = resolveLiveSmokeOrchestratorCliPath({
    env,
    repoRoot,
  });
}

console.log('Running provider launch stress live smoke');
console.log(`Requested order: ${env.PROVIDER_LAUNCH_STRESS_ORDER}`);
console.log(`Members per scenario: ${env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT}`);
console.log(`Anthropic auth: ${env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH}`);
console.log(
  `Models: anthropic=${env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_MODEL || 'haiku'}, codex=${
    env.PROVIDER_LAUNCH_STRESS_CODEX_MODEL || 'gpt-5.4-mini'
  }, opencode=${env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL}`
);
console.log(`Orchestrator CLI: ${env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH}`);

const preflight = await preflightProviderLaunchStress({ repoRoot, requestedOrder });
for (const line of preflight.messages) {
  console.log(line);
}
if (preflight.order.length === 0) {
  console.warn('SKIPPED: no requested provider launch stress scenarios are available.');
  process.exit(process.env.PROVIDER_LAUNCH_STRESS_STRICT === '1' ? 1 : 0);
}
if (preflight.skipped.length > 0 && process.env.PROVIDER_LAUNCH_STRESS_STRICT === '1') {
  console.error('Provider launch stress preflight failed in strict mode.');
  process.exit(1);
}
env.PROVIDER_LAUNCH_STRESS_ORDER = preflight.order.join(',');
console.log(`Runnable order: ${env.PROVIDER_LAUNCH_STRESS_ORDER}`);

const result = spawnSyncWithWindowsShell(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--maxWorkers=1',
    'test/main/services/team/ProviderLaunchStress.live-e2e.test.ts',
  ],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(`Failed to run provider launch stress smoke: ${result.error.message}`);
  packageLatestLaunchFailureArtifacts();
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  packageLatestLaunchFailureArtifacts();
}

process.exit(result.status ?? 1);

async function preflightProviderLaunchStress(input) {
  const requested = parseScenarioOrder(input.requestedOrder);
  const needs = {
    anthropic: requested.includes('anthropic') || requested.includes('mixed'),
    codex: requested.includes('codex') || requested.includes('mixed'),
    opencode: requested.includes('opencode') || requested.includes('mixed'),
  };
  const checks = {
    anthropic: needs.anthropic ? await preflightAnthropic(input.repoRoot) : { ok: true },
    codex: needs.codex ? preflightCodex() : { ok: true },
    opencode: needs.opencode
      ? await preflightOpenCodeLiveEnvironment({
          repoRoot: input.repoRoot,
          requiredModels: [env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL],
        })
      : { ok: true },
  };
  const skipped = [];
  const order = [];
  for (const scenario of requested) {
    const unavailable = scenarioDependencies(scenario).filter((provider) => !checks[provider].ok);
    if (unavailable.length > 0) {
      skipped.push({
        scenario,
        reason: unavailable
          .map((provider) => `${provider}: ${checks[provider].reason}`)
          .join('; '),
      });
      continue;
    }
    order.push(scenario);
  }

  return {
    order,
    skipped,
    messages: [
      ...Object.entries(checks)
        .filter(([provider]) => needs[provider])
        .map(([provider, check]) =>
          check.ok
            ? `Preflight ${provider}: ok`
            : `Preflight ${provider}: unavailable - ${check.reason}`
        ),
      ...skipped.map((item) => `Skipping ${item.scenario}: ${item.reason}`),
    ],
  };
}

function parseScenarioOrder(value) {
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => ['anthropic', 'codex', 'opencode', 'mixed'].includes(item));
  return parsed.length > 0 ? parsed : ['anthropic', 'codex', 'opencode', 'mixed'];
}

function scenarioDependencies(scenario) {
  if (scenario === 'mixed') return ['anthropic', 'codex', 'opencode'];
  return [scenario];
}

async function preflightAnthropic(repoRoot) {
  const mode = env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH.toLowerCase();
  if (mode === 'api-key') {
    return env.ANTHROPIC_API_KEY?.trim()
      ? { ok: true }
      : { ok: false, reason: 'ANTHROPIC_API_KEY is not configured' };
  }

  const version = spawnSync('claude', ['--version'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 128_000,
  });
  if (version.status !== 0) {
    return {
      ok: false,
      reason: compactOutput(version.stderr || version.stdout || version.error?.message || 'claude --version failed'),
    };
  }
  return { ok: true };
}

function preflightCodex() {
  const codexHome = path.resolve(
    env.PROVIDER_LAUNCH_STRESS_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  );
  if (hasCodexSubscriptionAuth(codexHome)) {
    return { ok: true };
  }
  return { ok: false, reason: `Codex subscription auth not found in ${codexHome}` };
}

function hasCodexSubscriptionAuth(codexHome) {
  const legacyAuth = readJsonIfExists(path.join(codexHome, 'auth.json'));
  if (isCodexChatGptSubscriptionAuth(legacyAuth)) return true;

  const accountsDir = path.join(codexHome, 'accounts');
  const registry = readJsonIfExists(path.join(accountsDir, 'registry.json'));
  const activeAccountId =
    readStringProperty(registry, 'active_account_id') ??
    readStringProperty(registry, 'activeAccountId') ??
    readStringProperty(registry, 'current_account_id') ??
    readStringProperty(registry, 'currentAccountId');
  const candidates = new Set();
  if (activeAccountId) {
    candidates.add(path.join(accountsDir, `${activeAccountId}.auth.json`));
    candidates.add(path.join(accountsDir, activeAccountId));
  }
  for (const entry of safeReaddirFileNames(accountsDir)) {
    if (entry.endsWith('.auth.json')) candidates.add(path.join(accountsDir, entry));
  }
  for (const candidate of candidates) {
    if (isCodexChatGptSubscriptionAuth(readJsonIfExists(candidate))) return true;
  }
  return false;
}

function readJsonIfExists(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStringProperty(source, key) {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isCodexChatGptSubscriptionAuth(source) {
  if (!source) return false;
  const direct = readStringProperty(source, 'refresh_token');
  const tokens = source.tokens;
  const nested =
    tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? readStringProperty(tokens, 'refresh_token')
      : null;
  return Boolean(direct || nested);
}

function packageLatestLaunchFailureArtifacts() {
  const artifacts = findLatestLaunchFailureArtifactDirs();
  if (artifacts.length === 0) {
    console.error('No launch failure artifact pack found under ~/.claude/teams.');
    return;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-launch-failure-artifacts-'));
  try {
    for (const artifact of artifacts) {
      const destination = path.join(staging, `${artifact.teamName}-${path.basename(artifact.dir)}`);
      fs.cpSync(artifact.dir, destination, { recursive: true });
    }
    const bundle = path.join(
      os.tmpdir(),
      `agent-team-launch-failure-artifacts-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
    );
    const tar = spawnSync('tar', ['-czf', bundle, '-C', staging, '.'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 256_000,
    });
    if (tar.status !== 0) {
      console.error(`Failed to create artifact bundle: ${compactOutput(tar.stderr || tar.stdout || tar.error?.message || 'tar failed')}`);
      return;
    }
    console.error(`Launch failure artifact bundle: ${bundle}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function findLatestLaunchFailureArtifactDirs() {
  const teamsRoot = path.join(os.homedir(), '.claude', 'teams');
  const results = [];
  for (const teamName of safeReaddirNames(teamsRoot)) {
    const latestPath = path.join(teamsRoot, teamName, 'launch-failure-artifacts', 'latest.json');
    const latest = readJsonIfExists(latestPath);
    const manifestPath =
      typeof latest?.manifestPath === 'string' ? latest.manifestPath : null;
    const dir = manifestPath ? path.dirname(manifestPath) : null;
    if (!dir || !fs.existsSync(dir)) continue;
    const stat = fs.statSync(dir);
    results.push({ teamName, dir, mtimeMs: stat.mtimeMs });
  }
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 4);
}

function safeReaddirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function safeReaddirFileNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compactOutput(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 1_200);
}
