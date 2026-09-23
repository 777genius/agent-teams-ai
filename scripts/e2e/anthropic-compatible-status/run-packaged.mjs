#!/usr/bin/env node
// Issue #684: packaged Windows UI and passive status, ending before Create Team.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  packagedArguments,
  packagedArtifact,
  packagedTarget,
  prepareExistingProject,
  preparePackagedProfile,
  runtimeProvenance,
} from '../opencode-diagnostics/packaged.mjs';
import {
  assertPortAvailable,
  listeners,
  ownedTree,
  processes,
  sameIdentity,
} from '../opencode-diagnostics/platform.mjs';

const { executable } = packagedArguments(process.argv.slice(2));
const root = await mkdtemp(path.join(os.tmpdir(), 'anthropic-compatible-status-state-'));
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'anthropic-compatible-status-e2e-'));
const data = {
  root,
  home: path.join(root, 'home'),
  userData: path.join(root, 'user-data'),
  temp: path.join(root, 'tmp'),
  project: path.join(root, 'test-project'),
  artifact: await packagedArtifact(executable),
};
const evidence = { passed: false, issue: 684, artifact: data.artifact, steps: [], requests: [] };
const token = `issue684-${randomBytes(18).toString('hex')}`;
const model = 'issue684-compatible-model';
let app;
let appIdentity;
let cdp;
let mock;
let lastOwned = [];
const log = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (step, detail = {}) =>
  evidence.steps.push({ step, at: new Date().toISOString(), ...detail });
const redact = (value) => String(value).replaceAll(token, '[REDACTED]');
const persist = async () =>
  writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Cdp(socket);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) throw new Error(redact(reply.exceptionDetails.text));
    return reply.result?.value;
  }
  async wait(expression, label, timeout = 120000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const result = await this.evaluate(expression);
      if (result) return result;
      await pause(400);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async click(selector) {
    const point = await this.wait(
      `(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || e.disabled) return null;
      e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect();
      return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null;
    })()`,
      `clickable ${selector}`
    );
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
  }
  async fill(selector, value) {
    await this.wait(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      `input ${selector}`
    );
    await this.click(selector);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
    });
    await this.send('Input.insertText', { text: value });
    // React controlled inputs must receive real keyboard input via CDP, not a DOM value mutation.
    assert(
      (await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)) === value,
      'Input did not accept text'
    );
  }
  async clickText(text, scope = 'document') {
    const point = await this.wait(
      `(() => {
      const root = ${scope};
      const e = [...root.querySelectorAll('button')].find(b => {
        const r = b.getBoundingClientRect();
        return b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled && r.width > 0 && r.height > 0;
      });
      if (!e) return null;
      e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect();
      return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null;
    })()`,
      `button ${text}`
    );
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
  }
  async probe(name, expression, timeout = 120000) {
    const slot = `__issue684_${name}`;
    await this.evaluate(`globalThis[${JSON.stringify(slot)}]={done:false}; Promise.resolve()
      .then(() => (${expression}))
      .then(value => globalThis[${JSON.stringify(slot)}]={done:true,value},
            error => globalThis[${JSON.stringify(slot)}]={done:true,error:String(error)}); void 0`);
    const result = await this.wait(
      `globalThis[${JSON.stringify(slot)}]?.done && globalThis[${JSON.stringify(slot)}]`,
      name,
      timeout
    );
    assert(!result.error, `${name}: ${redact(result.error)}`);
    return result.value;
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(path.join(evidenceRoot, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
  close() {
    this.socket.close();
  }
}

async function rendererTarget() {
  const owned = ownedTree(processes(), appIdentity);
  lastOwned = owned;
  const ports = listeners();
  assert(
    ports.length && ports.every((pid) => owned.some((entry) => entry.pid === pid)),
    'CDP port owner is not the test app'
  );
  const targets = await (
    await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) })
  ).json();
  return packagedTarget(targets, data.artifact.renderer, true, path.win32);
}

