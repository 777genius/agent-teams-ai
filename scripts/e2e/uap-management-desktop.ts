#!/usr/bin/env -S pnpm exec tsx
// Real Electron + bundled UAP + native Claude/Codex/OpenCode. All writable state is disposable.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Existing raw CDP transport; no browser-mode substitute or native folder picker.
// @ts-expect-error Existing JavaScript harness has no declaration file.
import { CdpClient } from './comment-notification/cdp.mjs';
import { startGroupChatModelServer } from './group-chat-model-server';
import { startActiveRunProof } from './uap-management-active-run';
import { captureFreshProfileCliControl } from './uap-management-failure-cli';
import { captureOwnedUapProcessMetadata } from './uap-management-failure-process';
import { postWithReboundHost } from './uap-management-http';
import { openCodeMcpServer } from './uap-management-native';
import { createPluginMatrixFixture, matrixArchivePath } from './uap-management-plugin-fixture';
import { exercisePluginMatrix, selectInstallationTargets } from './uap-management-plugin-matrix';
import { createNativeToolProof, toolArchivePath, toolPluginName } from './uap-management-tool-use';
import {
  actionablePoint,
  applyAndWaitForOperation,
  callUi,
  dispatchKey,
  inspectElement,
  screenshotWhenSettled,
  selectTab,
  type DesktopCdp,
  type UiLocator,
} from './uap-management-ui';

import type {
  ExtensionContext,
  ManagementCatalog,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  LocalSkillStatus,
} from '../../src/features/extension-management/contracts';

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logs: string[] = [];
const errors: unknown[] = [];
const evidence: Record<string, unknown> = {};
let app: ChildProcess | undefined;
let cdp: DesktopCdp | undefined;
let publisher: https.Server | undefined;
let toolProof: Awaited<ReturnType<typeof createNativeToolProof>> | undefined;
let pluginMatrix: Awaited<ReturnType<typeof createPluginMatrixFixture>> | undefined;
let model: Awaited<ReturnType<typeof startGroupChatModelServer>> | undefined;
let activeRun: Awaited<ReturnType<typeof startActiveRunProof>> | undefined;
let version = 1;
let previousHttpAuthorization: string | undefined;
const skillName = 'uap-ui-demo';
const imageBytes = Buffer.from([0, 255, 128, 0, 22, 44]);

