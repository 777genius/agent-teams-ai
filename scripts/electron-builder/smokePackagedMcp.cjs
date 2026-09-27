const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

async function main() {
  const [bundle, platform] = process.argv.slice(2);
  if (!bundle || !['darwin', 'win32', 'linux'].includes(platform)) {
    throw new Error('Usage: smokePackagedMcp.cjs <bundle> <darwin|win32|linux>');
  }

  const resources = path.join(
    path.resolve(bundle),
    ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources'])
  );
  const serverPath = path.join(resources, 'mcp-server', 'index.js');
  if (!fs.existsSync(serverPath)) throw new Error(`Packaged MCP server is missing: ${serverPath}`);

  const testProject = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-mcp-test-'));
  fs.writeFileSync(path.join(testProject, '.test-only'), 'electron-mcp-test-v1');
  const child = spawn(process.execPath, [serverPath], {
    cwd: testProject,
    env: {
      ...process.env,
      HOME: testProject,
      USERPROFILE: testProject,
      CLAUDE_CONFIG_DIR: path.join(testProject, '.claude'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    console.log(`[smokePackagedMcp] OK ${platform}: ${tools.result.tools.length} tools`);
  } finally {
    child.kill('SIGTERM');
    child.stdin.destroy();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
    });
    fs.rmSync(testProject, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
