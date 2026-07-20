import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHILD_CLOSE_GRACE_MS = 3_000;
const CHILD_FORCE_CLOSE_GRACE_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const OPENCODE_HEALTH_FETCH_TIMEOUT_MS = 1_000;

export async function preflightOpenCodeLiveEnvironment(input) {
  const repoRoot = input.repoRoot;
  const projectPath = input.projectPath || repoRoot;
  const sourceEnv = input.env ?? process.env;
  const requiredModels = Array.isArray(input.requiredModels)
    ? input.requiredModels.map((model) => String(model).trim()).filter(Boolean)
    : [];
  const opencodeBin =
    sourceEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim() ||
    sourceEnv.OPENCODE_BIN?.trim() ||
    '/opt/homebrew/bin/opencode';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-live-preflight-'));
  const xdgDataHome = path.join(tempRoot, 'xdg-data');
  const useManagedAppCredentials =
    sourceEnv.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS === '1' &&
    Boolean(sourceEnv.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim());
  const env = {
    ...sourceEnv,
    ...(useManagedAppCredentials ? {} : { XDG_DATA_HOME: xdgDataHome }),
    OPENCODE_DISABLE_AUTOUPDATE: sourceEnv.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
  };

  try {
    if (!fs.existsSync(opencodeBin)) {
      return skip(`OpenCode binary not found at ${opencodeBin}`);
    }

    const models = shouldUseManagedAppCredentials(env)
      ? runManagedOpenCodeModels(requiredModels, projectPath, env)
      : runOpenCodeCommand(opencodeBin, ['models'], projectPath, env);
    if (!models.ok) {
      return skip(`opencode models failed: ${models.output}`);
    }
    const missingModels = findMissingOpenCodeModels(models.output, requiredModels);
    if (missingModels.length > 0) {
      return skip(
        `opencode models missing selected model(s): ${missingModels.join(', ')}. Available: ${compactOutput(
          parseOpenCodeModels(models.output).join(', ') || 'none'
        )}`
      );
    }

    const agents = runOpenCodeCommand(opencodeBin, ['agent', 'list'], projectPath, env);
    if (!agents.ok) {
      return skip(`opencode agent list failed: ${agents.output}`);
    }

    const loopback = await canBindLoopback();
    if (!loopback.ok) {
      return skip(`127.0.0.1 loopback bind failed: ${loopback.reason}`);
    }

    const host = await canStartOpenCodeHost(opencodeBin, projectPath, env);
    if (!host.ok) {
      return skip(`opencode serve health check failed: ${host.reason}`);
    }

    return { ok: true };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function shouldUseManagedAppCredentials(env) {
  return (
    env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS === '1' &&
    Boolean(env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim())
  );
}

function runManagedOpenCodeModels(requiredModels, cwd, env) {
  const providers = Array.from(
    new Set(requiredModels.map((model) => model.slice(0, model.indexOf('/'))).filter(Boolean))
  );
  const availableModels = [];
  for (const provider of providers) {
    const result = runOpenCodeCommand(
      env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH,
      [
        'runtime',
        'providers',
        'models',
        '--runtime',
        'opencode',
        '--provider',
        provider,
        '--project-path',
        cwd,
        '--limit',
        '100',
        '--json',
      ],
      cwd,
      env,
      90_000
    );
    if (!result.ok) {
      return result;
    }
    try {
      const payload = JSON.parse(result.output);
      const models = payload?.models?.models;
      if (!Array.isArray(models)) {
        return { ok: false, output: `managed provider ${provider} returned no model list` };
      }
      for (const model of models) {
        if (typeof model?.modelId === 'string' && model.modelId.trim()) {
          availableModels.push(model.modelId.trim());
        }
      }
    } catch (error) {
      return {
        ok: false,
        output: `managed provider ${provider} returned invalid JSON: ${compactOutput(
          error instanceof Error ? error.message : String(error)
        )}`,
      };
    }
  }
  return { ok: true, output: `${availableModels.join('\n')}\n` };
}

export function exitForSkippedPreflight(result) {
  if (result.ok) {
    return false;
  }
  console.warn(`SKIPPED: ${result.reason}`);
  process.exit(process.env.OPENCODE_E2E_STRICT === '1' ? 1 : 0);
}

function runOpenCodeCommand(opencodeBin, args, cwd, env, timeout = 20_000) {
  const result = spawnSync(opencodeBin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 256_000,
  });
  if (result.status === 0) {
    return { ok: true, output: result.stdout || '' };
  }
  return {
    ok: false,
    output: compactOutput(result.stderr || result.stdout || result.error?.message || 'unknown'),
  };
}

function parseOpenCodeModels(output) {
  return output
    .split(/\s+/)
    .map((model) => model.trim())
    .filter(Boolean);
}

function findMissingOpenCodeModels(output, requiredModels) {
  if (requiredModels.length === 0) return [];
  const available = new Set(parseOpenCodeModels(output));
  return requiredModels.filter((model) => !available.has(model));
}

function canBindLoopback() {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timeout = setTimeout(() => {
      server.close(() => undefined);
      resolve({ ok: false, reason: 'timed out allocating loopback port' });
    }, 5_000);
    server.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: error.message });
    });
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout);
      server.close((error) => {
        resolve(error ? { ok: false, reason: error.message } : { ok: true });
      });
    });
  });
}

