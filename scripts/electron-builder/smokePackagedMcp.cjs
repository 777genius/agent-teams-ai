const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { findExecutable, resolveBundlePath, terminateChild } =
  require('./smokePackagedApp.cjs')._internal;

async function main() {
  const [bundleArg, platform] = process.argv.slice(2);
  if (!bundleArg || !['darwin', 'win32', 'linux'].includes(platform)) {
    throw new Error('Usage: smokePackagedMcp.cjs <bundle> <darwin|win32|linux>');
  }

  const bundle = resolveBundlePath(path.resolve(bundleArg), platform);
  const executable = findExecutable(bundle, platform);
  const resources = path.join(
    bundle,
    ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources'])
  );
  const serverPath = path.join(resources, 'mcp-server', 'index.js');
  if (!fs.existsSync(serverPath)) throw new Error(`Packaged MCP server is missing: ${serverPath}`);

  const testProject = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-mcp-TEST-'));
  fs.writeFileSync(path.join(testProject, '.test-only'), 'electron-mcp-test-v1');
  const homeDir = path.join(testProject, 'home');
  const claudeRoot = path.join(testProject, 'claude');
  const userDataDir = path.join(testProject, 'user-data');
  for (const dir of [homeDir, claudeRoot, userDataDir]) fs.mkdirSync(dir);
  const overrides = {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userDataDir,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
    AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot,
    AGENT_TEAMS_MCP_TRANSPORT: 'stdio',
  };
  const childEnv = { ...process.env };
  // Windows env names are case-insensitive; remove aliases before assigning owned values.
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'NODE_OPTIONS' || Object.hasOwn(overrides, key.toUpperCase()))
      delete childEnv[key];
  }
  Object.assign(childEnv, overrides);
  const child = spawn(executable, [serverPath], {
    cwd: testProject,
    env: childEnv,
    detached: platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closePromise = new Promise((resolve) => child.once('close', resolve));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    } catch (error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    }
  });
  child.on('error', (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
  child.on('exit', (code) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`MCP exited with ${code}: ${stderr}`));
    }
    pending.clear();
  });

  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP ${method}: ${stderr}`));
      }, 15_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  let toolCount;
  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'packaged-smoke', version: '1.0.0' },
    });
    if (!initialized.result?.protocolVersion) {
      throw new Error(`Packaged MCP initialize failed: ${JSON.stringify(initialized)}`);
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    const tools = await request(2, 'tools/list', {});
    if (!Array.isArray(tools.result?.tools) || tools.result.tools.length === 0) {
      throw new Error(`Packaged MCP tools/list failed: ${JSON.stringify(tools)}`);
    }
    toolCount = tools.result.tools.length;
  } finally {
    child.stdin.destroy();
    try {
      await terminateChild(child, closePromise, platform, 2_000);
    } catch (error) {
      console.error(
        `[smokePackagedMcp] Preserved TEST sandbox after cleanup failure: ${testProject}`
      );
      throw error;
    }
    fs.rmSync(testProject, { recursive: true, force: true });
  }
  console.log(`[smokePackagedMcp] OK ${platform}: ${toolCount} tools`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
