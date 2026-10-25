#!/usr/bin/env -S pnpm exec tsx
// Real Electron + bundled UAP + native OpenCode. All writable state is disposable.
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
import { postWithReboundHost } from './uap-management-http';
import { openCodeMcpServer } from './uap-management-native';
import {
  actionablePoint,
  applyAndWaitForOperation,
  dispatchKey,
  screenshotWhenSettled,
  selectTab,
  type DesktopCdp,
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
let version = 1;
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
  const runtime = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  assert(
    native && runtime,
    'Set UAP_E2E_OPENCODE and the real CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
  );
  await Promise.all([native, runtime].map((file) => access(file, constants.X_OK)));
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
  for (const [file, digest] of [
    [path.join(repo, 'vendor/uap/sdk', sdk.file), sdk.sha256],
    [path.join(repo, 'resources/uap', engine.executable), engine.sha256],
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
    PATH: `${path.dirname(native)}${path.delimiter}${process.env.PATH ?? ''}`,
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
      if (url === `${prefix}index.json`) {
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
          await wait(
            'window.electronAPI?.extensionManagement && document.querySelector("button")',
            'desktop renderer'
          );
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

async function wait(expression: string, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp!.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
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
  const alerts = await cdp!.evaluate(
    'Array.from(document.querySelectorAll("[role=alert]")).map(e=>e.textContent)'
  );
  throw new Error(`Timed out waiting for ${label}; alerts: ${JSON.stringify(alerts)}`);
}

const button = (label: string, root = 'document') =>
  `Array.from((${root})?.querySelectorAll('button') ?? []).find(e => e.textContent?.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const panel = 'document.querySelector("[data-testid=uap-skill]")';
const installedRow = `${panel}?.querySelector('[data-testid=uap-installed-entry]')`;
async function click(expression: string) {
  const pointExpression = actionablePoint(expression);
  await wait(pointExpression, `enabled visible click target ${expression}`);
  const point = await cdp!.evaluate(pointExpression);
  assert(point && typeof point === 'object', `Missing or disabled click target: ${expression}`);
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
  await click(`document.querySelector(${JSON.stringify(selector)})`);
  await key('a', 'KeyA', process.platform === 'darwin' ? 4 : 2);
  await cdp!.send('Input.insertText', { text });
  assert.equal(
    await cdp!.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`),
    text
  );
}
async function openSkills() {
  await click(button('More actions'));
  await click(button('Extensions'));
  await selectTab(cdp!, wait, 'Skills');
  await wait(`${panel} && !${button('Agent runtime', panel)}?.disabled`, 'managed Skill context');
  await click(button('Agent runtime', panel));
  await click(
    `Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent?.trim()==='OpenCode')`
  );
  await wait(
    `${button('Install from source', panel)} && !${button('Install from source', panel)}.disabled`,
    'native OpenCode capability',
    90_000
  );
}
async function reviewAndApply(root = panel) {
  await wait(
    `${button('Apply changes')} && !${button('Apply changes')}.disabled`,
    'confirmable Go plan',
    90_000
  );
  await applyAndWaitForOperation(cdp!, wait, root, () => click(button('Apply changes')));
}

async function registryPlugin(f: Awaited<ReturnType<typeof fixture>>) {
  const pluginPanel = 'document.querySelector("[data-testid=uap-plugin]")';
  await selectTab(cdp!, wait, 'Plugins');
  await wait(
    `${pluginPanel} && !${button('Agent runtime', pluginPanel)}?.disabled`,
    'universal Plugins entry point'
  );
  await click(button('Agent runtime', pluginPanel));
  await click(
    `Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent?.trim()==='OpenCode')`
  );
  const registry = (await cdp!.evaluate(
    `(async()=>{const api=window.electronAPI.extensionManagement; const context=await api.capture({client:'opencode',scope:'user'}); return api.catalog({contextId:context.contextId});})()`
  )) as ManagementCatalog;
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
  const card = `${pluginPanel}?.querySelector('[data-catalog-id="cloudflare-docs"]')`;
  await wait(
    `${button('Install', card)} && !${button('Install', card)}.disabled`,
    'reviewed signed catalog entry',
    90_000
  );
  await screenshot(path.join(f.shots, '11-registry-plugin.png'));
  await click(`${card}.querySelector('button')`);
  await wait(`document.querySelector('[role=dialog]')`, 'registry plugin details');
  await key('Escape');
  await click(button('Install', card));
  await wait(button('Apply changes'), 'signed registry installation review');
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
    button('Remove', `${pluginPanel}.querySelector('[data-testid=uap-installed-entry]')`)
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
async function environment(): Promise<ManagementEnvironment> {
  return (await cdp!.evaluate(
    `(async()=>{ const api=window.electronAPI.extensionManagement; const context=await api.capture({client:'opencode',scope:'user'}); return api.environment({contextId:context.contextId}); })()`
  )) as ManagementEnvironment;
}

async function verifyHttp(f: Awaited<ReturnType<typeof fixture>>) {
  const origin = `http://127.0.0.1:${f.httpPort}`;
  const route = `${origin}/api/extension-management`;
  const post = (method: string, input: unknown, extra: Record<string, string> = {}) =>
    fetch(`${route}/${method}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(input),
    });
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
  const card = `Array.from(document.querySelectorAll('.skills-grid button')).find(e => e.querySelector('h3')?.textContent?.trim() === '${skillName}')`;
  await click(card);
  await wait(
    `${button('Edit Skill')} && !${button('Edit Skill')}.disabled`,
    'authoritative local ownership'
  );
  await click(button('Edit Skill'));
  await fill('#skill-name', 'uap-ui-demo-local');
  await fill('#skill-description', 'Edited through the existing local Skill editor');
  await click(button('Review And Save'));
  await wait(button('Save Skill'), 'local exact-byte edit review');
  await screenshot(path.join(f.shots, '08-local-edit-review.png'));
  await click(button('Save Skill'));
  await wait(
    `!document.querySelector('#skill-name') && !${button('Save Skill')}`,
    'local editor completion'
  );
  const edited = await readFile(path.join(copied, 'SKILL.md'), 'utf8');
  assert(edited.includes('Edited through the existing local Skill editor'));
  assert.deepEqual(await readFile(path.join(copied, 'assets/sample.bin')), imageBytes);
  // The detail remains open after saving. Closing with Escape exercises keyboard navigation.
  if (await cdp!.evaluate(`Boolean(document.querySelector('[role=dialog]'))`)) await key('Escape');
  await click(
    `Array.from(document.querySelectorAll('.skills-grid button')).find(e => e.querySelector('h3')?.textContent?.trim() === 'uap-ui-demo-local')`
  );
  await wait(`${button('Delete')} && !${button('Delete')}.disabled`, 'local deletion admission');
  await click(button('Delete'));
  await click(button('Delete Skill'));
  await wait(
    `!document.querySelector('[role=dialog]') && !document.querySelector('[role=alertdialog]')`,
    'local deletion completion'
  );
  await assert.rejects(readFile(path.join(copied, 'SKILL.md')));
  const backups = (await environment()).localSkillBackups ?? [];
  assert(
    backups.some((backup) => backup.skillName === path.basename(copied)),
    'delete must publish a durable restore point'
  );
  await stop(f.root);
  await start(f);
  await openSkills();
  const restore = `${panel}.querySelector('[data-testid=uap-restore-points]')`;
  await click(`${restore}?.querySelector('summary')`);
  const row = `Array.from(${restore}.querySelectorAll('div')).find(e=>e.querySelector('span')?.textContent==='${path.basename(copied)}')`;
  await click(button('Review restoration', row));
  await wait(button('Apply changes'), 'restart-visible local restoration review');
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
    await cdp!.evaluate('document.activeElement?.id'),
    'uap-ref-skill',
    'source fields must support keyboard navigation'
  );
  await click(button('Find skills'));
  await wait(
    `document.querySelector('[role=checkbox][aria-label="${skillName}"]')`,
    'real web source discovery'
  );
  assert.equal(
    await cdp!.evaluate(`document.querySelectorAll('[role=dialog][data-state=open]').length`),
    1,
    'preview must use one dialog'
  );
  await click(button('Preview SKILL.md'));
  await wait(
    `Array.from(document.querySelectorAll('[role=dialog]')).some(e=>e.textContent?.includes('Desktop fixture revision 1.'))`,
    'acquired SKILL.md preview'
  );
  assert.equal(
    await cdp!.evaluate(`document.querySelectorAll('[role=dialog][data-state=open]').length`),
    1,
    'preview must keep one dialog'
  );
  await screenshot(path.join(f.shots, '02-source-preview.png'));
  await key('Escape');
  await wait(
    `document.querySelector('#uap-source-skill') && !${button('Back to discovered Skills')}`,
    'return from preview without closing discovery'
  );
  await click(`document.querySelector('[role=checkbox][aria-label="${skillName}"]')`);
  await click(button('Review installation'));
  await wait(button('Apply changes'), 'installation review');
  await screenshot(path.join(f.shots, '03-install-review.png'));
  await reviewAndApply();
  await wait(installedRow, 'installed row');
  await screenshot(path.join(f.shots, '04-installed.png'));
  await cdp!.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp!.evaluate(`${panel}.scrollIntoView({block:'start'})`);
  await pause(250);
  assert(
    await cdp!.evaluate(`${panel}.scrollWidth <= ${panel}.clientWidth + 1`),
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
  await wait(button('Review And Import'), 'reused import dialog');
  await screenshot(path.join(f.shots, '05-copy-dialog.png'));
  await click(button('Review And Import'));
  await wait(button('Import Skill'), 'copy file review');
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
  await registryPlugin(f);
  assert.equal(errors.length, 0, `Unexpected renderer exceptions: ${JSON.stringify(errors)}`);
  evidence.requests = f.requests;
}

const f = await fixture();
process.stdout.write(`Disposable UAP desktop fixture: ${f.root}\n`);
try {
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
  await stop(f.root);
  await save(path.join(f.root, 'evidence.json'), { ...evidence, rendererErrors: errors });
  await new Promise<void>((resolve) => publisher?.close(() => resolve()));
  process.stdout.write(`Evidence retained at ${f.root}\n`);
}