async function save(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'uap-management-desktop-')));
  const home = path.join(root, 'home');
  const shots = path.join(root, 'screenshots');
  const native = process.env.UAP_E2E_OPENCODE;
  const claude = process.env.UAP_E2E_CLAUDE;
  const codex = process.env.UAP_E2E_CODEX;
  const runtime = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  assert(
    native && claude && codex && runtime,
    'Set UAP_E2E_OPENCODE, UAP_E2E_CLAUDE, UAP_E2E_CODEX and the real CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
  );
  await Promise.all([native, claude, codex, runtime].map((file) => access(file, constants.X_OK)));
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const trackedDirty = Boolean(
    (
      await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo })
    ).stdout.trim()
  );
  if (process.env.UAP_E2E_REQUIRE_CLEAN === '1')
    assert(!trackedDirty, 'Final qualification requires a committed application checkout.');
  const sdk = JSON.parse(
    await readFile(path.join(repo, 'vendor/uap/sdk/provenance.json'), 'utf8')
  ) as { sourceCommit: string; engineVersion: string; file: string; sha256: string };
  const engine = JSON.parse(
    await readFile(path.join(repo, 'resources/uap/runtime.json'), 'utf8')
  ) as { sourceSha: string; engineVersion: string; executable: string; sha256: string };
  assert.equal(
    engine.sourceSha,
    sdk.sourceCommit,
    'SDK and native engine must have the same reviewed source pin'
  );
  assert.equal(engine.engineVersion, sdk.engineVersion);
  const engineExecutable = await realpath(path.join(repo, 'resources/uap', engine.executable));
  for (const [file, digest] of [
    [path.join(repo, 'vendor/uap/sdk', sdk.file), sdk.sha256],
    [engineExecutable, engine.sha256],
  ]) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
      digest
    );
  }
  evidence.artifacts = { appCommit: commit, trackedDirty, sdk, engine };
  const env: NodeJS.ProcessEnv = {
    PATH: [
      path.dirname(native),
      path.dirname(claude),
      path.dirname(codex),
      process.env.PATH ?? '',
    ].join(path.delimiter),
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    SHELL: '/bin/sh',
    HOME: home,
    USERPROFILE: home,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: path.join(home, '.claude'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
    AGENTPLUGINS_HOME: path.join(root, 'uap-state'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
    CLAUDE_CLI_PATH: claude,
    CODEX_CLI_PATH: codex,
    NODE_BINARY: await realpath(process.execPath),
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    // Dependencies were frozen-verified before isolation; nested dev launchers inherit this.
    pnpm_config_verify_deps_before_run: 'false',
    NODE_OPTIONS: '--max-old-space-size=2048',
    GOMAXPROCS: '2',
    GOMEMLIMIT: '256MiB',
    NO_PROXY: '127.0.0.1,localhost,::1',
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const directories = [
    root,
    shots,
    home,
    path.join(home, '.claude', 'projects'),
    ...Object.entries(env)
      .filter(([key]) => /(?:_ROOT|_DIR|_HOME|USERPROFILE)$/.test(key))
      .map(([, value]) => value!)
      .filter(Boolean),
  ];
  await Promise.all(directories.map((dir) => mkdir(dir, { recursive: true })));
  const claudeVersion = (await run(claude, ['--version'], { env, timeout: 30_000 })).stdout.trim();
  assert.equal(claudeVersion, '2.1.263 (Claude Code)');
  evidence.claudeNative = {
    version: claudeVersion,
    sha256: createHash('sha256')
      .update(await readFile(claude))
      .digest('hex'),
  };
  const codexVersion = (await run(codex, ['--version'], { env, timeout: 30_000 })).stdout.trim();
  assert.equal(codexVersion, 'codex-cli 0.153.4');
  evidence.codexNative = {
    version: codexVersion,
    sha256: createHash('sha256')
      .update(await readFile(codex))
      .digest('hex'),
  };
  model = await startGroupChatModelServer(path.join(root, 'active-profile-model.ndjson'));
  env.ANTHROPIC_BASE_URL = model.baseUrl;
  env.ANTHROPIC_API_KEY = 'synthetic-owned-key';
  env.ANTHROPIC_AUTH_TOKEN = '';
  await save(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), {
    env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key' },
  });
  const httpPort = await freePort();
  await save(path.join(home, '.claude', 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
    httpServer: { enabled: true, port: httpPort },
  });
  const cert = path.join(root, 'publisher.pem');
  const key = path.join(root, 'publisher.key');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  env.SSL_CERT_FILE = cert;
  const requests: string[] = [];
  publisher = https.createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      const url = request.url ?? '';
      requests.push(url);
      const prefix = '/publisher/.well-known/agent-skills/';
      response.setHeader('Content-Type', 'application/octet-stream');
      if (url === matrixArchivePath && pluginMatrix) {
        response.end(pluginMatrix.archive);
      } else if (url === toolArchivePath && toolProof) {
        response.end(toolProof.archive);
      } else if (url === `${prefix}index.json`) {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            skills: [
              {
                name: skillName,
                description: 'Inert desktop E2E skill',
                files: ['SKILL.md', 'references/guide.md', 'assets/sample.bin'],
              },
            ],
          })
        );
      } else if (url === `${prefix}${skillName}/SKILL.md`) {
        response.end(
          `---\nname: ${skillName}\ndescription: Inert desktop E2E skill\n---\nDesktop fixture revision ${version}.\n`
        );
      } else if (url === `${prefix}${skillName}/references/guide.md`) {
        response.end(`Retained guide revision ${version}.\n`);
      } else if (url === `${prefix}${skillName}/assets/sample.bin`) {
        response.end(imageBytes);
      } else {
        response.writeHead(404);
        response.end('Fixture path not found');
      }
    }
  );
  publisher.listen(0, '127.0.0.1');
  await once(publisher, 'listening');
  const address = publisher.address();
  assert(address && typeof address === 'object');
  return {
    root,
    home,
    shots,
    env,
    native,
    claude,
    codex,
    engineExecutable,
    httpPort,
    source: `https://127.0.0.1:${address.port}/publisher`,
    requests,
  };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  logs.length = 0;
  app = spawn('pnpm', ['dev:mcp', ...(process.getuid?.() === 0 ? ['--noSandbox'] : [])], {
    cwd: repo,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: f.env,
  });
  const liveLog = createWriteStream(path.join(f.root, 'desktop-live.log'), { flags: 'a' });
  app.once('exit', () => liveLog.end());
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      liveLog.write(chunk);
      logs.push(chunk.toString());
      if (logs.length > 2000) logs.shift();
    });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Owned dev:mcp exited: ${app.exitCode}`);
    const port = logs
      .join('')
      .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//)?.[1];
    if (port) {
      try {
        const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
          response.json()
        )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        const page = targets.find(
          (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
        );
        if (page) {
          cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
          cdp!.on('Runtime.exceptionThrown', (error) => errors.push(error));
          await cdp!.send('Runtime.enable');
          await cdp!.send('Page.enable');
          await wait(() => callUi(cdp!, 'ready'), 'desktop renderer');
          await save(path.join(f.root, 'connection.json'), {
            root: f.root,
            shots: f.shots,
            source: f.source,
            httpPort: f.httpPort,
            webSocketDebuggerUrl: page.webSocketDebuggerUrl,
          });
          return;
        }
      } catch (error) {
        if (Date.now() + 1000 >= deadline) throw error;
      }
    }
    await pause(100);
  }
  throw new Error('Owned Electron renderer did not appear.');
}

async function stop(root: string) {
  await cdp?.close().catch(() => {});
  cdp = undefined;
  if (app?.pid && app.exitCode === null) {
    const child = app;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* already exited */
    }
    await Promise.race([once(child, 'exit'), pause(10_000)]);
    if (child.exitCode === null) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }
  app = undefined;
  // The existing dev MCP server is detached from Electron's process group.
  // Match this fixture's private user-data path before stopping that helper.
  if (process.platform !== 'win32') {
    const marker = `${path.join(root, 'user-data', 'mcp-server')}${path.sep}`;
    const owned = (await run('ps', ['-axo', 'pid=,args='])).stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match && match[2].includes(marker) && match[2].includes('--transport httpStream')
        ? [Number(match[1])]
        : [];
    });
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    evidence.cleanedFixtureMcpChildren = [
      ...((evidence.cleanedFixtureMcpChildren as number[] | undefined) ?? []),
      ...owned,
    ];
  }
}

async function wait<T>(
  observe: () => Promise<T>,
  label: string,
  timeoutMs = 60_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await observe();
      if (value) return value;
    } catch (error) {
      if (
        !/execution context was destroyed|cannot find .*execution context|cannot find context/i.test(
          String(error)
        )
      )
        throw error;
    }
    await pause(100);
  }
  const alerts = await callUi(cdp!, 'alerts');
  throw new Error(`Timed out waiting for ${label}; alerts: ${JSON.stringify(alerts)}`);
}

const button = (name: string, within?: UiLocator): UiLocator => ({
  selector: 'button',
  name,
  within,
});
const panel: UiLocator = { selector: '[data-testid=uap-skill]' };
const installedRow: UiLocator = { selector: '[data-testid=uap-installed-entry]', within: panel };
const inspect = (locator: UiLocator) => inspectElement(cdp!, locator);
const present = (locator: UiLocator) => () => inspect(locator);
const enabled = (locator: UiLocator) => async () => {
  const element = await inspect(locator);
  return element && !element.disabled;
};
async function click(locator: UiLocator, timeoutMs = 60_000) {
  // Use the successful observation itself; a second readiness evaluation can
  // transiently fail during a dialog transition after the first has succeeded.
  const point = await wait(
    () => actionablePoint(cdp!, locator),
    `enabled visible click target ${JSON.stringify(locator)}`,
    timeoutMs
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp!.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function screenshot(file: string) {
  await screenshotWhenSettled(cdp!, wait, file);
}
async function key(value: string, code = value, modifiers = 0) {
  await dispatchKey(cdp!, value, code, modifiers);
}
async function fill(selector: string, text: string) {
  const locator = { selector };
  await click(locator);
  await key('a', 'KeyA', process.platform === 'darwin' ? 4 : 2);
  await cdp!.send('Input.insertText', { text });
  assert.equal((await inspect(locator))?.value, text);
}
async function selectAgent(root: UiLocator, label: string) {
  const trigger = button('Agent runtime', root);
  const selected = async () => (await inspect(trigger))?.text === label;
  const opened = async () => (await inspect(trigger))?.expanded === 'true';
  const option: UiLocator = { selector: '[role=option]', controlledBy: trigger, name: label };
  const deadline = Date.now() + 60_000;
  const remaining = () => Math.max(0, deadline - Date.now());
  for (let attempt = 1; attempt <= 3 && remaining() > 0; attempt++) {
    if (await selected()) return;
    if (!(await opened())) {
      await click(trigger, remaining());
      const openingLabel = `${label} agent menu opening`;
      try {
        await wait(opened, openingLabel, Math.min(3000, remaining()));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith(`Timed out waiting for ${openingLabel};`)
        )
          continue;
        throw error;
      }
    }
    // Opening was observed. A disappearing menu or failed selection must fail,
    // rather than replaying input after a state transition has been acknowledged.
    await click(option, remaining());
    await wait(selected, `${label} agent selection`, remaining());
    return;
  }
  const observed = await inspect(trigger);
  throw new Error(
    `Agent menu did not open within three pointer attempts: ${JSON.stringify(observed)}`
  );
}
async function openSkills() {
  await click(button('More actions'));
  await click(button('Extensions'));
  await selectTab(cdp!, wait, 'Skills');
  await wait(enabled(button('Agent runtime', panel)), 'managed Skill context');
  await selectAgent(panel, 'OpenCode');
  await selectInstallationTargets(cdp!, wait, click, panel, ['opencode']);
  await wait(enabled(button('Install from source', panel)), 'native OpenCode capability', 90_000);
}
async function reviewAndApply(root = panel) {
  await wait(enabled(button('Apply changes')), 'confirmable Go plan', 90_000);
  await applyAndWaitForOperation(cdp!, wait, root, () => click(button('Apply changes')));
}

async function registryPlugin(f: Awaited<ReturnType<typeof fixture>>) {
  const pluginPanel: UiLocator = { selector: '[data-testid=uap-plugin]' };
  await selectTab(cdp!, wait, 'Plugins');
  await wait(enabled(button('Agent runtime', pluginPanel)), 'universal Plugins entry point');
  await selectAgent(pluginPanel, 'OpenCode');
  await selectInstallationTargets(cdp!, wait, click, pluginPanel, ['opencode']);
  const registry = await callUi<ManagementCatalog>(cdp!, 'catalog');
  assert.equal(registry.freshness, 'current', 'official signed catalog must be current');
  const expected = registry.items.find((entry) => entry.id === 'cloudflare-docs');
  assert(
    expected?.available && expected.targets.includes('opencode'),
    'reviewed official plugin must support this target'
  );
  assert.equal(
    expected.version,
    '0.4.13-uap.1',
    'review a changed registry fixture before changing this inert native-config proof'
  );
  const card: UiLocator = { selector: '[data-catalog-id="cloudflare-docs"]', within: pluginPanel };
  await wait(enabled(button('Install', card)), 'reviewed signed catalog entry', 90_000);
  await screenshot(path.join(f.shots, '11-registry-plugin.png'));
  await click({ selector: 'button', within: card });
  await wait(present({ selector: '[role=dialog]' }), 'registry plugin details');
  await key('Escape');
  await click(button('Install', card));
  await wait(present(button('Apply changes')), 'signed registry installation review');
  await screenshot(path.join(f.shots, '12-registry-install-review.png'));
  await reviewAndApply(pluginPanel);
  const entry = (await environment()).entries.find((item) => item.kind === 'plugin');
  assert(entry?.declared && entry.version === expected.version);
  const config = entry.bindings
    .flatMap((binding) => binding.managedPaths)
    .find((file) =>
      ['opencode.json', 'opencode.jsonc'].some(
        (name) => file === path.join(f.env.OPENCODE_CONFIG_DIR!, name)
      )
    );
  assert(config, 'Installed plugin must identify its actual owned native config');
  assert.deepEqual(await openCodeMcpServer(config, 'cloudflare-docs'), {
    type: 'remote',
    url: 'https://docs.mcp.cloudflare.com/mcp',
  });
  await screenshot(path.join(f.shots, '13-registry-installed.png'));
  await click(
    button('Remove', { selector: '[data-testid=uap-installed-entry]', within: pluginPanel })
  );
  await reviewAndApply(pluginPanel);
  assert(!(await environment()).entries.some((item) => item.alias === entry.alias));
  assert.equal(await openCodeMcpServer(config, 'cloudflare-docs'), undefined);
  evidence.registryPlugin = {
    product: expected.id,
    distributionId: expected.distributionId,
    version: expected.version,
    currentSignedCatalog: true,
    actualNativeConfiguration: true,
    removed: true,
  };
  await screenshot(path.join(f.shots, '14-registry-removed.png'));
}

async function nativeToolUse(f: Awaited<ReturnType<typeof fixture>>) {
  assert(toolProof);
  const pluginPanel: UiLocator = { selector: '[data-testid=uap-plugin]' };
  const source = `${new URL(f.source).origin}${toolArchivePath}#sha256=${toolProof.sha256}`;
  assert.equal(await openCodeMcpServer(toolProof.config, toolProof.serverName), undefined);
  await click(button('Install from source', pluginPanel));
  await fill('#uap-source-plugin', source);
  await fill('#uap-alias', toolPluginName);
  assert.equal(await inspect({ selector: '#uap-ref-plugin' }), null);
  await click(button('Review installation'));
  await wait(
    present(button('Apply changes')),
    'source plugin review with ordinary security assessment',
    120_000
  );
  const warningReason = 'configuration contains an insecure http:// endpoint';
  await wait(
    async () =>
      (
        await inspect({
          selector: 'p',
          within: { selector: '[role=dialog]' },
          textIncludes: ['SEC302', warningReason],
          visible: true,
        })
      )?.visible,
    'specific security warning reason before source installation'
  );
  evidence.sourceSecurityWarning = { code: 'SEC302', reason: warningReason };
  await screenshot(path.join(f.shots, '15-source-plugin-review.png'));
  await reviewAndApply(pluginPanel);
  const entry = (await environment()).entries.find((item) => item.alias === toolPluginName);
  assert(entry?.declared && entry.version === '1.0.0');
  assert(entry.bindings.some((binding) => binding.managedPaths.includes(toolProof!.config)));
  assert.deepEqual(await openCodeMcpServer(toolProof.config, toolProof.serverName), {
    type: 'remote',
    url: toolProof.mcpURL,
  });
  await toolProof.probe(false);
  await screenshot(path.join(f.shots, '16-native-tool-called.png'));
  const row: UiLocator = {
    selector: '[data-testid=uap-installed-entry]',
    within: pluginPanel,
    textIncludes: [toolPluginName],
  };
  await click(button('Remove', row));
  await reviewAndApply(pluginPanel);
  assert(!(await environment()).entries.some((item) => item.alias === toolPluginName));
  assert.equal(await openCodeMcpServer(toolProof.config, toolProof.serverName), undefined);
  await toolProof.probe(true);
  evidence.nativeToolSource = {
    source,
    sha256: toolProof.sha256,
    installedThroughUI: true,
    removedThroughUI: true,
  };
  await screenshot(path.join(f.shots, '17-native-tool-removed.png'));
}
async function environment(): Promise<ManagementEnvironment> {
  return callUi(cdp!, 'environment');
}

