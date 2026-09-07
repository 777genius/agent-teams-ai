const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STARTUP_TIMEOUT_MS = Number(process.env.PACKAGED_SMOKE_TIMEOUT_MS ?? 30_000);
const POST_STARTUP_STABLE_MS = Number(process.env.PACKAGED_SMOKE_STABLE_MS ?? 8_000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS ?? 5_000);
const REQUIRED_LOG_MARKERS = ['renderer did-finish-load'];
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');
const INTERNAL_STORAGE_FALLBACK_PATTERNS = [
  /internal-storage sqlite backend unavailable; falling back to JSON stores for this session/i,
];
const FAILURE_PATTERNS = [
  /Cannot find module/i,
  /MODULE_NOT_FOUND/i,
  /Failed to start HTTP server/i,
  /Unable to set login item/i,
  /\[DEP0180\]/i,
  /DeprecationWarning: fs\.Stats constructor is deprecated/i,
  ...INTERNAL_STORAGE_FALLBACK_PATTERNS,
];

function getInternalStorageVerificationError(userDataDir, log) {
  if (INTERNAL_STORAGE_FALLBACK_PATTERNS.some((pattern) => pattern.test(log))) {
    return 'Detected internal-storage SQLite fallback warning';
  }

  const databasePath = path.join(userDataDir, 'storage', 'app.db');
  if (!fs.existsSync(databasePath)) {
    return `Internal-storage SQLite database was not created: ${databasePath}`;
  }

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(databasePath, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
    if (bytesRead !== SQLITE_HEADER.length || !header.equals(SQLITE_HEADER)) {
      return `Internal-storage database has an invalid SQLite header: ${databasePath}`;
    }
  } catch (error) {
    return `Unable to verify internal-storage SQLite database ${databasePath}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }

  return null;
}

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

function waitForProcessClose(closePromise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([closePromise.then(() => true), timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

async function waitForOwnedGroupExit(groupId, timeoutMs) {
  if (!groupId) return; // Failed spawn has no owned process group.
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = spawnSync('ps', ['-ax', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Unable to verify packaged app process group cleanup');
    // Orphans may remain as zombies until PID 1 reaps them; they cannot execute
    // or retain open pipes, so waiting for their PIDs to vanish would hang CI.
    const running = result.stdout.split('\n').some((line) => {
      const match = /^\s*(\d+)\s+(\S+)/.exec(line);
      return match && Number(match[1]) === groupId && !/^[ZX]/.test(match[2]);
    });
    if (!running) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for packaged app process group ${groupId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}

async function terminateChild(child, closePromise, platform, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  // POSIX callers must spawn detached: only this smoke-owned process group is signalled.
  // The leader may already have exited while descendants still hold its output pipes.
  const signalOwnedGroup = (signal) => {
    if (!child.pid) return; // Failed spawn: no owned process exists.
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };

  if (platform === 'win32') {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      const killerDone = new Promise((resolve) => {
        killer.once('error', resolve);
        killer.once('close', resolve);
      });
      if (!(await waitForProcessClose(killerDone, timeoutMs))) {
        killer.kill();
        throw new Error(`Timed out after ${timeoutMs}ms waiting for taskkill.exe`);
      }
    }
  } else {
    signalOwnedGroup('SIGTERM');
  }

  if (await waitForProcessClose(closePromise, timeoutMs)) {
    // A descendant with redirected stdio can outlive close. Stop any remaining
    // members of our group before reporting success, even when no pipes remain.
    if (platform !== 'win32') {
      signalOwnedGroup('SIGKILL');
      await waitForOwnedGroupExit(child.pid, timeoutMs);
    }
    return;
  }
  console.error(`[smokePackagedApp] shutdown grace expired: pid=${child.pid}; forcing cleanup`);
  if (platform === 'win32') {
    child.kill('SIGKILL');
  } else {
    signalOwnedGroup('SIGKILL');
  }
  if (!(await waitForProcessClose(closePromise, timeoutMs))) {
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for packaged app stdio to close: ` +
        `pid=${child.pid} exitCode=${child.exitCode} signal=${child.signalCode}`
    );
  }
  if (platform !== 'win32') await waitForOwnedGroupExit(child.pid, timeoutMs);
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
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => {
      console.log(`[smokePackagedApp] leader exit: code=${code} signal=${signal}`);
      resolve({ code, signal });
    });
  });
  const closePromise = new Promise((resolve) => {
    child.once('close', () => {
      console.log(`[smokePackagedApp] stdio closed: pid=${child.pid}`);
      resolve();
    });
  });
  child.once('spawn', () => console.log(`[smokePackagedApp] spawned: pid=${child.pid}`));

  let startupError;
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let startupSeenAt = null;
    let storageVerificationError = null;
    let startupVerified = false;
    while (Date.now() < deadline) {
      if (FAILURE_PATTERNS.some((pattern) => pattern.test(log))) {
        throw new Error('Detected startup failure pattern');
      }

      if (startupSeenAt === null && REQUIRED_LOG_MARKERS.every((marker) => log.includes(marker))) {
        startupSeenAt = Date.now();
        console.log('[smokePackagedApp] renderer ready');
      }

      if (startupSeenAt !== null && Date.now() - startupSeenAt >= POST_STARTUP_STABLE_MS) {
        storageVerificationError = getInternalStorageVerificationError(userDataDir, log);
        if (storageVerificationError === null) {
          startupVerified = true;
          break;
        }
      }

      const exit = await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (exit) {
        if (exit.error) throw exit.error;
        throw new Error(
          `Packaged app exited before startup completed: code=${exit.code} signal=${exit.signal}`
        );
      }
    }

    if (!startupVerified) {
      throw new Error(
        storageVerificationError ||
          `Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for packaged startup`
      );
    }
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    // Every startup outcome must clean up descendants, including early exit or spawn failure.
    try {
      await terminateChild(child, closePromise, platform);
    } catch (cleanupError) {
      if (startupError) {
        console.error(
          `[smokePackagedApp] Startup failed before cleanup: ${startupError.stack || String(startupError)}`
        );
      }
      throw cleanupError;
    } finally {
      if (log.trim()) console.log(`--- packaged app log ---\n${log.trim()}`);
    }
  }
  console.log(`[smokePackagedApp] OK ${platform}: ${bundlePath}`);
}

if (require.main === module) {
  main().catch((error) => fail(error?.stack || String(error)));
}

module.exports = {
  _internal: {
    getInternalStorageVerificationError,
    terminateChild,
    waitForProcessClose,
  },
};