try {
  assert.equal(process.platform, 'win32');
  const env = await preparePackagedProfile(data);
  data.projectSentinel = await prepareExistingProject(data);
  await assertPortAvailable();
  mock = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authorization = req.headers.authorization ?? '';
    const authorized = authorization === `Bearer ${token}`;
    const modelsRequest = req.method === 'GET' && url.pathname === '/v1/models';
    const request = {
      method: req.method,
      path: url.pathname,
      bearer: authorization.startsWith('Bearer '),
      authorized,
    };
    evidence.requests.push(request);
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      // Existing direct-credential preflight runs a one-shot diagnostic. The
      // catalog-only test endpoint intentionally does not answer model prompts.
      let body = '';
      req.on('data', (chunk) => {
        if (body.length < 65536) body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          request.model = typeof parsed.model === 'string' ? parsed.model : null;
        } catch {
          request.model = null;
        }
        res.writeHead(authorized ? 404 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: authorized ? 'Not found' : 'Unauthorized' } }));
      });
      return;
    }
    if (!authorized || !modelsRequest) {
      res.writeHead(authorized ? 404 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: authorized ? 'Not found' : 'Unauthorized' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: model, object: 'model', display_name: model }],
      })
    );
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  record('mock-listening', { baseUrl });
  app = spawn(
    data.artifact.app.path,
    [
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${data.userData}`,
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  for (const stream of [app.stdout, app.stderr])
    stream.on('data', (chunk) => {
      if (log.length < 1000) log.push(String(chunk));
    });
  await new Promise((resolve, reject) => {
    app.once('spawn', resolve);
    app.once('error', reject);
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    appIdentity = processes().find((entry) => entry.pid === app.pid);
    if (appIdentity?.birth) break;
    await pause(500);
  }
  assert(appIdentity?.birth, 'App process identity unavailable');
  const until = Date.now() + 120000;
  let target;
  while (Date.now() < until) {
    if (app.exitCode !== null) throw new Error('Packaged app exited during startup');
    try {
      target = await rendererTarget();
      break;
    } catch {
      await pause(1000);
    }
  }
  assert(target, 'Packaged renderer did not start');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.wait('Boolean(window.electronAPI?.cliInstaller && document.body)', 'app preload');
  const discovery = await cdp.probe(
    'discovery',
    'window.electronAPI.cliInstaller.getStatus({providerStatusMode:"defer"})'
  );
  evidence.runtime = await runtimeProvenance(discovery, data, 'orchestrator');
  assert(discovery.installed && !discovery.launchError, 'Pinned packaged runtime did not resolve');
  record('packaged-runtime-resolved');
  // Stage only the new disposable project through the app's public test API.
  await cdp.probe(
    'testProject',
    `window.electronAPI.config.addCustomProjectPath(${JSON.stringify(data.project)})`
  );
  await cdp.wait(
    'Boolean(document.querySelector("[data-testid=runtime-manage-anthropic]"))',
    'Anthropic Manage button'
  );
  await cdp.click('[data-testid=runtime-manage-anthropic]');
  await cdp.fill('#anthropic-compatible-base-url', baseUrl);
  await cdp.fill('#anthropic-compatible-auth-token', token);
  record('settings-fields-entered');
  await cdp.clickText('Save endpoint', 'document.querySelector("[role=dialog]")');
  await cdp.wait(
    `window.electronAPI.config.get().then(config => {
      const endpoint = config.providerConnections.anthropic.compatibleEndpoint;
      return endpoint.enabled === true && endpoint.baseUrl === ${JSON.stringify(baseUrl)};
    })`,
    'endpoint persisted'
  );
  evidence.savedEndpoint = { enabled: true, baseUrl };
  await cdp.wait(
    'document.querySelector("#anthropic-compatible-auth-token")?.value === ""',
    'saved token input cleared'
  );
  evidence.settingsSummary = await cdp.wait(
    '(() => { const root=document.querySelector("[data-testid=provider-runtime-summary]"); const label=[...(root?.querySelectorAll("span") ?? [])].find(e => /compatible/i.test(e.textContent)); return label && getComputedStyle(label).color === "rgb(74, 222, 128)" ? label.textContent.trim() : null; })()',
    'Settings verified status'
  );
  await cdp.shot('settings-saved');
  record('settings-saved');
  const status = await cdp.probe(
    'anthropicStatus',
    `window.electronAPI.cliInstaller.getProviderStatus('anthropic',{projectPath:${JSON.stringify(data.project)},checkReason:'launch_preflight'})`
  );
  evidence.status = {
    authenticated: status.authenticated === true,
    verificationState: status.verificationState,
    statusCheckOutcome: status.statusCheckOutcome,
    modelIds: (status.models ?? []).map((item) => (typeof item === 'string' ? item : item.id)),
    backendKind: status.backend?.kind,
  };
  assert.equal(status.authenticated, true, 'Settings provider status is not authenticated');
  assert.equal(status.verificationState, 'verified', 'Provider status is not verified');
  assert(evidence.status.modelIds.includes(model), 'Compatible model absent from provider status');
  assert(
    evidence.requests.some(
      (request) => request.method === 'GET' && request.path === '/v1/models' && request.authorized
    ),
    'No authorized GET /v1/models reached mock'
  );
  record('passive-status-verified');
  await cdp.clickText('Close', 'document.querySelector("[role=dialog]")');
  await cdp.click('[aria-label="More actions"]');
  await cdp.clickText('Teams');
  await cdp.clickText('Create Team');
  record('create-team-opened');
  await cdp.clickText('Custom path', 'document.querySelector("[role=dialog]")');
  await cdp.fill('[role=dialog] input[aria-label="Custom working directory"]', data.project);
  record('test-project-selected');
  await cdp.click('[role=dialog] button[aria-label^="Anthropic provider,"]');
  await cdp.wait(
    'Boolean(document.querySelector("[data-testid=team-model-selector-provider-nav-anthropic]"))',
    'Create Team model selector'
  );
  record('model-selector-expanded');
  await cdp.click('[data-testid=team-model-selector-provider-nav-anthropic]');
  await cdp.wait(
    `Boolean([...document.querySelectorAll('[data-testid=team-model-selector-model-option]')].find(b => b.textContent.includes(${JSON.stringify(model)})))`,
    'compatible model option'
  );
  const modelOption = `[data-testid=team-model-selector-model-option][aria-label*="${model}"]`;
  await cdp.click(modelOption);
  await cdp.wait(
    `document.querySelector(${JSON.stringify(modelOption)})?.getAttribute('aria-pressed') === 'true'`,
    'selected compatible model'
  );
  const readSelection = `(() => ({
    leadLabel: document.querySelector('[data-role="lead-row"] button[aria-label^="Anthropic provider,"]')?.getAttribute('aria-label') ?? null,
    storedModel: localStorage.getItem('createTeam:lastSelectedModel:anthropic'),
    selectedOptions: [...document.querySelectorAll('[data-testid=team-model-selector-model-option][aria-pressed=true]')].map((b) => b.getAttribute('aria-label')),
  }))()`;
  evidence.selectionAfterClick = await cdp.evaluate(readSelection);
  await cdp.shot('create-team-model-status');
  record('create-team-model-selected', { model });
  // Create Team runs its own selected-model preflight. Never press Create Team or call team:create.
  const diagnosticDeadline = Date.now() + 120000;
  while (
    !evidence.requests.some(
      (request) => request.method === 'POST' && request.path === '/v1/messages'
    ) &&
    Date.now() < diagnosticDeadline
  ) {
    await pause(400);
  }
  assert(
    evidence.requests.some((request) => request.method === 'POST' && request.path === '/v1/messages'),
    'The existing direct-credential diagnostic did not finish'
  );
  await cdp.wait(
    `(() => {
      const text = document.querySelector('[role=dialog]')?.innerText ?? '';
      const selected = document.querySelector(${JSON.stringify(modelOption)})?.getAttribute('aria-pressed') === 'true';
      const lead = document.querySelector('[data-role="lead-row"] button[aria-label^="Anthropic provider,"]')?.getAttribute('aria-label') ?? '';
      return selected && lead.includes(${JSON.stringify(model)}) &&
        text.includes('Selected providers ready (with notes)') &&
        text.includes('Selected model ${model} is available for launch.');
    })()`,
    'settled Create Team preflight for selected compatible model',
    180000
  );
  const createTeamText = await cdp.evaluate('document.querySelector("[role=dialog]").innerText');
  assert(
    /Selected model checks[\s\S]*(available|compatible|verified)/i.test(createTeamText),
    'Selected-model preflight did not report a positive model check'
  );
  evidence.modelPreflight = {
    completed: true,
    selectedModel: model,
    uiReady: createTeamText.includes('Selected providers ready'),
    uiModelCheck: createTeamText.match(/Selected model checks[^\n]*/i)?.[0] ?? null,
    selectedModelDetail: createTeamText.includes(`Selected model ${model} is available for launch.`),
    selection: await cdp.evaluate(readSelection),
  };
  assert(
    evidence.requests.some((request) => request.authorized),
    'Selected-model check did not retain authorized endpoint access'
  );
  assert(
    evidence.requests.every(
      (request) =>
        (request.method === 'HEAD' && request.path === '/' && !request.bearer) ||
        (request.method === 'GET' && request.path === '/v1/models') ||
        (request.method === 'POST' && request.path === '/v1/messages' && request.authorized)
    ),
    'Preflight made an unexpected provider request'
  );
  await cdp.shot('selected-model-preflight');
  record('selected-model-preflight-complete');
  assert.equal(await readFile(data.projectSentinel, 'utf8'), 'preserve-existing-project\n');
  evidence.passed = true;
  await persist();
} catch (error) {
  evidence.error = redact(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (cdp) {
    try {
      await cdp.shot('final-state');
    } catch {
      /* renderer may have exited */
    }
    cdp.close();
  }
  if (appIdentity) {
    try {
      const snapshot = processes();
      const owned = snapshot.some(
        (entry) => entry.pid === appIdentity.pid && entry.birth === appIdentity.birth
      )
        ? ownedTree(snapshot, appIdentity)
        : lastOwned;
      for (const entry of owned.reverse()) {
        const current = processes().find((candidate) => candidate.pid === entry.pid);
        if (!current) continue;
        sameIdentity(entry, current);
        try {
          process.kill(entry.pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            evidence.cleanupError = redact(error);
            process.exitCode = 1;
            evidence.passed = false;
          }
        }
      }
      let remaining = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        remaining = processes().filter((current) =>
          owned.some((entry) => entry.pid === current.pid && entry.birth === current.birth)
        );
        if (remaining.length === 0) break;
        await pause(500);
      }
      assert.equal(remaining.length, 0, 'Smoke-owned app processes remain after cleanup');
      record('owned-processes-stopped', { count: owned.length });
    } catch (error) {
      evidence.cleanupError = redact(error);
      evidence.passed = false;
      process.exitCode = 1;
    }
  }
  if (mock) {
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
  if (app) await writeFile(path.join(evidenceRoot, 'desktop.log'), redact(log.join('')));
  try {
    await rm(root, { recursive: true, force: true });
    record('test-profile-removed');
  } catch (error) {
    evidence.cleanupError = redact(error);
    evidence.passed = false;
    process.exitCode = 1;
  }
  await persist();
  console.log(`Evidence: ${evidenceRoot}`);
}