async function canStartOpenCodeHost(opencodeBin, cwd, env) {
  const port = await allocateLoopbackPort();
  const child = spawn(opencodeBin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let spawnError = '';
  const append = (chunk) => {
    output = compactOutput(`${output}\n${chunk.toString('utf8')}`);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('error', (error) => {
    spawnError = error.message;
    append(error.message);
  });

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        return { ok: false, reason: spawnError };
      }
      if (child.exitCode != null) {
        return { ok: false, reason: output || `process exited with code ${child.exitCode}` };
      }
      try {
        const response = await fetchOpenCodeHealth(port);
        if (isHealthyOpenCodeHostResponse(response)) {
          response.body?.cancel().catch(() => undefined);
          return { ok: true };
        }
        response.body?.cancel().catch(() => undefined);
      } catch {
        // Host is still starting.
      }
      await sleep(250);
    }
    return { ok: false, reason: output || 'timed out waiting for /global/health' };
  } finally {
    await stopChild(child);
  }
}

async function fetchOpenCodeHealth(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENCODE_HEALTH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isHealthyOpenCodeHostResponse(response) {
  return response.ok;
}

async function stopChild(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const killProcessTree = options.killProcessTree ?? taskkillProcessTree;
  const closeGraceMs = options.closeGraceMs ?? CHILD_CLOSE_GRACE_MS;
  const forceCloseGraceMs = options.forceCloseGraceMs ?? CHILD_FORCE_CLOSE_GRACE_MS;

  if (hasChildExited(child)) {
    return;
  }

  if (platform === 'win32' && child.pid) {
    await killProcessTree(child.pid);
  } else if (!child.killed) {
    sendChildSignal(child, 'SIGTERM');
  }

  if (await waitForChildClose(child, closeGraceMs)) {
    return;
  }

  if (!hasChildExited(child)) {
    sendChildSignal(child, 'SIGKILL');
    if (!(await waitForChildClose(child, forceCloseGraceMs))) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
    }
  }
}

function taskkillProcessTree(pid) {
  return new Promise((resolve) => {
    let done = false;
    let taskkill = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      if (taskkill) {
        sendChildSignal(taskkill, 'SIGTERM');
      }
      finish();
    }, TASKKILL_TIMEOUT_MS);
    try {
      taskkill = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/T', '/F', '/PID', String(pid)],
        {
          stdio: 'ignore',
          windowsHide: true,
        }
      );
      taskkill.unref?.();
      taskkill.once('error', finish);
      taskkill.once('close', finish);
    } catch {
      finish();
    }
  });
}

function waitForChildClose(child, timeoutMs) {
  if (hasChildExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(closed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('close', () => finish(true));
  });
}

function hasChildExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function sendChildSignal(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone between liveness checks and the kill call.
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate loopback port')));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skip(reason) {
  return { ok: false, reason };
}

function compactOutput(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1_200);
}

export const __opencodeLivePreflightTestHooks = {
  findMissingOpenCodeModels,
  isHealthyOpenCodeHostResponse,
  parseOpenCodeModels,
  runManagedOpenCodeModels,
  shouldUseManagedAppCredentials,
  stopChild,
  taskkillProcessTree,
};
