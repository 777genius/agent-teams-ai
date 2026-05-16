const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STARTUP_TIMEOUT_MS = Number(process.env.PACKAGED_SMOKE_TIMEOUT_MS ?? 30_000);
const POST_STARTUP_STABLE_MS = Number(process.env.PACKAGED_SMOKE_STABLE_MS ?? 8_000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS ?? 5_000);
const REQUIRED_LOG_MARKERS = ['renderer did-finish-load'];
const FAILURE_PATTERNS = [
  /Cannot find module/i,
  /MODULE_NOT_FOUND/i,
  /Failed to start HTTP server/i,
  /Unable to set login item/i,
  /\[DEP0180\]/i,
  /DeprecationWarning: fs\.Stats constructor is deprecated/i,
];

function fail(message, log = '') {
  console.error(`[smokePackagedApp] ${message}`);
  if (log.trim()) {
    console.error('--- packaged app log ---');
    console.error(log.trim());
  }
  process.exit(1);
}

function findExecutable(bundlePath, platform) {
  if (platform === 'darwin') {
    const macOsDir = path.join(bundlePath, 'Contents', 'MacOS');
    const entries = fs.readdirSync(macOsDir);
    const executable = entries.find((entry) => {
      const fullPath = path.join(macOsDir, entry);
      return fs.statSync(fullPath).isFile() && (fs.statSync(fullPath).mode & 0o111) !== 0;
    });
    if (!executable) fail(`No executable found in ${macOsDir}`);
    return path.join(macOsDir, executable);
  }

  if (platform === 'win32') {
    const executable = fs
      .readdirSync(bundlePath)
      .find(
        (entry) =>
          entry.toLowerCase().endsWith('.exe') && !entry.toLowerCase().includes('uninstall')
      );
    if (!executable) fail(`No .exe found in ${bundlePath}`);
    return path.join(bundlePath, executable);
  }

  if (platform === 'linux') {
    const packageJsonPath = path.join(bundlePath, 'resources', 'app.asar.unpacked', 'package.json');
    const packageJson = fs.existsSync(packageJsonPath)
      ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      : {};
    const preferredNames = [packageJson.name, 'agent-teams-ai', 'Agent Teams UI'].filter(Boolean);
    for (const name of preferredNames) {
      const candidate = path.join(bundlePath, name);
      if (fs.existsSync(candidate)) return candidate;
    }

    const executable = fs.readdirSync(bundlePath).find((entry) => {
      const fullPath = path.join(bundlePath, entry);
      return fs.statSync(fullPath).isFile() && (fs.statSync(fullPath).mode & 0o111) !== 0;
    });
    if (!executable) fail(`No executable found in ${bundlePath}`);
    return path.join(bundlePath, executable);
  }

  fail(`Unsupported platform: ${platform}`);
}

function waitForProcessClose(child, exitPromise, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([exitPromise.then(() => true), timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

async function terminateChild(child, exitPromise, platform) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    child.kill();
  }

  const closed = await waitForProcessClose(child, exitPromise, SHUTDOWN_TIMEOUT_MS);
  if (!closed && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Timed out after ${SHUTDOWN_TIMEOUT_MS}ms waiting for packaged app to exit`);
  }
}

async function main() {
  const [bundlePathArg, platform] = process.argv.slice(2);
  if (!bundlePathArg || !platform) {
    fail('Usage: node ./scripts/electron-builder/smokePackagedApp.cjs <bundlePath> <platform>');
  }

  const bundlePath = path.resolve(bundlePathArg);
  const executable = findExecutable(bundlePath, platform);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-smoke-'));
  const args = [`--user-data-dir=${userDataDir}`];
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      AGENT_TEAMS_PACKAGED_SMOKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    log += chunk.toString();
  });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let startupSeenAt = null;
  while (Date.now() < deadline) {
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(log))) {
      await terminateChild(child, exitPromise, platform);
      fail('Detected startup failure pattern', log);
    }

    if (startupSeenAt === null && REQUIRED_LOG_MARKERS.every((marker) => log.includes(marker))) {
      startupSeenAt = Date.now();
    }

    if (startupSeenAt !== null && Date.now() - startupSeenAt >= POST_STARTUP_STABLE_MS) {
      await terminateChild(child, exitPromise, platform);
      console.log(`[smokePackagedApp] OK ${platform}: ${bundlePath}`);
      return;
    }

    const exit = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (exit) {
      fail(
        `Packaged app exited before startup completed: code=${exit.code} signal=${exit.signal}`,
        log
      );
    }
  }

  await terminateChild(child, exitPromise, platform);
  fail(`Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for packaged startup`, log);
}

main().catch((error) => fail(error?.stack || String(error)));
