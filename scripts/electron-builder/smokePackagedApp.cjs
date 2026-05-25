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

function isMacBundle(candidatePath) {
  return (
    candidatePath.endsWith('.app') &&
    fs.existsSync(path.join(candidatePath, 'Contents', 'MacOS')) &&
    fs.statSync(path.join(candidatePath, 'Contents', 'MacOS')).isDirectory()
  );
}

function findMacBundles(searchRoot, maxDepth = 3) {
  if (!fs.existsSync(searchRoot) || maxDepth < 0) {
    return [];
  }

  const stat = fs.statSync(searchRoot);
  if (stat.isDirectory() && isMacBundle(searchRoot)) {
    return [searchRoot];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const bundles = [];
  for (const entry of fs.readdirSync(searchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(searchRoot, entry.name);
    if (isMacBundle(fullPath)) {
      bundles.push(fullPath);
      continue;
    }
    bundles.push(...findMacBundles(fullPath, maxDepth - 1));
  }
  return bundles;
}

function resolveBundlePath(bundlePath, platform) {
  if (platform !== 'darwin' || isMacBundle(bundlePath)) {
    return bundlePath;
  }

  const searchRoots = [
    path.dirname(bundlePath),
    path.dirname(path.dirname(bundlePath)),
    path.resolve(process.cwd(), 'release'),
  ];
  const bundles = [...new Set(searchRoots.flatMap((searchRoot) => findMacBundles(searchRoot)))];
  if (bundles.length === 1) {
    return bundles[0];
  }
  if (bundles.length > 1) {
    const expectedName = path.basename(bundlePath);
    const nameMatch = bundles.find((candidate) => path.basename(candidate) === expectedName);
    if (nameMatch) {
      return nameMatch;
    }
  }

  return bundlePath;
}

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
    const preferredNames = [
      packageJson.name,
      'agent-teams-ai',
      'Agent Teams AI',
      'Agent Teams UI',
    ].filter(Boolean);
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
    const pid = child.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    } else {
      child.kill();
    }
  }

  const closed = await waitForProcessClose(child, exitPromise, SHUTDOWN_TIMEOUT_MS);
  if (!closed && child.exitCode === null && child.signalCode === null) {
    if (child.pid && platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      child.kill('SIGKILL');
    }
    const killed = await waitForProcessClose(child, exitPromise, SHUTDOWN_TIMEOUT_MS);
    if (!killed && child.exitCode === null && child.signalCode === null) {
      throw new Error(`Timed out after ${SHUTDOWN_TIMEOUT_MS}ms waiting for packaged app to exit`);
    }
  }
}

async function main() {
  const [bundlePathArg, platform] = process.argv.slice(2);
  if (!bundlePathArg || !platform) {
    fail('Usage: node ./scripts/electron-builder/smokePackagedApp.cjs <bundlePath> <platform>');
  }

  const bundlePath = resolveBundlePath(path.resolve(bundlePathArg), platform);
  const executable = findExecutable(bundlePath, platform);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-smoke-'));
  const args = [`--user-data-dir=${userDataDir}`];
  if (platform === 'linux') {
    args.push('--no-sandbox');
  }
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      AGENT_TEAMS_PACKAGED_SMOKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32',
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

if (require.main === module) {
  main().catch((error) => fail(error?.stack || String(error)));
}

module.exports = {
  _internal: {
    terminateChild,
    waitForProcessClose,
  },
};