async function verifyHttp(f: Awaited<ReturnType<typeof fixture>>) {
  const origin = `http://127.0.0.1:${f.httpPort}`;
  const route = `${origin}/api/extension-management`;
  const accessUrl = await callUi(cdp!, 'browser-access');
  assert.equal(typeof accessUrl, 'string');
  const grant = new URL(accessUrl as string);
  assert.equal(grant.origin, origin);
  const token = new URLSearchParams(grant.hash.slice(1)).get('management-access');
  assert(token && /^[a-f0-9]{64}$/.test(token), 'Owned IPC must issue a sidecar capability');
  const authorization = `Bearer ${token}`;
  previousHttpAuthorization = authorization;
  const post = (method: string, input: unknown, extra: Record<string, string> = {}) =>
    fetch(`${route}/${method}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Authorization: authorization,
        ...extra,
      },
      body: JSON.stringify(input),
    });
  for (const missing of ['', 'Bearer invalid', `Bearer ${'0'.repeat(64)}`]) {
    const refused = await post(
      'capture',
      { client: 'opencode', scope: 'user' },
      { Authorization: missing }
    );
    assert.equal(refused.status, 401, 'Forged local headers must not grant management authority');
  }
  const viewer = await post('hostStatus', {}, { Authorization: '' });
  assert.equal(((await viewer.json()) as { available: boolean }).available, false);
  const status = await post('hostStatus', {});
  assert.equal(status.status, 200, await status.text());
  const capture = await post('capture', { client: 'opencode', scope: 'user' });
  assert.equal(capture.status, 200, await capture.clone().text());
  const context = (await capture.json()) as ExtensionContext;
  const observed = await post('environment', { contextId: context.contextId });
  assert.equal(observed.status, 200, await observed.clone().text());
  const result = (await observed.json()) as ManagementEnvironment;
  assert(result.entries.some((entry) => entry.kind === 'skill'));
  assert.equal((await post('hostStatus', {}, { Origin: 'https://attacker.invalid' })).status, 403);
  const rebound = await postWithReboundHost(origin);
  assert.equal(rebound.status, 403);
  assert.equal(rebound.allowedOrigin, undefined);
  evidence.http = {
    host: 'desktop sidecar',
    sameEnvironment: result.entries.map((entry) => entry.alias),
    rejectedOrigin: true,
    rejectedHost: true,
    ownedIpcCapability: true,
    rejectedMissingAndForgedCapability: true,
  };
  async function call<T>(method: string, input: unknown): Promise<T> {
    const response = await post(method, input);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  }
  async function apply(plan: ManagementPlan) {
    assert(plan.confirmable, JSON.stringify(plan.conflicts));
    const request = { contextId: context.contextId, planId: plan.planId, requestId: randomUUID() };
    let operation = await call<ManagementOperation>('apply', request);
    const repeated = await call<ManagementOperation>('apply', request);
    assert.equal(
      repeated.operationId,
      operation.operationId,
      'HTTP retry must observe the same accepted operation'
    );
    const deadline = Date.now() + 60_000;
    while (['queued', 'running'].includes(operation.state) && Date.now() < deadline) {
      await pause(100);
      operation = await call<ManagementOperation>('operation', {
        contextId: context.contextId,
        operationId: operation.operationId,
      });
    }
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  }
  const skillPath = path.join(f.home, '.claude', 'skills', 'http-parity');
  const localStatus = await call<LocalSkillStatus>('localSkillStatus', {
    contextId: context.contextId,
    skillPath,
  });
  assert.equal(localStatus.ownership, 'local');
  const content =
    '---\nname: http-parity\ndescription: Isolated HTTP management proof\n---\nExact HTTP bytes.\n';
  await apply(
    await call<ManagementPlan>('prepareLocalSkill', {
      contextId: context.contextId,
      change: {
        action: 'upsert',
        rootId: localStatus.rootId,
        skillName: localStatus.skillName,
        files: [
          {
            relativePath: 'SKILL.md',
            expectedSHA256: null,
            contentBase64: Buffer.from(content).toString('base64'),
          },
        ],
      },
    })
  );
  assert.equal(await readFile(path.join(skillPath, 'SKILL.md'), 'utf8'), content);
  await apply(
    await call<ManagementPlan>('prepareLocalSkill', {
      contextId: context.contextId,
      change: { action: 'delete', rootId: localStatus.rootId, skillName: localStatus.skillName },
    })
  );
  await assert.rejects(readFile(path.join(skillPath, 'SKILL.md')));
  evidence.httpMutation = { create: true, delete: true, idempotentApply: true, actualFiles: true };
}

async function localSkillLifecycle(f: Awaited<ReturnType<typeof fixture>>, copied: string) {
  const card: UiLocator = { selector: '.skills-grid button', textSelector: 'h3', name: skillName };
  await click(card);
  await wait(enabled(button('Edit Skill')), 'authoritative local ownership');
  await click(button('Edit Skill'));
  await fill('#skill-name', 'uap-ui-demo-local');
  await fill('#skill-description', 'Edited through the existing local Skill editor');
  await click(button('Review And Save'));
  await wait(present(button('Save Skill')), 'local exact-byte edit review');
  await screenshot(path.join(f.shots, '08-local-edit-review.png'));
  await click(button('Save Skill'));
  await wait(
    async () =>
      !(await inspect({ selector: '#skill-name' })) && !(await inspect(button('Save Skill'))),
    'local editor completion'
  );
  const edited = await readFile(path.join(copied, 'SKILL.md'), 'utf8');
  assert(edited.includes('Edited through the existing local Skill editor'));
  assert.deepEqual(await readFile(path.join(copied, 'assets/sample.bin')), imageBytes);
  // The detail remains open after saving. Closing with Escape exercises keyboard navigation.
  if (await inspect({ selector: '[role=dialog]' })) await key('Escape');
  await click({ selector: '.skills-grid button', textSelector: 'h3', name: 'uap-ui-demo-local' });
  await wait(enabled(button('Delete')), 'local deletion admission');
  await click(button('Delete'));
  await click(button('Delete Skill'));
  await wait(
    async () => !(await inspect({ selector: '[role=dialog], [role=alertdialog]' })),
    'local deletion completion'
  );
  await assert.rejects(readFile(path.join(copied, 'SKILL.md')));
  const backups = (await environment()).localSkillBackups ?? [];
  const skillBackups = backups.filter((backup) => backup.skillName === path.basename(copied));
  const beforeSavePoint = skillBackups.find((backup) => backup.originalAction === 'upsert');
  const selectedRestorePoint = skillBackups.find((backup) => backup.originalAction === 'delete');
  assert(
    skillBackups.length >= 2 && beforeSavePoint?.recordedAt && selectedRestorePoint?.recordedAt,
    'edit and delete must publish distinguishable durable restore points'
  );
  await stop(f.root);
  await start(f);
  const stale = await fetch(`http://127.0.0.1:${f.httpPort}/api/extension-management/capture`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${f.httpPort}`,
      'Content-Type': 'application/json',
      Authorization: previousHttpAuthorization ?? '',
    },
    body: JSON.stringify({ client: 'opencode', scope: 'user' }),
  });
  assert.equal(stale.status, 401, 'The previous sidecar capability must expire on restart');
  evidence.httpCapabilityRevokedOnRestart = true;
  await openSkills();
  const restore: UiLocator = { selector: '[data-testid=uap-restore-points]', within: panel };
  await click({ selector: 'summary', within: restore });
  const savedRow: UiLocator = {
    selector: '[data-testid=uap-restore-point]',
    within: restore,
    attributes: {
      'data-original-action': 'upsert',
      'data-restore-operation-id': beforeSavePoint.operationId,
    },
  };
  await wait(async () => {
    const row = await inspect(savedRow);
    return (
      row?.visible &&
      row.text.includes('Before save') &&
      row.dateTime === beforeSavePoint.recordedAt
    );
  }, 'durable before-save restore point remains visibly distinct');
  const row: UiLocator = {
    selector: '[data-testid=uap-restore-point]',
    within: restore,
    attributes: {
      'data-original-action': 'delete',
      'data-restore-operation-id': selectedRestorePoint.operationId,
    },
  };
  await wait(async () => {
    const current = await inspect(row);
    return (
      current?.visible &&
      current.text.includes('Before deletion') &&
      current.dateTime === selectedRestorePoint.recordedAt
    );
  }, 'durable before-deletion restore point');
  evidence.restorePoints = [beforeSavePoint, selectedRestorePoint];
  await screenshot(path.join(f.shots, '09-restore-points.png'));
  await click(button('Review restoration', row));
  await wait(present(button('Apply changes')), 'restart-visible local restoration review');
  const reviewed: UiLocator = {
    selector: '[data-testid=uap-selected-restore-point]',
    attributes: { 'data-restore-operation-id': selectedRestorePoint.operationId },
  };
  await wait(async () => {
    const current = await inspect(reviewed);
    return (
      current?.text.includes('Before deletion') &&
      current.dateTime === selectedRestorePoint.recordedAt
    );
  }, 'the same authoritative restore point in confirmation');
  evidence.selectedRestorePoint = selectedRestorePoint;
  await screenshot(path.join(f.shots, '09-restart-restore-review.png'));
  await reviewAndApply();
  assert.equal(await readFile(path.join(copied, 'SKILL.md'), 'utf8'), edited);
  assert.deepEqual(await readFile(path.join(copied, 'assets/sample.bin')), imageBytes);
  assert(
    !(await environment()).pendingOperations?.length,
    'fully restored local operation must leave no pending fence'
  );
  await screenshot(path.join(f.shots, '10-restored.png'));
  evidence.localAuthoring = {
    edited: true,
    binaryPreserved: true,
    deleted: true,
    actualHostRestart: true,
    restartVisibleUndo: true,
    exactRestoration: true,
  };
}

