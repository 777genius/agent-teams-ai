#!/usr/bin/env node
// Run: pnpm exec node scripts/e2e/anthropic-model-selection-desktop.mts
// Default/no-catalog: add --default-no-catalog
// Typecheck: pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --types node scripts/e2e/anthropic-model-selection-desktop.mts
// Regression: explicit Opus generations must survive context toggles, real
// main-process preflight, and config-only creation. No provider is launched.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type JsonRecord = Record<string, unknown>;
interface PreflightEvent {
  event: string;
  cwd?: string;
  modelIds?: string[];
  details?: string[];
  blockingMessages?: string[];
}
interface SavedRequest {
  model?: string;
  providerId?: string;
  limitContext?: boolean;
  cwd?: string;
}
interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Pending {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface InputElement {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  dispose(): Promise<void>;
}
interface InputHandle {
  asElement(): InputElement | null;
  dispose(): Promise<void>;
}
interface InputPage {
  url(): string;
  bringToFront(): Promise<void>;
  evaluateHandle(expression: string): Promise<InputHandle>;
}
interface InputBrowser {
  contexts(): { pages(): InputPage[] }[];
  close(): Promise<void>;
}
interface Playwright {
  chromium: { connectOverCDP(url: string): Promise<InputBrowser> };
}
const require = createRequire(import.meta.url);
function loadPlaywright(): Playwright {
  if (process.env.ANTHROPIC_MODEL_E2E_PLAYWRIGHT_PATH)
    return require(process.env.ANTHROPIC_MODEL_E2E_PLAYWRIGHT_PATH) as Playwright;
  try {
    return require('playwright') as Playwright;
  } catch {
    return require(
      path.join(
        os.homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
      )
    ) as Playwright;
  }
}

class Cdp {
  inputPage?: InputPage;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message: string };
        result: JsonRecord;
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('CDP closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP connect failed')), {
        once: true,
      });
    });
    return new Cdp(socket);
  }
  send(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return (response.result as { value: T }).value;
  }
  async waitFor(expression: string, label: string, timeout = 30_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  // Inspection uses CDP; signoff input uses normal Playwright mouse/keyboard.
  async click(expression: string): Promise<void> {
    await this.waitFor(expression, expression);
    assert(this.inputPage, 'Trusted Playwright input must be connected');
    await this.inputPage.bringToFront();
    const handle = await this.inputPage.evaluateHandle(expression);
    try {
      const element = handle.asElement();
      assert(element);
      await element.click();
    } finally {
      await handle.dispose();
    }
  }
  async fill(selector: string, text: string): Promise<void> {
    const expression = `document.querySelector(${JSON.stringify(selector)})`;
    await this.waitFor(expression, selector);
    assert(this.inputPage);
    await this.inputPage.bringToFront();
    const handle = await this.inputPage.evaluateHandle(expression);
    try {
      const element = handle.asElement();
      assert(element);
      await element.fill(text);
    } finally {
      await handle.dispose();
    }
  }
  close(): void {
    this.socket.close();
  }
}
const button = (text: string, scope = 'document') =>
  `Array.from(${scope}.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const dialog = "document.querySelector('[role=dialog]')";
const json = async (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function fixture() {
  const defaultNoCatalog = process.argv.includes('--default-no-catalog');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anthropic-model-desktop-')));
  const directories = Object.fromEntries(
    [
      'claude',
      'user-data',
      'claude-config',
      'multimodel-data',
      'multimodel-cache',
      'xdg-config',
      'xdg-data',
      'xdg-cache',
      'xdg-state',
      'xdg-runtime',
      'tmp',
      'sandbox-project',
    ].map((name) => [name, path.join(root, name)])
  );
  await Promise.all(
    Object.values(directories).map((directory) => mkdir(directory, { recursive: true }))
  );
  const version = (
    JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const models = ['opus', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'].map(
    (model, index) => ({
      id: model,
      launchModel: model,
      displayName: ['Opus alias 4.8', 'Opus 4.8', 'Opus 5', 'Opus 5.5'][index],
      hidden: index === 0,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      supportsFastMode: false,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: index === 1,
      upgrade: false,
      source: 'anthropic-models-api',
      badgeLabel: null,
      statusMessage: null,
      metadata: { context: 1_000_000 },
    })
  );
  models.push(
    ...models
      .filter((model) => ['claude-opus-5', 'claude-opus-5-5'].includes(model.launchModel))
      .map((model) => ({
        ...model,
        id: `${model.id}[1m]`,
        launchModel: `${model.launchModel}[1m]`,
        displayName: `${model.displayName} (1M)`,
        hidden: true,
        isDefault: false,
      }))
  );
  const status = {
    providerId: 'anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'claude.ai',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusMessage: null,
    detailMessage: null,
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: Object.fromEntries(
        ['plugins', 'mcp', 'skills', 'apiKeys'].map((key) => [
          key,
          { status: 'supported', ownership: 'shared', reason: null },
        ])
      ),
    },
    models: defaultNoCatalog ? ['opus'] : models.map((model) => model.launchModel),
    defaultModel: defaultNoCatalog ? 'claude-opus-5-5' : 'claude-opus-4-8',
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    runtimeCapabilities: {
      modelCatalog: defaultNoCatalog
        ? undefined
        : { dynamic: true, source: 'anthropic-models-api' },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high', 'max'],
        configPassthrough: false,
      },
    },
    modelCatalog: defaultNoCatalog
      ? null
      : {
          schemaVersion: 1,
          providerId: 'anthropic',
          source: 'anthropic-models-api',
          status: 'ready',
          fetchedAt: new Date().toISOString(),
          staleAt: '2100-01-01T00:00:00.000Z',
          defaultModelId: 'claude-opus-4-8',
          defaultLaunchModel: 'claude-opus-4-8',
          models,
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
            message: null,
            code: null,
          },
        },
  };
  const runtime = path.join(root, 'deny-runtime.cjs');
  const ledger = path.join(root, 'runtime.ndjson');
  await writeFile(ledger, '');
  await writeFile(
    runtime,
    `#!${await realpath(process.execPath)}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1] || 'anthropic';
