/* Windows packaged E2E: Git lookup inside terminal-platform's real native PTY.
 * Only a disposable project and app-owned binaries are used; no agent login/network.
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description + ' timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function managedEnvironment(original, root, arch, sandbox) {
  const env = { ...original };
  const previousPath =
    Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  const flavor = arch === 'arm64' ? 'clangarm64' : 'ucrt64';
  env.PATH = [
    path.join(root, 'cmd'),
    path.join(root, flavor, 'bin'),
    path.join(root, flavor, 'usr', 'bin'),
    previousPath,
  ].filter(Boolean).join(';');
  env.GIT_EXEC_PATH = path.join(root, flavor, 'libexec', 'git-core');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(sandbox, 'test-global-gitconfig');
  env.GIT_TERMINAL_PROMPT = '0';
  env.HOME = sandbox;
  env.USERPROFILE = sandbox;
  env.APPDATA = path.join(sandbox, 'appdata');
  env.LOCALAPPDATA = path.join(sandbox, 'localappdata');
  return env;
}

async function waitForDaemon(sdk, slug, child, errors) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Bundled terminal daemon exited before ready: ' + errors());
    }
    const candidate = sdk.TerminalNodeClient.fromRuntimeSlug(slug);
    try {
      const response = await bounded(candidate.handshakeInfo(), 4000, 'Terminal handshake');
      assert.equal(response.assessment.can_use, true);
      return candidate;
    } catch {
      await bounded(candidate.close().catch(() => undefined), 1500, 'Client cleanup')
        .catch(() => undefined);
      await sleep(200);
    }
  }
  throw new Error('Bundled terminal daemon did not become ready: ' + errors());
}

async function stopOwnedDaemon(child) {
  if (!child || !child.pid) return;
  // Windows native shells are children of this disposable test-owned daemon.
  // Kill the entire tree to avoid leaking cmd.exe or PTY processes.
  if (child.exitCode === null && child.signalCode === null) {
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    if (killed.status !== 0 && child.exitCode === null) child.kill();
  }
  await sleep(250);
}

async function check(bundle, arch) {
  assert.equal(process.platform, 'win32', 'Native Windows terminal smoke must run on Windows');
  assert.equal(process.arch, arch, 'Native smoke must run on the target CPU architecture');
  const resources = path.join(path.resolve(bundle), 'resources');
  const gitRoot = path.join(resources, 'git');
  const terminalRoot = path.join(resources, 'terminal-platform');
  const manifest = JSON.parse(fs.readFileSync(path.join(gitRoot, 'MANAGED_GIT.json'), 'utf8'));
  assert.equal(manifest.platform, 'win32-' + arch);
  const expectedGit = path.join(gitRoot, 'cmd', 'git.exe');
  const daemonBinary = path.join(terminalRoot, 'terminal-daemon.exe');
  const nativeModule = path.join(terminalRoot, 'terminal-platform-node', 'index.mjs');
  for (const file of [expectedGit, daemonBinary, nativeModule]) {
    assert(fs.statSync(file).isFile(), 'Packaged executable missing: ' + file);
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-terminal-git-e2e-'));
  const slug = 'agent-teams-native-git-test-' + randomUUID().replace(/-/g, '');
  const env = managedEnvironment(process.env, gitRoot, arch, sandbox);
  for (const folder of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(folder, { recursive: true });
  const probe = path.join(sandbox, 'git-probe.cmd');
  fs.writeFileSync(
    probe,
    [
      '@echo off',
      'where git > "%~dp0git-where.txt" 2>&1',
      'git --version > "%~dp0git-version.txt" 2>&1',
      'git --exec-path > "%~dp0git-exec.txt" 2>&1',
      'echo completed > "%~dp0git-done.txt"',
      '',
    ].join('\r\n')
  );

  let child;
  let client;
  let stderr = '';
  try {
    const sdk = await import(pathToFileURL(nativeModule).href);
    assert.equal(typeof sdk.TerminalNodeClient?.fromRuntimeSlug, 'function');
    child = spawn(daemonBinary, ['--runtime-slug', slug, '--session-store', path.join(sandbox, 'session.sqlite')], {
      cwd: terminalRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    client = await waitForDaemon(sdk, slug, child, () => stderr);
    const cmdExe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const created = await bounded(client.createNativeSession({
      title: 'Managed Git native PTY smoke',
      launch: { program: cmdExe, args: ['/d', '/k'], cwd: sandbox },
    }), 30000, 'Native PTY session creation');
    const attached = await bounded(client.attachSession(created.session_id), 20000, 'Native PTY attach');
    const paneId = attached.focused_screen.pane_id;
    assert.equal(typeof paneId, 'string');

    // Input is sent via the actual Rust native terminal protocol, not child_process cmd.
    await bounded(client.dispatchMuxCommand(created.session_id, {
      kind: 'send_input',
      pane_id: paneId,
      data: 'call git-probe.cmd\r',
    }), 15000, 'Native terminal Git command');

    const doneFile = path.join(sandbox, 'git-done.txt');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(doneFile) && Date.now() < deadline) await sleep(150);
    assert(fs.existsSync(doneFile), 'Native PTY did not finish Git probe: ' + stderr);

    const found = fs.readFileSync(path.join(sandbox, 'git-where.txt'), 'utf8').split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean);
    assert(found.length > 0, 'where git returned no executable');
    assert.equal(path.win32.normalize(found[0]).toLowerCase(),
      path.win32.normalize(expectedGit).toLowerCase(),
      'Native terminal picked system Git before bundled Git');
    assert.match(fs.readFileSync(path.join(sandbox, 'git-version.txt'), 'utf8'), /git version 2\.56\.0/i);
    const actualExecPath = fs.readFileSync(path.join(sandbox, 'git-exec.txt'), 'utf8').trim();
    assert.equal(path.win32.normalize(actualExecPath).toLowerCase(),
      path.win32.normalize(env.GIT_EXEC_PATH).toLowerCase(),
      'Native terminal did not preserve bundled GIT_EXEC_PATH');

    await client.dispatchMuxCommand(created.session_id, {
      kind: 'send_input', pane_id: paneId, data: 'exit\r',
    }).catch(() => undefined);
    console.log('[smokeManagedTerminalGit] PASS win32-' + arch + ': native PTY -> bundled git, version, exec-path');
  } finally {
    if (client) {
      await bounded(client.close().catch(() => undefined), 3000, 'Native terminal client close')
        .catch(() => undefined);
    }
    await stopOwnedDaemon(child);
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

if (require.main === module) {
  const [bundle, arch] = process.argv.slice(2);
  if (!bundle || !['x64', 'arm64'].includes(arch)) {
    console.error('Usage: smokeManagedTerminalGit.cjs <bundle> <x64|arm64>');
    process.exitCode = 1;
  } else {
    check(bundle, arch).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

module.exports = { managedEnvironment };