async function exercise(f: Awaited<ReturnType<typeof fixture>>) {
  await openSkills();
  await screenshot(path.join(f.shots, '01-empty-environment.png'));
  assert.equal(
    (await environment()).entries.length,
    0,
    'fixture must start without fabricated installed state'
  );
  await click(button('Install from source', panel));
  await fill('#uap-source-skill', f.source);
  await key('Tab');
  assert.equal(
    await callUi(cdp!, 'active-id'),
    'uap-ref-skill',
    'source fields must support keyboard navigation'
  );
  await click(button('Find skills'));
  const discoveredSkill: UiLocator = {
    selector: '[role=checkbox]',
    attributes: { 'aria-label': skillName },
  };
  await wait(present(discoveredSkill), 'real web source discovery');
  assert.equal(
    await callUi(cdp!, 'count', [{ selector: '[role=dialog][data-state=open]' }]),
    1,
    'preview must use one dialog'
  );
  await click(button('Preview SKILL.md'));
  await wait(
    present({ selector: '[role=dialog]', textIncludes: ['Desktop fixture revision 1.'] }),
    'acquired SKILL.md preview'
  );
  assert.equal(
    await callUi(cdp!, 'count', [{ selector: '[role=dialog][data-state=open]' }]),
    1,
    'preview must keep one dialog'
  );
  await screenshot(path.join(f.shots, '02-source-preview.png'));
  await key('Escape');
  await wait(
    async () =>
      (await inspect({ selector: '#uap-source-skill' })) &&
      !(await inspect(button('Back to discovered Skills'))),
    'return from preview without closing discovery'
  );
  await click(discoveredSkill);
  await click(button('Review installation'));
  await wait(present(button('Apply changes')), 'installation review');
  await screenshot(path.join(f.shots, '03-install-review.png'));
  await reviewAndApply();
  await wait(present(installedRow), 'installed row');
  await screenshot(path.join(f.shots, '04-installed.png'));
  await cdp!.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await callUi(cdp!, 'scroll', [panel]);
  await pause(250);
  const narrowPanel = await inspect(panel);
  assert(
    narrowPanel && narrowPanel.scrollWidth <= narrowPanel.clientWidth + 1,
    'managed panel must fit a narrow window'
  );
  await screenshot(path.join(f.shots, '04-narrow-installed.png'));
  await cdp!.send('Emulation.clearDeviceMetricsOverride');
  evidence.narrowLayout = { width: 760, horizontalOverflow: false, sourceKeyboardNavigation: true };
  const installed = await environment();
  const entry = installed.entries.find((item) => item.kind === 'skill');
  assert(entry?.declared, 'installed Skill must be a declared dependency');
  const nativeRoot = f.env.OPENCODE_CONFIG_DIR!;
  const projected = entry.bindings
    .flatMap((binding) => binding.managedPaths)
    .find(
      (location) =>
        location.startsWith(`${nativeRoot}${path.sep}`) && path.basename(location) === skillName
    );
  assert(projected, `missing concrete native Skill path in ${JSON.stringify(entry.bindings)}`);
  assert.match(await readFile(path.join(projected, 'SKILL.md'), 'utf8'), /revision 1/);
  assert.deepEqual(await readFile(path.join(projected, 'assets', 'sample.bin')), imageBytes);
  const discovery = await run(f.native, ['debug', 'skill'], {
    env: f.env,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert(
    discovery.stdout.includes(skillName),
    'actual native OpenCode must discover the installed Skill'
  );
  evidence.nativeDiscovery = {
    version: (await run(f.native, ['--version'], { env: f.env })).stdout.trim(),
    alias: entry.alias,
    projected,
  };
  await verifyHttp(f);
  await click(button('Make a local copy', installedRow));
  await wait(present(button('Review And Import')), 'reused import dialog');
  await screenshot(path.join(f.shots, '05-copy-dialog.png'));
  await click(button('Review And Import'));
  await wait(present(button('Import Skill')), 'copy file review');
  await applyAndWaitForOperation(
    cdp!,
    wait,
    panel,
    () => click(button('Import Skill')),
    'Go local copy',
    60_000
  );
  const copied = path.join(f.home, '.claude', 'skills', `${skillName}-copy`);
  assert.deepEqual(await readFile(path.join(copied, 'assets', 'sample.bin')), imageBytes);
  evidence.localCopy = { path: copied, exactBinaryBytes: true };
  version = 2;
  await click(button('Update', installedRow));
  await reviewAndApply();
  assert.match(await readFile(path.join(projected, 'SKILL.md'), 'utf8'), /revision 2/);
  await screenshot(path.join(f.shots, '06-updated.png'));
  evidence.targetedUpdate = true;
  await click(button('Remove', installedRow));
  await reviewAndApply();
  assert.equal((await environment()).entries.filter((item) => item.kind === 'skill').length, 0);
  await assert.rejects(readFile(path.join(projected, 'SKILL.md')));
  assert.match(await readFile(path.join(copied, 'SKILL.md'), 'utf8'), /revision 1/);
  await screenshot(path.join(f.shots, '07-removed-copy-preserved.png'));
  evidence.targetedRemoval = true;
  await localSkillLifecycle(f, copied);
  activeRun = await startActiveRunProof({
    ...f,
    cdp: cdp!,
    wait,
    evidence,
    pluginSource: `${new URL(f.source).origin}${toolArchivePath}#sha256=${toolProof!.sha256}`,
    async captureProcessMetadata() {
      if (!app?.pid || app.exitCode !== null)
        return { status: 'unavailable', code: 'OWNED_LAUNCHER_NOT_RUNNING' };
      return captureOwnedUapProcessMetadata({
        ownedLauncherPid: app.pid,
        expectedEngineExecutable: f.engineExecutable,
        expectedHome: f.home,
        expectedStateRoot: f.env.AGENTPLUGINS_HOME!,
      });
    },
    captureCliControl: () => captureFreshProfileCliControl({ ...f, publisherRevision: version }),
    advancePublisher: () => {
      version = 3;
    },
    async assertUiRefusal() {
      await selectTab(cdp!, wait, 'Skills');
      await selectAgent(panel, 'Claude Code');
      const row: UiLocator = { ...installedRow, textIncludes: [skillName] };
      await wait(present(row), 'active-profile installed Claude Skill');
      await click(button('Repair', row));
      await wait(
        async () =>
          (await callUi<string[]>(cdp!, 'alerts')).some((text) =>
            text.includes('Stop the active run using this agent profile')
          ),
        'actionable active-profile UI refusal'
      );
      await screenshot(path.join(f.shots, '20-active-profile-refusal.png'));
    },
  });
  await registryPlugin(f);
  await nativeToolUse(f);
  await activeRun.finish();
  assert.equal(model!.errors.length, 0, JSON.stringify(model!.errors));
  assert(model!.receipts.length > 0, 'Real team runtime must reach the scripted model boundary');
  evidence.activeModel = { requests: model!.receipts.length, errors: model!.errors };
  await screenshot(path.join(f.shots, '21-after-active-team-stop.png'));
  assert(pluginMatrix);
  await exercisePluginMatrix({
    ...f,
    cdp: cdp!,
    wait,
    evidence,
    fixture: pluginMatrix,
    binaries: { claude: f.claude, codex: f.codex, opencode: f.native },
    click,
    fill,
    selectAgent,
    reviewAndApply,
    screenshot,
    environment,
  });
  assert.equal(errors.length, 0, `Unexpected renderer exceptions: ${JSON.stringify(errors)}`);
  evidence.requests = f.requests;
}

const f = await fixture();
process.stdout.write(`Disposable UAP desktop fixture: ${f.root}\n`);
try {
  pluginMatrix = await createPluginMatrixFixture(f.root);
  toolProof = await createNativeToolProof(f.root, f.native, f.env);
  evidence.nativeToolUse = toolProof.evidence;
  await start(f);
  await screenshot(path.join(f.shots, '00-desktop.png'));
  process.stdout.write(`Actual Electron renderer ready: ${path.join(f.root, 'connection.json')}\n`);
  if (process.env.UAP_E2E_HOLD === '1') {
    await Promise.race([once(process, 'SIGTERM'), once(process, 'SIGINT')]);
  } else {
    await exercise(f);
    evidence.completed = true;
  }
} catch (error) {
  evidence.failure = String(error);
  process.stderr.write(
    `Owned desktop log tail (last 12,000 characters):\n${logs.join('').slice(-12_000)}\n`
  );
  await cdp?.screenshot(path.join(f.shots, 'failure.png')).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(f.root, 'desktop.log'), logs.join(''));
  await activeRun?.close().catch((error) => {
    evidence.activeRunCleanupFailure = String(error);
  });
  await stop(f.root);
  await save(path.join(f.root, 'evidence.json'), { ...evidence, rendererErrors: errors });
  await new Promise<void>((resolve) => publisher?.close(() => resolve()));
  await toolProof?.close();
  await model?.close();
  process.stdout.write(`Evidence retained at ${f.root}\n`);
}