let envelope = null;
if (args[0] === 'runtime' && args[1] === 'opencode-command' && args.includes('--input')) envelope = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1], 'utf8'));
const startupCleanupDenied = envelope?.command === 'opencode.cleanupHosts' && envelope?.body?.reason === 'startup' && envelope?.body?.mode === 'stale';
const readOnlyDiscovery = (args.slice(0,3).join(':') === 'runtime:providers:directory' && args.includes('--json')) || (args.slice(0,2).join(':') === 'runtime:opencode-command' && ['opencode.handshake','opencode.readiness','opencode.commandStatus'].includes(envelope?.command));
const authProbe = JSON.stringify(args) === JSON.stringify(['-p','Output only the single word PONG.','--output-format','text','--model','haiku','--max-turns','1','--no-session-persistence']);
const isolated = process.cwd() === ${JSON.stringify(directories['sandbox-project'])};
const allowed = readOnlyDiscovery || (authProbe && isolated) || (args.length === 1 && args[0] === '--version') || (['runtime:status','auth:status','model:list'].includes(args.slice(0,2).join(':')) && args.includes('--json') && (args[0] !== 'model' || isolated));
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({args,allowed,authProbe,readOnlyDiscovery,startupCleanupDenied,bridgeCommand:envelope?.command ?? null,cwd:process.cwd()})+'\\n');
if (!allowed) { console.error('Fixture denies lifecycle/provider commands'); process.exit(77); }
if (readOnlyDiscovery) { const result = envelope ? {schemaVersion:1,requestId:envelope.requestId,command:envelope.command,ok:false,error:{code:'unsupported',message:'Offline fixture has no OpenCode'}} : {schemaVersion:1,providers:[],directory:{providers:[]},cursor:null}; if(args.includes('--output')) fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify(result)); console.log(JSON.stringify(result)); process.exit(0); }
if (authProbe) { console.log('PONG'); process.exit(0); }
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
const status = provider === 'anthropic' ? ${JSON.stringify(status)} : {...${JSON.stringify(status)},providerId:provider,supported:false,authenticated:false,models:[],defaultModel:null,modelCatalog:null,capabilities:{teamLaunch:false,oneShot:false,extensions:{}}};
if (args[0] === 'model') console.log(JSON.stringify({schemaVersion:1,providers:{[provider]:{defaultModel:status.defaultModel,models:status.models}}}));
else console.log(JSON.stringify({schemaVersion:1,provider, status, providers:{[provider]:status}}));
`
  );
  await chmod(runtime, 0o755);
  await json(path.join(directories.claude, 'agent-teams-config.json'), {
    general: {
      appLocale: 'en',
      agentLanguage: 'en',
      theme: 'dark',
      defaultTab: 'teams',
      multimodelEnabled: true,
    },
  });
  await writeFile(
    path.join(directories['sandbox-project'], 'README.md'),
    '# Disposable model selection E2E\n'
  );
  return { root, directories, runtime, ledger };
}

async function readPreflight(file: string): Promise<PreflightEvent[]> {
  const contents = await readFile(file, 'utf8').catch(() => '');
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PreflightEvent);
}

async function main(): Promise<void> {
  const test = await fixture();
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'anthropic-model-evidence-'));
  const logs: string[] = [];
  let app: ChildProcess | undefined;
  let client: Cdp | undefined;
  let inputBrowser: InputBrowser | undefined;
  try {
    const d = test.directories;
    const env = {
      ...process.env,
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: d.claude,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: d['user-data'],
      CLAUDE_CONFIG_DIR: d['claude-config'],
      CLAUDE_MULTIMODEL_DATA_HOME: d['multimodel-data'],
      CLAUDE_MULTIMODEL_CACHE_HOME: d['multimodel-cache'],
      XDG_CONFIG_HOME: d['xdg-config'],
      XDG_DATA_HOME: d['xdg-data'],
      XDG_CACHE_HOME: d['xdg-cache'],
      XDG_STATE_HOME: d['xdg-state'],
      XDG_RUNTIME_DIR: d['xdg-runtime'],
      TMPDIR: d.tmp,
      SHELL: '/bin/sh',
      NODE_BINARY: await realpath(process.execPath),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: test.runtime,
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      pnpm_config_verify_deps_before_run: 'false',
    };
    // Do not propagate external provider credentials into this offline fixture.
    for (const key of Object.keys(env))
      if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|ANTHROPIC_BASE_URL/.test(key))
        delete (env as NodeJS.ProcessEnv)[key];
    app = spawn('pnpm', ['dev:mcp'], {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    app.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    const deadline = Date.now() + 180_000;
    let target: Target | undefined;
    while (!target && Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error(`Owned dev:mcp exited (${app.exitCode})`);
      const port = logs
        .join('')
        .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//)?.[1];
      if (port) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1000),
        })
          .then((response) => response.json() as Promise<Target[]>)
          .catch(() => []);
        target = targets.find(
          (candidate) => candidate.type === 'page' && candidate.url.startsWith('http://localhost:')
        );
      }
      if (!target) await delay(200);
    }
    assert(target, 'Owned Electron renderer must report its CDP endpoint');
    client = await Cdp.connect(target.webSocketDebuggerUrl);
    const cdp = client;
    inputBrowser = await loadPlaywright().chromium.connectOverCDP(
      `http://127.0.0.1:${logs.join('').match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//)?.[1]}`
    );
    cdp.inputPage = inputBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === target.url);
    assert(cdp.inputPage, 'Owned Electron renderer input page');
    await cdp.send('Runtime.enable');
    await cdp.waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API',
      60_000
    );
    await cdp.evaluate<void>(
      `(() => { const store = window.__agentTeamsDevStore; store.setState({selectedProjectId:'anthropic-model-e2e-sandbox'}); store.getState().openTeamsTab(${JSON.stringify(d['sandbox-project'])}); })()`
    );
    // Provider polling is passive until the initial native runtime discovery completes.
    await cdp.evaluate<unknown>('window.electronAPI.cliInstaller.getStatus()');
    await cdp.waitFor(
      'window.__agentTeamsDevStore.getState().cliStatus?.binaryPath',
      'native runtime discovery'
    );
    const provider = await cdp.evaluate<{
      defaultModel: string | null;
      modelCatalog: { source: string; status: string; models: { launchModel: string }[] } | null;
      modelCatalogRefreshState: string;
    }>("window.electronAPI.cliInstaller.getProviderStatus('anthropic')");
    const defaultNoCatalog = process.argv.includes('--default-no-catalog');
    if (defaultNoCatalog) {
      assert.equal(provider.defaultModel, 'claude-opus-5-5');
      assert.equal(provider.modelCatalog, null);
    } else {
      assert.equal(provider.modelCatalog?.source, 'anthropic-models-api');
      assert.equal(provider.modelCatalog?.status, 'ready');
      assert.equal(provider.modelCatalogRefreshState, 'ready');
    }
    // Stage the authoritative native snapshot so background provider discovery
    // does not race this isolated renderer fixture's catalog hydration.
    await cdp.evaluate<void>(
      `(() => { const store=window.__agentTeamsDevStore; const state=store.getState(); const provider=${JSON.stringify(provider)}; store.setState({cliStatus:{...state.cliStatus,providers:[provider,...(state.cliStatus?.providers || []).filter(p=>p.providerId !== 'anthropic')]}}); })()`
    );
    assert(
      defaultNoCatalog ||
        provider.modelCatalog?.models.some((entry) => entry.launchModel === 'claude-opus-5-5')
    );
    const results: unknown[] = [{ catalog: provider.modelCatalog }];
    if (defaultNoCatalog) {
      console.log('Checking runtime Default with no catalog off/on');
      await cdp.waitFor(
        '!window.__agentTeamsDevStore.getState().teamsLoading',
        'hydrated Teams view'
      );
      await delay(200);
      await cdp.click(button('Create Team'));
      await cdp.waitFor(dialog, 'Create dialog');
      await cdp.fill('#team-name', 'model-e2e-default-no-catalog');
      if (
        !(await cdp.evaluate<boolean>(
          "document.querySelector('#solo-team')?.getAttribute('aria-checked') === 'true'"
        ))
      )
        await cdp.click("document.querySelector('#solo-team')");
      await cdp.click(
        `Array.from(${dialog}.querySelectorAll('button')).find(e => /provider,/.test(e.getAttribute('aria-label') || ''))`
      );
      await cdp.click(
        `Array.from(document.querySelectorAll('[data-testid="team-model-selector-model-option"]')).find(e => e.textContent.trim().startsWith('Default'))`
      );
      for (const limit of [false, true]) {
        const selector = "document.querySelector('#lead-limit-context')";
        if (
          (await cdp.evaluate<boolean>(`${selector}?.getAttribute('aria-checked') === 'true'`)) !==
          limit
        )
          await cdp.click(selector);
        await cdp.waitFor(
          `${selector}?.getAttribute('aria-checked') === '${limit}'`,
          'context toggle'
        );
        const expected = 'claude-opus-5-5';
        const selected = await cdp.evaluate<string>(
          "document.querySelector('#lead-model')?.textContent.trim()"
        );
        assert.equal(selected, 'Default', 'Default selection must survive context toggle');
        await cdp.waitFor(
          `document.querySelector('[role=dialog]').innerText.includes('The verified model catalog is unavailable or stale')`,
          'missing catalog launch gate'
        );
        const preflightPath = path.join(d.tmp, 'claude-team-preflight-debug.log');
        const preflightDeadline = Date.now() + 30_000;
        let observed: PreflightEvent | undefined;
        while (Date.now() < preflightDeadline) {
          observed = (await readPreflight(preflightPath)).findLast(
            (event) =>
              event.event === 'provider_model_catalog_check_complete' &&
              event.modelIds?.includes('__provider_default__') &&
              event.details?.includes(
                'Selected model __provider_default__ is available for launch.'
              )
          );
          if (observed) break;
          await delay(150);
        }
        assert(observed, `Real main preflight must preserve runtime Default ${expected}`);
        assert.deepEqual(observed.blockingMessages, []);
        results.push({ selection: 'default', limit, preflight: observed });
      }
      await cdp.click("document.querySelector('#launch-team')");
      await cdp.waitFor(
        "document.querySelector('#launch-team')?.getAttribute('aria-checked') === 'false'",
        'config-only create'
      );
      await cdp.click(button('Create', dialog));
      await cdp.waitFor(`!${dialog}`, 'created Default config-only team');
      const name = 'model-e2e-default-no-catalog';
      const saved = await cdp.evaluate<SavedRequest>(
        `window.electronAPI.teams.getSavedRequest(${JSON.stringify(name)})`
      );
      assert.equal(saved.model, 'claude-opus-5-5');
      assert.equal(saved.providerId, 'anthropic');
      assert.equal(saved.limitContext, true);
      results.push({ name, saved });
    }
    for (const [model, label] of defaultNoCatalog
      ? []
      : ([
          ['claude-opus-5', 'Opus 5'],
          ['claude-opus-5-5', 'Opus 5.5'],
        ] as const)) {
      console.log(`Checking ${label} off/on/off`);
      await cdp.waitFor(
        '!window.__agentTeamsDevStore.getState().teamsLoading',
        'hydrated Teams view'
      );
      await delay(200);
      await cdp.click(button('Create Team'));
      await cdp.waitFor(dialog, 'Create dialog');
      await cdp.fill('#team-name', `model-e2e-${model.replaceAll('claude-', '')}`);
      if (
        !(await cdp.evaluate<boolean>(
          "document.querySelector('#solo-team')?.getAttribute('aria-checked') === 'true'"
        ))
      )
        await cdp.click("document.querySelector('#solo-team')");
      await cdp.click(
        `Array.from(${dialog}.querySelectorAll('button')).find(e => /provider,/.test(e.getAttribute('aria-label') || ''))`
      );
      await cdp.click(
        `Array.from(document.querySelectorAll('[data-testid="team-model-selector-model-option"]')).find(e => e.textContent.trim() === ${JSON.stringify(label)})`
      );
      for (const limit of [false, true, false]) {
        const selector = "document.querySelector('#lead-limit-context')";
        if (
          (await cdp.evaluate<boolean>(`${selector}?.getAttribute('aria-checked') === 'true'`)) !==
          limit
        )
          await cdp.click(selector);
        await cdp.waitFor(
          `${selector}?.getAttribute('aria-checked') === '${limit}'`,
          'context toggle'
        );
        const selected = await cdp.evaluate<string>(
          "document.querySelector('#lead-model')?.textContent.trim()"
        );
        assert.equal(selected, label, 'Visible selection must survive context toggle');
        const expected = limit ? model : `${model}[1m]`;
        const visiblePreflight = `${label}${limit ? '' : ' (1M)'} - Selected model `;
        await cdp.waitFor(
          `document.querySelector('[role=dialog]').innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(visiblePreflight)} + 'verified') || document.querySelector('[role=dialog]').innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(visiblePreflight)} + 'available')`,
          'current visible preflight model'
        );
        const preflightPath = path.join(d.tmp, 'claude-team-preflight-debug.log');
        const preflightDeadline = Date.now() + 30_000;
        let observed: PreflightEvent | undefined;
        while (Date.now() < preflightDeadline) {
          observed = (await readPreflight(preflightPath)).findLast(
            (event) =>
              event.event === 'provider_model_catalog_check_complete' &&
              event.modelIds?.includes(expected) &&
              event.details?.includes(`Selected model ${expected} is available for launch.`)
          );
          if (observed) break;
          await delay(150);
        }
        assert(observed, `Real main preflight must validate ${expected}`);
        assert.deepEqual(observed.blockingMessages, []);
        assert.equal(observed.cwd, d['sandbox-project']);
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(
          path.join(evidence, `${model}-${limit ? '200k' : '1m'}-${results.length}.png`),
          Buffer.from(screenshot.data as string, 'base64')
        );
        results.push({ model, limit, selected, preflight: observed });
      }
      // Save one model with 200K enabled, and the other with 1M enabled.
      const finalLimit = model === 'claude-opus-5';
      if (finalLimit) await cdp.click("document.querySelector('#lead-limit-context')");
      const persistedModel = finalLimit ? model : `${model}[1m]`;
      // The real Create button must call native createConfig, not launch.
      if (finalLimit) {
        await cdp.waitFor(
          `document.querySelector('[role=dialog]').innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(label + ' - Selected model verified')}) || document.querySelector('[role=dialog]').innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(label + ' - Selected model available')})`,
          'final 200K preflight'
        );
      }
      await cdp.click("document.querySelector('#launch-team')");
      await cdp.waitFor(
        "document.querySelector('#launch-team')?.getAttribute('aria-checked') === 'false'",
        'config-only create'
      );
      await cdp.click(button('Create', dialog));
      await cdp.waitFor(`!${dialog}`, 'created config-only team');
      const name = `model-e2e-${model.replaceAll('claude-', '')}`;
      const saved = await cdp.evaluate<SavedRequest>(
        `window.electronAPI.teams.getSavedRequest(${JSON.stringify(name)})`
      );
      assert.equal(
        saved.model,
        persistedModel,
        'Real IPC persisted model must match final selected generation'
      );
      assert.equal(saved.providerId, 'anthropic');
      assert.equal(saved.limitContext, finalLimit);
      const meta = JSON.parse(
        await readFile(path.join(d.claude, 'teams', name, 'team.meta.json'), 'utf8')
      ) as SavedRequest;
      assert.equal(meta.model, persistedModel);
      results.push({ name, saved, diskModel: meta.model });
      await cdp.evaluate<void>(
        `(() => { const store = window.__agentTeamsDevStore; store.setState({selectedProjectId:'anthropic-model-e2e-sandbox'}); store.getState().openTeamsTab(${JSON.stringify(d['sandbox-project'])}); })()`
      );
    }
    const ledger = (await readFile(test.ledger, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; allowed: boolean; startupCleanupDenied: boolean }
      );
    assert(ledger.length > 0, 'Fixture runtime must have served real status/preflight');
    assert(
      ledger.every((entry) => entry.allowed || entry.startupCleanupDenied),
      'No workflow lifecycle/provider command may be attempted; app startup cleanup must remain blocked'
    );
    assert(ledger.filter((entry) => entry.startupCleanupDenied).every((entry) => !entry.allowed));
    await json(path.join(evidence, 'result.json'), { ok: true, results, ledger });
    console.log(JSON.stringify({ ok: true, evidence, fixture: test.root }));
  } catch (error) {
    if (client) {
      await writeFile(
        path.join(evidence, 'failure.txt'),
        (await client.evaluate<string>('document.body.innerText').catch(() => '')) +
          '\n' +
          String(error)
      );
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot)
        await writeFile(
          path.join(evidence, 'failure.png'),
          Buffer.from(shot.data as string, 'base64')
        );
    }
    console.error(`Evidence: ${evidence}; fixture: ${test.root}`);
    throw error;
  } finally {
    await writeFile(path.join(evidence, 'app.log'), logs.join(''));
    await writeFile(path.join(evidence, 'runtime.ndjson'), await readFile(test.ledger, 'utf8'));
    await writeFile(
      path.join(evidence, 'preflight.ndjson'),
      await readFile(
        path.join(test.directories.tmp, 'claude-team-preflight-debug.log'),
        'utf8'
      ).catch(() => '')
    );
    await inputBrowser?.close().catch(() => undefined);
    client?.close();
    if (app?.pid) {
      try {
        process.kill(process.platform === 'win32' ? app.pid : -app.pid, 'SIGKILL');
      } catch {
        /* owned process already exited */
      }
      await delay(500);
    }
    if (process.env.ANTHROPIC_MODEL_E2E_KEEP !== '1')
      await rm(test.root, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
