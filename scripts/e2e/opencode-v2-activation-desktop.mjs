#!/usr/bin/env node
// Opt-in Linux Electron, public download, native catalog and owned model-Test smoke.
// Only the model HTTP response is a loopback fixture; no provider keys or external inference.
// Requires the matching orchestrator source launcher in CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { connectCdp } from './announcements/cdp.mjs';

assert.equal(
  process.platform,
  'linux',
  'This desktop lifecycle smoke requires the qualified Linux runner and POSIX process ownership'
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
assert(runtime && path.isAbsolute(runtime), 'Set the exact orchestrator source launcher path');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-teams-v2-desktop-')));
const evidence = path.resolve(process.env.OPENCODE_V2_E2E_EVIDENCE ?? path.join(root, 'evidence'));
await mkdir(evidence, { recursive: true });
const lock = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8'));
const expectedVersion = lock.opencodeV2.qualified[`${process.platform}-${process.arch}`]?.at(-1);
assert(expectedVersion, 'This platform must have an explicitly qualified V2 version');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
async function sourceEvidence(cwd) {
  const changed = git(cwd, 'diff', 'HEAD', '--name-only', '-z');
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z');
  const files = await Promise.all(
    [...new Set((changed + untracked).split('\0').filter(Boolean))].sort().map(async (file) => {
      try {
        return {
          path: file,
          sha256: createHash('sha256')
            .update(await readFile(path.join(cwd, file)))
            .digest('hex'),
        };
      } catch (error) {
        if (error.code === 'ENOENT') return { path: file, deleted: true };
        throw error;
      }
    })
  );
  const commit = git(cwd, 'rev-parse', 'HEAD').trim();
  return {
    commit,
    files,
    sha256: createHash('sha256').update(JSON.stringify({ commit, files })).digest('hex'),
  };
}
const runtimeRepo = git(path.dirname(runtime), 'rev-parse', '--show-toplevel').trim();
const result = {
  ok: false,
  boundary:
    'Real desktop IPC, installer, public artifacts, native SDK, model proof and retirement; loopback model HTTP response, no external inference',
  appSource: await sourceEvidence(repo),
  runtimeSource: await sourceEvidence(runtimeRepo),
  runtimeLauncher: await realpath(runtime),
  runtimePin: lock.version,
  expectedVersion,
  root,
  phases: [],
};
const save = (name, value) =>
  writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
let app,
  cdp,
  modelServer,
  appLog = '',
  phase = 'prepare';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modelRequests = [],
  fixtureFailures = [];
async function startModelFixture() {
  modelServer = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(modelRequests.length, 0, 'Exactly one explicit selected-model request');
      assert.equal(request.headers.authorization, 'Bearer public');
      assert.equal(request.headers['x-opencode-client'], 'agent-teams-execution');
      const parts = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        assert(bytes <= 1024 * 1024, 'Bounded fixture input');
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      assert.equal(body.model, 'TEST-free-upstream');
      assert.equal(body.stream, true);
      const tokens = JSON.stringify(body.messages).match(/STRICT_LAUNCH_[0-9a-f-]{36}/g) ?? [];
      assert(tokens.length > 0);
      modelRequests.push({
        model: body.model,
        stream: true,
        publicSentinel: true,
        client: request.headers['x-opencode-client'],
      });
      const chunk = (delta, finish_reason = null) => ({
        id: 'chatcmpl_TESTfree',
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const rows = [
        chunk({ role: 'assistant' }),
        chunk({ content: tokens.at(-1) }),
        chunk({}, 'stop'),
        {
          id: 'chatcmpl_TESTfree',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n'
      );
    } catch (error) {
      fixtureFailures.push(error.message);
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('TEST fixture mismatch');
    }
  });
  await new Promise((resolve, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${modelServer.address().port}/v1`;
}
async function wait(label, check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    assert(
      !app || (app.exitCode === null && app.signalCode === null),
      `Desktop exited during ${label}`
    );
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`${label} timed out${lastError ? ': ' + lastError.message : ''}`);
}
async function milestone(name, value) {
  phase = name;
  result.phases.push({ name, at: new Date().toISOString(), ...value });
  process.stdout.write(JSON.stringify({ phase: name, ...value }) + '\n');
  await save('result.json', result);
}
async function requireDevMcpPort() {
  const port = 9222;
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function snapshot(name) {
  await save(
    name + '.json',
    await cdp.inspect(`({
    runtime: window.__agentTeamsDevStore.getState().openCodeRuntimeStatus,
    loading: window.__agentTeamsDevStore.getState().openCodeRuntimeStatusLoading,
    error: window.__agentTeamsDevStore.getState().openCodeRuntimeError,
    progress: window.__opencodeV2SmokeProgress,
    timeOrigin: performance.timeOrigin,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    text: document.body.innerText.slice(0, 14000)
  })`)
  );
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function clickControl(selector) {
  await cdp.inspect(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' }); true`
  );
  await cdp.click(selector);
}
async function clickVisibleButtonByText(label) {
  const point = await cdp.inspect(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter(button =>
      button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled &&
      button.getClientRects().length > 0);
    if (buttons.length !== 1) throw new Error('Expected one visible enabled installation button');
    const button = buttons[0];
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (!button.contains(document.elementFromPoint(x, y)))
      throw new Error('Installation button is obscured');
    return { x, y };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1,
  });
}
try {
  const dirs = {
    HOME: 'home',
    USERPROFILE: 'home',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: 'user-data',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: 'claude',
    CLAUDE_CONFIG_DIR: 'claude-config',
    XDG_CONFIG_HOME: 'xdg-config',
    XDG_DATA_HOME: 'xdg-data',
    XDG_CACHE_HOME: 'xdg-cache',
    XDG_STATE_HOME: 'xdg-state',
    XDG_RUNTIME_DIR: 'xdg-runtime',
    TMPDIR: 'tmp',
    CLAUDE_MULTIMODEL_DATA_HOME: 'multimodel',
  };
  const env = {};
  // Keep tool/runtime paths and network transport settings; never inherit provider credentials.
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'CI',
    'PNPM_HOME',
    'DISPLAY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Preserve the installed dependency graph's tool store while isolating all app profiles.
  // Otherwise pnpm's pre-run check tries to reinstall node_modules under the disposable HOME.
  const modules = parseYaml(await readFile(path.join(repo, 'node_modules/.modules.yaml'), 'utf8'));
  assert(typeof modules?.storeDir === 'string' && path.isAbsolute(modules.storeDir));
  env.pnpm_config_store_dir = modules.storeDir;
  env.pnpm_config_verify_deps_before_run = 'error';
  result.pnpmStoreDirectory = modules.storeDir;
  for (const [key, directory] of Object.entries(dirs)) {
    env[key] = path.join(root, directory);
    await mkdir(env[key], { recursive: true });
  }
  const project = path.join(root, 'sandbox-project');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# Disposable OpenCode V2 activation smoke\n');
  execFileSync('git', ['init', '--quiet', project], { env });
  const modelBaseUrl = await startModelFixture();
  await writeFile(
    path.join(project, 'opencode.json'),
    JSON.stringify({
      model: 'opencode/big-pickle',
      provider: {
        opencode: {
          options: { baseURL: modelBaseUrl },
          models: {
            'big-pickle': {
              id: 'TEST-free-upstream',
              name: 'TEST native free admission',
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              tool_call: true,
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 8192, output: 512 },
            },
          },
        },
      },
    }),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'agent-teams-config.json'),
    JSON.stringify({
      general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'dashboard' },
    })
  );
  const projectKey = project.replace(/[/\\]/g, '-');
  const sessionDir = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'projects', projectKey);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'sandbox-session.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: project,
      sessionId: 'v2-activation-sandbox',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Disposable activation check' },
      isMeta: false,
    }) + '\n'
  );
  Object.assign(env, {
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
    // Terminal launch is outside this smoke; an explicit inert fixture avoids unrelated downloads.
    CLAUDE_TERMINAL_DAEMON_BINARY: process.execPath,
    NODE_BINARY: process.execPath,
    SHELL: '/bin/sh',
    NO_SANDBOX: '1',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    ELECTRON_CLI_ARGS: JSON.stringify([
      '--ozone-platform=headless',
      '--disable-gpu',
      '--disable-background-networking',
    ]),
  });
  if (process.platform === 'linux') {
    // electron-vite's CLI resets ELECTRON_CLI_ARGS even without passthrough args.
    // Its supported executable override still launches the exact installed Electron.
    const electron = createRequire(import.meta.url)('electron');
    const launcher = path.join(root, 'headless-electron');
    const quoted = `'${electron.replaceAll("'", "'\\''")}'`;
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quoted} --ozone-platform=headless --disable-gpu --disable-background-networking "$@"\n`
    );
    await chmod(launcher, 0o700);
    env.ELECTRON_EXEC_PATH = launcher;
    result.electronExecutable = await realpath(electron);
  }
  const port = await requireDevMcpPort();
  app = spawn('pnpm', ['dev:mcp'], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on('data', (chunk) => {
      appLog += chunk.toString();
    });
  phase = 'Electron renderer startup';
  const target = await wait(
    phase,
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find(
        (item) => item.type === 'page' && /^http:\/\/localhost:\d+/.test(item.url)
      );
    },
    180_000
  );
  assert(
    appLog.includes(`--remote-debugging-port=${port}`) || appLog.includes(`127.0.0.1:${port}`),
    'Dev process must announce this exact owned CDP endpoint'
  );
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  // Ozone's headless display can start at 1x1 despite BrowserWindow's bounds.
  // Use the same explicit desktop viewport as the other real Electron smokes.
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait('desktop viewport', () => cdp.inspect('innerWidth === 1440 && innerHeight === 1000'));
  await wait(
    'desktop API and dev store',
    () => cdp.inspect('!!(window.electronAPI && window.__agentTeamsDevStore)'),
    90_000
  );
  const origin = await cdp.inspect('performance.timeOrigin');
  await cdp.inspect('window.__agentTeamsDevStore.getState().fetchProjects(); true');
  const projectId = await wait('disposable project discovery', () =>
    cdp.inspect(`
    window.__agentTeamsDevStore.getState().projects.find(project => project.path === ${JSON.stringify(project)})?.id`)
  );
  await cdp.inspect(`window.__opencodeV2SmokeProgress = [];
    window.electronAPI.openCodeRuntime.onProgress((_event, status) => window.__opencodeV2SmokeProgress.push(status));
    window.__agentTeamsDevStore.getState().selectProject(${JSON.stringify(projectId)});
    window.__agentTeamsDevStore.getState().openDashboard();
    window.__agentTeamsDevStore.getState().fetchOpenCodeRuntimeStatus(); true`);
  const initial = await wait('missing native runtime', () =>
    cdp.inspect(`(() => {
    const state = window.__agentTeamsDevStore.getState();
    return !state.openCodeRuntimeStatusLoading && state.openCodeRuntimeStatus;
  })()`)
  );
  assert.equal(initial.installed, false, 'This smoke must start with no selected native runtime');
  assert.equal(initial.compatibleV2Version, expectedVersion);
  await wait('visible V2 install action', () =>
    cdp.inspect(`(() => {
      document.querySelector('[role="button"][aria-expanded="false"][aria-label="Expand provider details"]')?.click();
      return [...document.querySelectorAll('button')].some(button =>
        button.textContent.trim() === ${JSON.stringify(`Install V2 ${expectedVersion}`)} &&
        !button.disabled && button.getClientRects().length > 0);
    })()`)
  );
  await snapshot('before-install');
  await milestone('missing V2 detected', { source: initial.source, expectedVersion });

  // Exercise the visible button's generation binding and the production store/IPC path.
  phase = 'V2 installation through the visible button';
  await clickVisibleButtonByText(`Install V2 ${expectedVersion}`);
  const started = await wait('production installation progress', () =>
    cdp.inspect(`(() => {
      const state = window.__agentTeamsDevStore.getState();
      const progress = window.__opencodeV2SmokeProgress;
      return progress.length || state.openCodeRuntimeError || state.openCodeRuntimeStatus?.state === 'failed'
        ? { progress, error: state.openCodeRuntimeError, state: state.openCodeRuntimeStatus?.state }
        : null;
    })()`)
  );
  await save('installation-started.json', started);
  assert.equal(started.error, null, JSON.stringify(started));
  assert.notEqual(started.state, 'failed', JSON.stringify(started));
  const activated = await wait(
    'V2 download and atomic activation',
    () =>
      cdp.inspect(`(() => {
      const state = window.__agentTeamsDevStore.getState();
      const runtime = state.openCodeRuntimeStatus;
      if (state.openCodeRuntimeStatusLoading ||
          !(runtime?.state === 'ready' || runtime?.state === 'failed' || state.openCodeRuntimeError))
        return null;
      return {
        runtime, error: state.openCodeRuntimeError, loading: state.openCodeRuntimeStatusLoading,
        progress: window.__opencodeV2SmokeProgress, timeOrigin: performance.timeOrigin,
      };
    })()`),
    480_000
  );
  await save('installation-completed.json', activated);
  await snapshot('after-install');
  assert.equal(activated.runtime.state, 'ready', JSON.stringify(activated));
  assert.equal(activated.runtime.version, expectedVersion);
  assert.equal(activated.runtime.v2Support, 'ready');
  assert.equal(activated.loading, false);
  assert.equal(activated.error, null);
  const visibleReady = await wait('visible V2 support-ready action', () =>
    cdp.inspect(`(() => {
      const repair = [...document.querySelectorAll('button')].find(button =>
        button.textContent.trim() === 'Repair V2 support' && !button.disabled &&
        button.getClientRects().length > 0);
      return repair ? { label: repair.textContent.trim(),
        installActionPresent: [...document.querySelectorAll('button')].some(button =>
          button.textContent.trim() === ${JSON.stringify(`Install V2 ${expectedVersion}`)} &&
          button.getClientRects().length > 0) } : null;
    })()`)
  );
  assert.equal(visibleReady.installActionPresent, false);
  assert.equal(
    activated.timeOrigin,
    origin,
    'The renderer must not restart or reload to activate V2'
  );
  for (const phaseName of ['downloading', 'installing', 'ready'])
    assert(
      activated.progress.some((status) => status.state === phaseName),
      `Missing ${phaseName} progress`
    );
  await milestone('downloaded V2 activated without restart', {
    nativeVersion: activated.runtime.version,
    support: activated.runtime.v2Support,
    visibleReady,
    progressStates: [...new Set(activated.progress.map((value) => value.state))],
  });

  phase = 'automatic project-scoped catalog after installation';
  const automaticScope = await wait(
    phase,
    () =>
      cdp.inspect(`(() => {
      const provider = window.__agentTeamsDevStore.getState().cliProviderStatusByScope[${JSON.stringify(`opencode\0${project}`)}];
      return provider && provider.statusCheckOutcome !== 'pending' && provider.modelCatalog?.models?.length > 0
        ? provider : null;
    })()`),
    120_000
  );
  await save('automatic-project-status-after-install.json', automaticScope);
  assert.equal(modelRequests.length, 0, 'The automatic project status read must remain passive');
  await milestone('installed V2 refreshed project catalog automatically', {
    outcome: automaticScope.statusCheckOutcome,
    modelCount: automaticScope.modelCatalog.models.length,
  });

  phase = 'native provider directory via desktop IPC';
  await cdp.inspect(`window.__opencodeV2SmokeDirectory = null;
    window.electronAPI.runtimeProviderManagement.loadProviderDirectory({ runtimeId: 'opencode', projectPath: ${JSON.stringify(project)}, limit: 300, refresh: true })
      .then(value => { window.__opencodeV2SmokeDirectory = { value }; })
      .catch(error => { window.__opencodeV2SmokeDirectory = { error: String(error) }; }); true`);
  const directory = await wait(
    phase,
    () => cdp.inspect('window.__opencodeV2SmokeDirectory'),
    120_000
  );
  await save('directory.json', directory);
  assert(!directory.error, directory.error);
  assert(!directory.value.error, JSON.stringify(directory.value.error));
  const entries = directory.value.directory?.entries;
  assert(Array.isArray(entries), 'Desktop directory response must contain entries');
  assert(entries.length > 50, 'The initial V2 directory must include discoverable integrations');
  const freeProvider = entries.find((entry) => entry.providerId === 'opencode');
  assert.equal(freeProvider?.setupKind, 'available-readonly');
  assert(
    freeProvider?.actions.some((action) => action.id === 'use' && action.enabled),
    'Anonymous OpenCode models must be browsable'
  );
  await milestone('native integrations and free provider available', {
    directoryEntries: entries.length,
  });

  phase = 'free models via desktop IPC';
  await cdp.inspect(`window.__opencodeV2SmokeModels = null;
    window.electronAPI.runtimeProviderManagement.loadModels({ runtimeId: 'opencode', providerId: 'opencode', projectPath: ${JSON.stringify(project)}, limit: 100, refresh: true })
      .then(value => { window.__opencodeV2SmokeModels = { value }; })
      .catch(error => { window.__opencodeV2SmokeModels = { error: String(error) }; }); true`);
  const models = await wait(phase, () => cdp.inspect('window.__opencodeV2SmokeModels'), 120_000);
  await save('models.json', models);
  assert(!models.error, models.error);
  assert(!models.value.error, JSON.stringify(models.value.error));
  const items = models.value.models?.models;
  assert(Array.isArray(items), 'Desktop model response must contain models');
  const free = items.filter((model) => model.free && model.accessKind === 'builtin_free');
  assert(free.length > 0, 'Native free models must retain anonymous access metadata');
  assert(
    free.every((model) => model.proofState !== 'verified'),
    'Catalog enumeration must not manufacture execution proof'
  );
  assert.equal(await cdp.inspect('performance.timeOrigin'), origin);
  await snapshot('native-free-models');
  await milestone('free models readable without credentials', {
    freeModels: free.map((model) => model.modelId ?? model.id),
  });
  assert.equal(modelRequests.length, 0, 'Install and catalog reads must not run a model');
  phase = 'anonymous model Test through the visible desktop UI';
  await wait('enabled OpenCode Manage button', () =>
    cdp.inspect(`(() => {
    const button = document.querySelector('[data-testid="runtime-manage-opencode"]');
    return button && !button.disabled && button.getClientRects().length > 0;
  })()`)
  );
  await clickControl('[data-testid="runtime-manage-opencode"]');
  await wait(
    'anonymous directory row',
    () =>
      cdp.inspect(`
    document.querySelector('[data-testid="runtime-provider-directory-row-opencode"]')?.getAttribute('role') === 'button'`),
    120_000
  );
  await clickControl('[data-testid="runtime-provider-directory-row-opencode"]');
  const testSelector = '[data-testid="runtime-provider-model-test-opencode/big-pickle"]';
  await wait(
    'enabled anonymous model Test',
    () =>
      cdp.inspect(`(() => {
    const button = document.querySelector(${JSON.stringify(testSelector)});
    return button && !button.disabled && button.getClientRects().length > 0;
  })()`),
    120_000
  );
  await clickControl(testSelector);
  const verifiedText = await wait(
    'real selected-model proof and physical retirement',
    () =>
      cdp.inspect(`(() => {
    const text = document.querySelector('[data-testid="runtime-provider-model-result-opencode/big-pickle"]')?.textContent ?? '';
    return text.includes('execution and physical retirement verified') ? text : null;
  })()`),
    240_000
  );
  const refreshed = await wait(
    'project-scoped provider status refreshed after Test',
    () =>
      cdp.inspect(`(() => {
    const provider = window.__agentTeamsDevStore.getState().cliProviderStatusByScope[${JSON.stringify(`opencode\0${project}`)}];
    const model = provider?.modelCatalog?.models.find(row => row.launchModel === 'opencode/big-pickle');
    return model?.metadata?.opencode?.proofState === 'verified' ? { provider, model } : null;
  })()`),
    120_000
  );
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(fixtureFailures, []);
  assert.equal(await cdp.inspect('performance.timeOrigin'), origin);
  await save('verified-status.json', { verifiedText, refreshed, modelRequests });
  await snapshot('verified-model-in-same-window');
  await cdp.key('Escape');
  await wait('visible dashboard free-model badge', () =>
    cdp.inspect(`
    [...document.querySelectorAll('span')].some(element => element.textContent.trim() === 'Free models' && element.getClientRects().length > 0)`)
  );
  await snapshot('dashboard-after-model-test');
  await milestone('anonymous Test refreshed dashboard without restart', {
    model: 'opencode/big-pickle',
    modelRequests: modelRequests.length,
  });
  result.ok = true;
} catch (error) {
  result.error = { phase, message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (cdp) await snapshot('failure').catch(() => undefined);
} finally {
  cdp?.close();
  if (app?.pid) {
    // Kill only this smoke's detached process group, never shared OpenCode hosts or user teams.
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {
      // The owned process group may already have retired.
    }
    if (app.exitCode === null && app.signalCode === null)
      await Promise.race([new Promise((resolve) => app.once('exit', resolve)), delay(5_000)]);
    // A failed pnpm wrapper can exit before its Electron descendants retire.
    try {
      process.kill(-app.pid, 'SIGKILL');
    } catch {
      // The owned process group may already have retired.
    }
  }
  await writeFile(path.join(evidence, 'desktop.log'), appLog);
  if (modelServer) {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
  }
  result.modelRequests = modelRequests;
  result.fixtureFailures = fixtureFailures;
  result.finalAppSource = await sourceEvidence(repo);
  result.finalRuntimeSource = await sourceEvidence(runtimeRepo);
  result.sourceChangedDuringRun =
    result.finalAppSource.sha256 !== result.appSource.sha256 ||
    result.finalRuntimeSource.sha256 !== result.runtimeSource.sha256;
  if (result.sourceChangedDuringRun && result.ok) {
    result.ok = false;
    result.error = { phase: 'source integrity', message: 'Source changed during the E2E run' };
    process.exitCode = 1;
  }
  await save('result.json', result);
  process.stdout.write(JSON.stringify({ ok: result.ok, evidence, error: result.error }) + '\n');
}
