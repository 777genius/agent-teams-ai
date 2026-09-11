import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isolatedEnvironment } from './platform.mjs';

export function packagedArguments(args, platform = process.platform) {
  assert.equal(platform, 'win32', 'Packaged harness requires Windows');
  assert(
    args.length === 2 || args.length === 4,
    'Usage: --packaged-executable <absolute unpacked exe> [--runtime-setup app-install]'
  );
  assert.equal(args[0], '--packaged-executable');
  const executable = args[1];
  assert(
    /^[a-z]:[\\/]/i.test(executable) &&
      /\.exe$/i.test(executable) &&
      !/[\x00-\x1f"<>|*?]/.test(executable) &&
      !executable.slice(2).includes(':'),
    'Expected a local absolute unpacked .exe path, not an installer, UNC path or command'
  );
  assert(!/(?:setup|uninstall)/i.test(path.win32.basename(executable)), 'Installer refused');
  if (args.length === 4) {
    assert.equal(args[2], '--runtime-setup');
    assert.equal(args[3], 'app-install', 'Only the supported app installer is allowed');
  }
  return { executable, runtimeSetup: args.length === 4 ? 'app-install' : 'none' };
}

export function containedPath(candidate, base, paths = path) {
  const relative = paths.relative(base, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${paths.sep}`) &&
    relative !== '..' &&
    !paths.isAbsolute(relative)
  );
}

export async function fingerprint(file) {
  const resolved = await realpath(file);
  assert((await stat(resolved)).isFile(), 'Artifact must be a file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolved)) hash.update(chunk);
  return { path: resolved, sha256: hash.digest('hex') };
}

export async function packagedArtifact(executable) {
  const app = await fingerprint(executable);
  const resources = path.join(path.dirname(app.path), 'resources');
  const archive = await fingerprint(path.join(resources, 'app.asar'));
  const orchestrator = await fingerprint(path.join(resources, 'runtime/claude-multimodel.exe'));
  const renderer = path.join(resources, 'app.asar.unpacked/out/renderer/index.html');
  const rendererArtifact = await fingerprint(renderer);
  for (const item of [archive, orchestrator, rendererArtifact])
    assert(containedPath(item.path, path.dirname(app.path)), 'Packaged resource escapes artifact');
  return {
    app,
    archive,
    orchestrator,
    rendererArtifact,
    // Electron loadFile uses the virtual asar path even though renderer files are unpacked.
    renderer: path.join(resources, 'app.asar/out/renderer/index.html'),
  };
}

export function packagedEnvironment(data, inherited = process.env, paths = path) {
  // Reuse the existing allowlist, then discard all fixture/runtime/build overrides.
  const base = isolatedEnvironment(
    { ...data, bin: '', node: '', orchestrator: '', opencode: '' },
    inherited
  );
  const systemRoot = Object.entries(inherited).find(
    ([key]) => key.toLowerCase() === 'systemroot'
  )?.[1];
  assert(systemRoot && paths.isAbsolute(systemRoot), 'SystemRoot required');
  const env = {};
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'AGENT_TEAMS_ELECTRON_USER_DATA_DIR',
    'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
  ])
    env[key] = base[key];
  // Preserve OS/module plumbing already allowed by the shared sandbox environment.
  for (const [key, value] of Object.entries(base))
    if (
      /^(ProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|PSModulePath)$/i.test(
        key
      )
    )
      env[key] = value;
  // No inherited PATH, NVM, shell, provider keys, Node or CLI overrides.
  env.SystemRoot = systemRoot;
  env.WINDIR = systemRoot;
  env.ComSpec = paths.join(systemRoot, 'System32/cmd.exe');
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  env.PATH = [
    paths.join(systemRoot, 'System32'),
    systemRoot,
    paths.join(systemRoot, 'System32/WindowsPowerShell/v1.0'),
  ].join(paths.delimiter);
  return env;
}

async function createProfileDirectory(directory, root) {
  const ownedRoot = await realpath(root);
  let ancestor = directory;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      assert.notEqual(parent, ancestor, 'No existing profile ancestor');
      ancestor = parent;
    }
  }
  const resolvedAncestor = await realpath(ancestor);
  assert(
    resolvedAncestor === ownedRoot || containedPath(resolvedAncestor, ownedRoot),
    'Profile junction escapes sandbox before directory creation'
  );
  await mkdir(directory, { recursive: true });
  assert(containedPath(await realpath(directory), ownedRoot), 'Profile junction escapes sandbox');
}

export async function preparePackagedProfile(data, inherited = process.env) {
  const env = packagedEnvironment(data, inherited);
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'AGENT_TEAMS_ELECTRON_USER_DATA_DIR',
    'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
  ]) {
    assert(containedPath(env[key], data.root), `Profile escapes sandbox: ${key}`);
    await createProfileDirectory(env[key], data.root);
  }
  // Production Windows resolver skips login-shell env; its common install/NVM roots
  // are all under disposable HOME/APPDATA when ProgramFiles and NVM are absent.
  for (const dir of env.PATH.split(path.delimiter)) {
    for (const name of ['opencode', 'claude-multimodel']) {
      for (const suffix of ['', '.exe', '.cmd', '.bat'])
        assert(!existsSync(path.join(dir, name + suffix)), 'Installed runtime fallback present');
    }
  }
  // Validate every existing ancestor even in a clean profile with no manifest.
  // The app installer writes below this directory before provenance can be checked.
  const managedRoot = path.join(data.userData, 'data/runtimes/opencode');
  await createProfileDirectory(managedRoot, data.userData);
  const managedManifest = path.join(managedRoot, 'current.json');
  if (existsSync(managedManifest)) {
    assert(
      containedPath(await realpath(managedManifest), await realpath(data.userData)),
      'Managed manifest escapes profile'
    );
    const managed = JSON.parse(await readFile(managedManifest, 'utf8'));
    assert.equal(managed.schemaVersion, 1);
    assert(
      managed.integrity && managed.platformPackage !== 'diagnostics-fixture',
      'Fixture manifest refused'
    );
    assert(
      containedPath(
        await realpath(managed.binaryPath),
        await realpath(path.join(data.userData, 'data/runtimes/opencode'))
      ),
      'Managed OpenCode escapes disposable runtime root'
    );
  }
  return env;
}

export function packagedTarget(targets, renderer, ownershipVerified, paths = path) {
  assert.equal(
    ownershipVerified,
    true,
    'PID/birth/port verification required before file renderer'
  );
  const matches = targets.filter((entry) => {
    if (entry.type !== 'page') return false;
    try {
      const url = new URL(entry.url);
      if (url.protocol !== 'file:' || url.hostname || url.search) return false;
      let filename = decodeURIComponent(url.pathname);
      if (paths === path.win32) filename = filename.replace(/^\//, '');
      return paths.normalize(filename).toLowerCase() === paths.normalize(renderer).toLowerCase();
    } catch {
      return false;
    }
  });
  assert.equal(matches.length, 1, 'Expected exactly one packaged renderer entrypoint');
  return matches[0];
}

export async function runtimeProvenance(status, data, role) {
  assert(status?.binaryPath, `${role} discovery returned no binary`);
  const binary = await fingerprint(status.binaryPath);
  if (role === 'orchestrator') {
    assert.equal(
      binary.path.toLowerCase(),
      data.artifact.orchestrator.path.toLowerCase(),
      'Non-bundled orchestrator refused'
    );
    assert.equal(binary.sha256, data.artifact.orchestrator.sha256, 'Bundled runtime changed');
  } else {
    assert.equal(status.source, 'app-managed', 'Installed developer/PATH OpenCode refused');
    const managedRoot = await realpath(path.join(data.userData, 'data/runtimes/opencode'));
    assert(
      containedPath(managedRoot, await realpath(data.userData)),
      'Managed runtime root escapes profile'
    );
    assert(
      containedPath(binary.path, managedRoot) && /\.exe$/i.test(binary.path),
      'OpenCode must be installed by the app inside the disposable profile'
    );
  }
  return {
    ...binary,
    version: status.version ?? status.installedVersion ?? null,
    source: status.source ?? 'bundled',
  };
}

// Only call after runtimeProvenance has verified the selected bundled file.
// Return evidence even on failure so the caller persists it before asserting.
export function probeOrchestratorVersion(
  binaryPath,
  { env, cwd, timeout = 10000 },
  execute = execFile
) {
  assert(timeout > 0 && timeout <= 10000);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return new Promise((resolve) => {
    execute(
      binaryPath,
      ['--version'],
      {
        env,
        cwd,
        timeout,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          binaryPath,
          args: ['--version'],
          startedAt,
          durationMs: performance.now() - started,
          timeoutMs: timeout,
          exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          signal: error?.signal ?? null,
          timedOut: Boolean(error?.killed && error?.signal === 'SIGKILL'),
          error: error ? String(error) : null,
          stdout,
          stderr,
          passed: !error && Boolean(stdout.trim()),
        })
    );
  });
}

// Ownership is established before ordering; executable names alone grant no authority.
export function packagedStopOrder(owned, executable) {
  const main = owned.filter(entry => entry.parent === owned[0]?.pid
    && entry.executable?.toLowerCase() === executable.toLowerCase());
  assert(main.length <= 1, 'Ambiguous packaged main identity');
  return [...main, ...owned.filter(entry => entry !== main[0]).reverse()];
}

export function packagedDrainSnapshot(identities, snapshot, listenerPids) {
  const ownedRemaining = identities.filter(entry => snapshot.some(current =>
    current.pid === entry.pid && current.birth === entry.birth));
  return { ownedRemaining, listenerPids,
    drained: ownedRemaining.length === 0 && listenerPids.length === 0 };
}

// Acknowledgement is diagnostic only; the caller must still prove OS/socket drain.
export async function closePackagedBrowser({ assertOwnership, readVersion, connect, timeoutMs = 5000 }) {
  await assertOwnership();
  const version = await readVersion();
  const endpoint = new URL(version.webSocketDebuggerUrl);
  assert(endpoint.protocol === 'ws:' && endpoint.port === '9222'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && endpoint.pathname.startsWith('/devtools/browser/'),
  'Unexpected packaged browser CDP endpoint');
  await assertOwnership();
  const ws = connect(endpoint);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Packaged Browser.close timed out')), timeoutMs);
      let sent = false;
      let finished = false;
      const finish = (error, outcome) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(outcome);
      };
      ws.once('error', error => finish(error));
      ws.once('close', () => finish(sent ? null : new Error('CDP closed before Browser.close'), 'socket-closed'));
      ws.on('message', raw => {
        try {
          const response = JSON.parse(String(raw));
          if (response.id === 1) finish(response.error ? new Error(response.error.message) : null, 'acknowledged');
        } catch (error) { finish(error); }
      });
      ws.once('open', async () => {
        try {
          await assertOwnership();
          if (finished) return;
          if (ws.readyState !== 1) throw new Error('CDP closed during ownership check');
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          sent = true;
        } catch (error) { finish(error); }
      });
    });
  } finally {
    ws.terminate();
  }
}
