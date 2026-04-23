import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export async function preflightOpenCodeLiveEnvironment(input) {
  const repoRoot = input.repoRoot;
  const opencodeBin = process.env.OPENCODE_BIN?.trim() || '/opt/homebrew/bin/opencode';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-live-preflight-'));
  const xdgDataHome = path.join(tempRoot, 'xdg-data');
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdgDataHome,
    OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
  };

  try {
    if (!fs.existsSync(opencodeBin)) {
      return skip(`OpenCode binary not found at ${opencodeBin}`);
    }

    const models = runOpenCodeCommand(opencodeBin, ['models'], repoRoot, env);
    if (!models.ok) {
      return skip(`opencode models failed: ${models.output}`);
    }

    const agents = runOpenCodeCommand(opencodeBin, ['agent', 'list'], repoRoot, env);
    if (!agents.ok) {
      return skip(`opencode agent list failed: ${agents.output}`);
    }

    const loopback = await canBindLoopback();
    if (!loopback.ok) {
      return skip(`127.0.0.1 loopback bind failed: ${loopback.reason}`);
    }

    const host = await canStartOpenCodeHost(opencodeBin, repoRoot, env);
    if (!host.ok) {
      return skip(`opencode serve health check failed: ${host.reason}`);
    }

    return { ok: true };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function exitForSkippedPreflight(result) {
  if (result.ok) {
    return false;
  }
  console.warn(`SKIPPED: ${result.reason}`);
  process.exit(process.env.OPENCODE_E2E_STRICT === '1' ? 1 : 0);
}

function runOpenCodeCommand(opencodeBin, args, cwd, env) {
  const result = spawnSync(opencodeBin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 256_000,
  });
  if (result.status === 0) {
    return { ok: true, output: '' };
  }
  return {
    ok: false,
    output: compactOutput(result.stderr || result.stdout || result.error?.message || 'unknown'),
  };
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
        const response = await fetch(`http://127.0.0.1:${port}/global/health`);
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          if (data?.healthy === true) {
            return { ok: true };
          }
        }
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

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 3_000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
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
