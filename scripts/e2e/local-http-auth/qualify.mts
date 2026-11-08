// Exercises the real dev:mcp renderer; run.mts owns the app and display lifecycle.
// CDP request/evaluate/callFunctionOn conventions follow scripts/e2e/announcements/cdp.mjs.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class QualificationFailure extends Error {}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new QualificationFailure(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function textField(value: unknown, key: string): string {
  check(record(value) && typeof value[key] === 'string', `Missing scalar ${key}`);
  return value[key];
}
function callable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}
const hash = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const modulePaths = [
  'src/features/local-http-auth/main/infrastructure/privateFiles.ts',
  'src/features/local-http-auth/main/infrastructure/discoveryReference.ts',
  'src/features/local-http-auth/core/domain/authority.ts',
  'src/features/local-http-auth/renderer/browserSession.ts',
  'src/features/local-http-auth/renderer/fetchEventStream.ts',
  'src/features/local-http-auth/renderer/ui/BrowserAccessGate.tsx',
  'src/features/local-http-auth/main/infrastructure/readiness.ts',
  'src/features/local-http-auth/main/infrastructure/authorityStore.ts',
  'src/main/services/team/TeamControlApiState.ts',
  'src/main/utils/electronDevPathOverrides.ts',
  'src/main/services/infrastructure/ConfigManager.ts',
  'src/main/http/config.ts',
  'src/main/http/events.ts',
  'src/renderer/api/httpClient.ts',
  'src/renderer/api/index.ts',
  'src/renderer/main.tsx',
  'src/renderer/index.html',
  'src/renderer/rendererBootstrap.ts',
  'src/renderer/App.tsx',
  'src/main/services/infrastructure/HttpServer.ts',
  'src/main/services/infrastructure/HttpServerAuth.ts',
  'src/main/services/infrastructure/FileWatcher.ts',
  'src/main/index.ts',
  'src/preload/index.ts',
  'dist-electron/main/index.cjs',
  'dist-electron/preload/index.js',
  'electron.vite.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'runtime.lock.json',
  'terminal-platform.lock.json',
] as const;

async function directory(file: string, owned = false): Promise<void> {
  check(
    path.isAbsolute(file) && path.resolve(file) === file && (await realpath(file)) === file,
    'Noncanonical directory'
  );
  let cursor = file;
  while (true) {
    const stat = await lstat(cursor);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked directory');
    if (cursor === file && owned)
      check(stat.uid === process.getuid?.() && !(stat.mode & 0o022), 'Unowned test directory');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function below(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function loopbackOrigin(value: string, protocols: string[]): URL {
  const url = new URL(value);
  check(
    protocols.includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.origin === value &&
      !url.username &&
      !url.password,
    'Expected exact loopback origin'
  );
  return url;
}
async function durable(file: string, value: unknown): Promise<void> {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function until(test: () => Promise<boolean>, label: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  do {
    if (await test()) return;
    await pause(150);
  } while (Date.now() < end);
  throw new QualificationFailure(label);
}

export class Cdp {
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly counts = new Map<string, number>();
  readonly activeSseRequests = new Set<string>();
  readonly responses: Array<{ path: string; status: number; corsHeaderPresent: boolean }> = [];
  readonly corsFailures: string[] = [];
  readonly rendererFailures: string[] = [];
  credentialUrlDetected = false;
  private rendererNetworkEnableRequested = false;
  private rendererNetworkEnableAcknowledged = false;
  private rendererNetworkLimitReached = false;
  private rendererNetworkPending = new Map<
    string,
    { type: 'Script' | 'Stylesheet'; pathnameSha256: string }
  >();
  private rendererNetworkFailed: Array<{ type: 'Script' | 'Stylesheet'; pathnameSha256: string }> =
    [];
  private rendererNetworkCounts = {
    Script: { observed: 0, finished: 0, failed: 0, redirectedAway: 0 },
    Stylesheet: { observed: 0, finished: 0, failed: 0, redirectedAway: 0 },
  };
  rendererNetworkSnapshot(): object {
    const pending = [...this.rendererNetworkPending.values()];
    return {
      observedAfterNetworkEnable: this.rendererNetworkEnableRequested,
      networkEnableAcknowledged: this.rendererNetworkEnableAcknowledged,
      listenerAttachedBeforeEnable: true,
      coverageLimit:
        'only events observed after Network.enable request; earlier and unreported in-flight requests unknown',
      exactRendererOriginOnly: true,
      trackingLimitReached: this.rendererNetworkLimitReached,
      Script: {
        ...this.rendererNetworkCounts.Script,
        pending: pending.filter((value) => value.type === 'Script').length,
      },
      Stylesheet: {
        ...this.rendererNetworkCounts.Stylesheet,
        pending: pending.filter((value) => value.type === 'Stylesheet').length,
      },
      pendingPathHashes: pending.slice(0, 20),
      failedPathHashes: [...this.rendererNetworkFailed],
    };
  }
  private observeRendererNetwork(message: Record<string, unknown>): void {
    if (!this.rendererNetworkEnableRequested || !record(message.params)) return;
    const params = message.params;
    if (typeof params.requestId !== 'string' || params.requestId.length > 128) return;
    const requestId = params.requestId;
    if (
      message.method === 'Network.requestWillBeSent' &&
      record(params.request) &&
      typeof params.request.url === 'string'
    ) {
      // CDP redirects reuse the request ID. Retire only that observed diagnostic
      // record if it leaves the exact owned renderer origin or resource class.
      let url: URL;
      try {
        url = new URL(params.request.url);
      } catch {
        return;
      }
      const previous = this.rendererNetworkPending.get(requestId);
      if (
        url.origin !== this.rendererOrigin ||
        url.username ||
        url.password ||
        !['Script', 'Stylesheet'].includes(params.type as string)
      ) {
        if (previous) {
          this.rendererNetworkPending.delete(requestId);
          const counts = this.rendererNetworkCounts[previous.type];
          counts.redirectedAway = Math.min(65535, counts.redirectedAway + 1);
        }
        return;
      }
      const type = params.type as 'Script' | 'Stylesheet';
      if (!previous) {
        const counts = this.rendererNetworkCounts[type];
        counts.observed = Math.min(65535, counts.observed + 1);
        if (this.rendererNetworkPending.size >= 256) {
          this.rendererNetworkLimitReached = true;
          return;
        }
      }
      // Query, fragment, headers, response/error text and raw URLs never survive.
      this.rendererNetworkPending.set(requestId, { type, pathnameSha256: hash(url.pathname) });
    } else if (
      message.method === 'Network.loadingFailed' ||
      message.method === 'Network.loadingFinished'
    ) {
      const item = this.rendererNetworkPending.get(requestId);
      if (!item) return; // No origin can be inferred from an unobserved request.
      this.rendererNetworkPending.delete(requestId);
      const counts = this.rendererNetworkCounts[item.type];
      if (message.method === 'Network.loadingFailed') {
        counts.failed = Math.min(65535, counts.failed + 1);
        if (this.rendererNetworkFailed.length < 20) this.rendererNetworkFailed.push(item);
      } else counts.finished = Math.min(65535, counts.finished + 1);
    }
  }
  private constructor(
    private socket: WebSocket,
    private apiOrigin: string,
    private rendererOrigin: string
  ) {
    socket.addEventListener('message', (event) => {
      try {
        check(typeof event.data === 'string', 'Nontext CDP frame');
        const message: unknown = JSON.parse(event.data);
        if (!record(message)) return;
        this.observeRendererNetwork(message);
        if (
          message.method === 'Network.requestWillBeSent' &&
          record(message.params) &&
          record(message.params.request) &&
          typeof message.params.request.url === 'string'
        ) {
          const url = new URL(message.params.request.url);
          if (
            message.params.request.method === 'GET' &&
            url.origin === this.apiOrigin &&
            url.pathname === '/api/events' &&
            typeof message.params.requestId === 'string'
          )
            this.activeSseRequests.add(message.params.requestId);
          if (
            url.origin === this.apiOrigin &&
            (url.username ||
              url.password ||
              /(?:access_token|token|key)=/i.test(url.search + url.hash))
          )
            this.credentialUrlDetected = true;
          if (
            message.params.request.method !== 'OPTIONS' &&
            url.origin === this.apiOrigin &&
            url.pathname.startsWith('/api/')
          )
            this.counts.set(url.pathname, (this.counts.get(url.pathname) ?? 0) + 1);
        }
        if (
          (message.method === 'Network.loadingFailed' ||
            message.method === 'Network.loadingFinished') &&
          record(message.params) &&
          typeof message.params.requestId === 'string'
        )
          this.activeSseRequests.delete(message.params.requestId);
        if (
          message.method === 'Network.responseReceived' &&
          record(message.params) &&
          record(message.params.response) &&
          typeof message.params.response.url === 'string' &&
          typeof message.params.response.status === 'number'
        ) {
          const response = message.params.response,
            url = new URL(response.url as string);
          if (
            url.origin === this.apiOrigin &&
            url.pathname.startsWith('/api/') &&
            this.responses.length < 40
          )
            this.responses.push({
              path: url.pathname,
              status: response.status as number,
              corsHeaderPresent:
                record(response.headers) &&
                Object.keys(response.headers).some(
                  (name) => name.toLowerCase() === 'access-control-allow-origin'
                ),
            });
        }
        if (
          message.method === 'Network.loadingFailed' &&
          record(message.params) &&
          record(message.params.corsErrorStatus) &&
          this.corsFailures.length < 10
        ) {
          const error = message.params.corsErrorStatus.corsError;
          this.corsFailures.push(
            typeof error === 'string' &&
              [
                'MissingAllowOriginHeader',
                'PreflightMissingAllowOriginHeader',
                'AllowOriginMismatch',
                'PreflightAllowOriginMismatch',
              ].includes(error)
              ? error
              : 'other-cors-error'
          );
        }
        // Keep only normalized classes: console/exception payloads may contain secrets.
        if (
          message.method === 'Runtime.exceptionThrown' ||
          (message.method === 'Runtime.consoleAPICalled' &&
            record(message.params) &&
            message.params.type === 'error')
        ) {
          const code =
            message.method === 'Runtime.exceptionThrown'
              ? 'renderer-exception'
              : 'renderer-console-error';
          if (!this.rendererFailures.includes(code)) this.rendererFailures.push(code);
        }
        if (typeof message.id !== 'number') return;
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error('CDP command refused'));
        else item.resolve(message.result);
      } catch {
        this.fail();
      }
    });
    socket.addEventListener('close', () => this.fail());
    socket.addEventListener('error', () => this.fail());
  }
  static async connect(endpoint: string, origin: string, rendererOrigin: string): Promise<Cdp> {
    loopbackOrigin(rendererOrigin, ['http:']);
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('CDP connection timeout'));
      }, 10_000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connection failed'));
        },
        { once: true }
      );
    });
    return new Cdp(socket, origin, rendererOrigin);
  }
  private fail(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP connection ended'));
    }
    this.pending.clear();
  }
  send(method: string, params: object = {}): Promise<unknown> {
    if (method === 'Network.enable') this.rendererNetworkEnableRequested = true;
    const promise = new Promise<unknown>((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP observation deadline'));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return method === 'Network.enable'
      ? promise.then((result) => {
          this.rendererNetworkEnableAcknowledged = true;
          return result;
        })
      : promise;
  }
  private value(result: unknown): unknown {
    check(
      record(result) && !result.exceptionDetails && record(result.result),
      'Renderer command failed'
    );
    return result.result.value;
  }
  async inspect(expression: string): Promise<unknown> {
    return this.value(
      await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    );
  }
  async call(fn: (...args: never[]) => unknown, values: unknown[] = []): Promise<unknown> {
    const body = fn.toString();
    check(
      !body.includes('__name(') && !body.includes('__awaiter('),
      'Browser function depends on a transform helper'
    );
    const declaration = `function (...args) { return (${body})(...args); }`;
    const global = await this.send('Runtime.evaluate', {
      expression: 'globalThis',
    });
    check(record(global) && record(global.result), 'Missing renderer context');
    const objectId = textField(global.result, 'objectId');
    try {
      return this.value(
        await this.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: declaration,
          arguments: values.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        })
      );
    } finally {
      await this.send('Runtime.releaseObject', { objectId });
    }
  }
  close(): void {
    this.fail();
    this.socket.close();
  }
}

// Each browser function is self-contained: toString() is sent only to the owned renderer.
// No source token enters an expression, persisted message or diagnostic response.
interface Access {
  getSnapshot(): string;
  clear(): void;
}
interface Client {
  config: { get(): Promise<{ general: { theme: string } }> };
  onFileChange(callback: (event: unknown) => void): () => void;
  dispose(): void;
}
interface Probe {
  session: Access;
  client: Client;
  events: Array<{ path: string; projectId: string; sessionId: string }>;
  first: number;
  second: number;
  unsub: Array<() => void>;
}
declare global {
  interface Window {
    __ownedDesktopAuthProbe?: Probe;
  }
}
async function installBrowserProbe(baseUrl: string): Promise<string> {
  if (window.__ownedDesktopAuthProbe || 'electronAPI' in window)
    throw new Error('Not a fresh browser App context');
  const resource = performance
    .getEntriesByType('resource')
    .find((entry) => new URL(entry.name).pathname.endsWith('/api/index.ts'));
  if (!resource || new URL(resource.name).origin !== location.origin)
    throw new Error('Loaded production API entrypoint missing');
  const apiModule: unknown = await import(resource.name);
  if (
    !apiModule ||
    typeof apiModule !== 'object' ||
    !('api' in apiModule) ||
    !('getHttpAccessSession' in apiModule) ||
    typeof apiModule.getHttpAccessSession !== 'function' ||
    !('getHttpBaseUrl' in apiModule) ||
    typeof apiModule.getHttpBaseUrl !== 'function' ||
    apiModule.getHttpBaseUrl() !== baseUrl
  )
    throw new Error('Browser API entrypoint contract mismatch');
  const session = apiModule.getHttpAccessSession() as Access;
  const client = apiModule.api as Client;
  if (
    session !== apiModule.getHttpAccessSession() ||
    !document.querySelector('#root #api-access-key')
  )
    throw new Error('App gate does not use the shared browser session');
  const probe: Probe = {
    session,
    client,
    events: [],
    first: 0,
    second: 0,
    unsub: [],
  };
  window.__ownedDesktopAuthProbe = probe;
  probe.unsub.push(
    client.onFileChange((value) => {
      ++probe.first;
      if (
        value &&
        typeof value === 'object' &&
        'path' in value &&
        typeof value.path === 'string' &&
        'projectId' in value &&
        typeof value.projectId === 'string' &&
        'sessionId' in value &&
        typeof value.sessionId === 'string' &&
        probe.events.length < 20
      )
        probe.events.push({
          path: value.path,
          projectId: value.projectId,
          sessionId: value.sessionId,
        });
    }),
    client.onFileChange(() => {
      ++probe.second;
    })
  );
  let denied = false;
  try {
    await client.config.get();
  } catch {
    denied = true;
  }
  if (!denied || session.getSnapshot() !== 'required')
    throw new Error('Missing-key browser gate failed');
  return session.getSnapshot();
}
async function inspectBrowserKey(key: string, expected: string): Promise<string> {
  const probe = window.__ownedDesktopAuthProbe;
  if (!probe || probe.session.getSnapshot() !== expected)
    throw new Error('Browser key state mismatch');
  if (expected === 'expired' && !document.querySelector('#root [role=alert]'))
    throw new Error('App auth error UI missing');
  if (expected === 'ready') {
    const config = await probe.client.config.get();
    if (
      config.general.theme !== 'dark' ||
      JSON.stringify(config).includes(key) ||
      document.querySelector('#api-access-key') ||
      !document.querySelector('#root button[aria-label=\"New tab\"]')
    )
      throw new Error('Authorized browser App did not mount');
  }
  return probe.session.getSnapshot();
}
async function enterBrowserKey(cdp: Cdp, key: string, expected: string): Promise<unknown> {
  check(
    await cdp.inspect(
      "(() => { document.querySelector('#api-access-key')?.focus(); return document.activeElement?.id === 'api-access-key'; })()"
    ),
    'Browser key input is unavailable'
  );
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.insertText', { text: key });
  const submit = await cdp.inspect(
    "(() => { const button = document.querySelector('#api-access-key')?.form?.querySelector('button[type=submit]'); if (!button || button.disabled) return null; button.scrollIntoView({ block: 'center' }); const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()"
  );
  check(
    record(submit) && typeof submit.x === 'number' && typeof submit.y === 'number',
    'App key form submit button unavailable'
  );
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: submit.x,
    y: submit.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: submit.x,
    y: submit.y,
    button: 'left',
    clickCount: 1,
  });
  await until(
    async () =>
      (await cdp.inspect('window.__ownedDesktopAuthProbe.session.getSnapshot()')) === expected,
    'Browser form did not reach expected auth state: ' + expected
  );
  await until(
    async () =>
      (await cdp.inspect(
        expected === 'ready'
          ? "!document.querySelector('#api-access-key') && !!document.querySelector('#root button[aria-label=\"New tab\"]')"
          : "!!document.querySelector('#root [role=alert]')"
      )) === true,
    'Browser App did not render auth result'
  );
  return cdp.call(inspectBrowserKey, [key, expected]);
}
function retireBrowserProbe(): object {
  const probe = window.__ownedDesktopAuthProbe;
  if (!probe) return { installed: false };
  probe.session.clear();
  probe.unsub.forEach((unsub) => unsub());
  probe.client.dispose();
  return {
    installed: true,
    state: probe.session.getSnapshot(),
    first: probe.first,
    second: probe.second,
  };
}

export async function qualify(args: unknown): Promise<boolean> {
  check(record(args), 'Invalid binding');
  const run = textField(args, 'runRoot'),
    checkout = textField(args, 'checkout'),
    profile = textField(args, 'claudeRoot'),
    out = textField(args, 'out');
  const apiOrigin = textField(args, 'httpOrigin'),
    rendererOrigin = textField(args, 'rendererOrigin'),
    cdpOrigin = textField(args, 'cdpOrigin'),
    browserCdpOrigin = textField(args, 'browserCdpOrigin');
  loopbackOrigin(apiOrigin, ['http:']);
  loopbackOrigin(rendererOrigin, ['http:']);
  loopbackOrigin(cdpOrigin, ['http:']);
  loopbackOrigin(browserCdpOrigin, ['http:']);
  check(
    typeof args.desktopStartupDeadline === 'number' &&
      Number.isSafeInteger(args.desktopStartupDeadline) &&
      args.desktopStartupDeadline > 0 &&
      args.desktopStartupDeadline <= Date.now() + 240_000,
    'Invalid desktop startup deadline'
  );
  const desktopStartupDeadline = args.desktopStartupDeadline;
  await directory(run, true);
  await directory(checkout);
  await directory(profile, true);
  check(below(run, profile) && below(run, out), 'Profile/output outside owned run');
  check(record(args.sourceHashes), 'Require exact source bindings');
  async function sourceBinding(): Promise<void> {
    check(record(args) && record(args.sourceHashes), 'Invalid source binding');
    for (const relative of modulePaths) {
      const expected = args.sourceHashes[relative];
      check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'Missing source hash');
      const file = path.join(checkout, relative);
      await directory(path.dirname(file));
      const stat = await lstat(file);
      check(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          stat.size < 67_108_864 &&
          hash(await readFile(file)) === expected,
        'Source binding changed'
      );
    }
  }
  await sourceBinding();
  await directory(path.dirname(out), true);
  await mkdir(out, { mode: 0o700 });
  const passed: string[] = [],
    denied: Array<{ path: string; authorization: string; status: number }> = [];
  let desktopCdp: Cdp | undefined;
  let desktopUiReadyElapsedMs: number | null = null;
  let cdp: Cdp | undefined,
    phase = 'authority',
    succeeded = false,
    failure: string | null = null,
    failureCode: string | null = null;
  await durable(path.join(out, 'BEFORE.json'), {
    checkout,
    profile,
    apiOrigin,
    rendererOrigin,
    cdpOrigin,
    browserCdpOrigin,
    sourceHashes: args.sourceHashes,
    driverSha256: hash(await readFile(new URL(import.meta.url))),
    appLaunchPerformed: true,
  });
  try {
    async function exportsAt(relative: string): Promise<Record<string, unknown>> {
      const module: unknown = await import(pathToFileURL(path.join(checkout, relative)).href);
      check(record(module), 'Production reader missing');
      return module;
    }
    const storage = await exportsAt(modulePaths[0]),
      discovery = await exportsAt(modulePaths[1]),
      domain = await exportsAt(modulePaths[2]);
    check(
      callable(storage.validateProfileRoot) &&
        callable(storage.readPrivateJson) &&
        callable(discovery.validateDiscoveryReference) &&
        callable(domain.validateAuthority),
      'Production authority exports missing'
    );
    await storage.validateProfileRoot(profile);
    const scope = hash(profile),
      reference = discovery.validateDiscoveryReference(
        await storage.readPrivateJson(path.join(profile, 'team-control-api.json')),
        profile,
        scope
      );
    check(record(reference), 'Invalid reference result');
    const authority = domain.validateAuthority(
      await storage.readPrivateJson(textField(reference, 'descriptorPath')),
      scope
    );
    check(
      record(authority) &&
        textField(authority, 'baseUrl') === apiOrigin &&
        textField(authority, 'generation') === textField(reference, 'generation') &&
        textField(authority, 'instanceId') === textField(reference, 'instanceId'),
      'Authority/reference mismatch'
    );
    const token = textField(authority, 'token'),
      wrong = (token[0] === '0' ? '1' : '0') + token.slice(1);
    const targetsResponse = await fetch(`${cdpOrigin}/json/list`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    check(targetsResponse.ok, 'CDP discovery failed');
    const targets: unknown = await targetsResponse.json();
    check(Array.isArray(targets), 'Invalid CDP targets');
    const matches = targets.filter(
      (item: unknown) =>
        record(item) &&
        item.type === 'page' &&
        typeof item.url === 'string' &&
        new URL(item.url).origin === rendererOrigin
    );
    check(matches.length === 1, 'Renderer selection is ambiguous');
    const target: unknown = matches[0];
    const websocket = textField(target, 'webSocketDebuggerUrl');
    const ws = new URL(websocket),
      cdpHttp = new URL(cdpOrigin);
    check(
      ws.protocol === 'ws:' &&
        ws.hostname === cdpHttp.hostname &&
        ws.port === cdpHttp.port &&
        !ws.username &&
        !ws.password,
      'Foreign CDP websocket'
    );
    cdp = await Cdp.connect(websocket, apiOrigin, rendererOrigin);
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    check((await cdp.inspect('location.origin')) === rendererOrigin, 'Renderer origin changed');
    phase = 'desktop-ipc';
    check(Date.now() < desktopStartupDeadline, 'Desktop startup deadline expired');
    await until(
      async () => {
        if (Date.now() >= desktopStartupDeadline) return false;
        return (
          cdp
            ?.inspect(
              "!!window.electronAPI && !!document.querySelector('#root')?.children.length && !document.querySelector('#splash')"
            )
            .then((value) => value === true && Date.now() <= desktopStartupDeadline) ?? false
        );
      },
      'Desktop UI not ready',
      Math.max(0, desktopStartupDeadline - Date.now())
    );
    desktopUiReadyElapsedMs = Math.max(0, Date.now() - (desktopStartupDeadline - 240_000));
    check(
      (await cdp.inspect(
        "!document.getElementById('api-access-key') && document.querySelector('#root').getBoundingClientRect().width > 0 && !!document.querySelector('#root button[aria-label=\"New tab\"]')"
      )) === true,
      'Desktop UI is hidden or requires API key'
    );
    check(
      (await cdp.inspect(
        'window.electronAPI.config.getClaudeRootInfo().then(info => info.resolvedPath)'
      )) === profile,
      'Renderer uses a different Claude profile'
    );
    check(
      (await cdp.inspect('window.electronAPI.config.get().then(c => c.general.theme)')) === 'dark',
      'Seeded IPC config mismatch'
    );
    check(
      (await cdp.inspect(
        "window.electronAPI.config.update('general', {theme:'light'}).then(c => c.general.theme)"
      )) === 'light',
      'IPC mutation failed'
    );
    check(
      (await cdp.inspect(
        "window.electronAPI.config.update('general', {theme:'dark'}).then(c => c.general.theme)"
      )) === 'dark',
      'IPC restore failed'
    );
    const configFile = path.join(profile, 'agent-teams-config.json');
    async function persistedTheme(): Promise<string> {
      const config: unknown = JSON.parse(await readFile(configFile, 'utf8'));
      check(record(config) && record(config.general), 'Invalid config');
      return textField(config.general, 'theme');
    }
    await until(async () => (await persistedTheme()) === 'dark', 'IPC config not persisted');
    passed.push(phase);
    phase = 'http-ingress';
    async function request(
      method: string,
      route: string,
      headers: Record<string, string> = {},
      body?: string
    ): Promise<{ status: number; body: string; type: string; allowedOrigin: string }> {
      const url = new URL(route, apiOrigin);
      check(url.origin === apiOrigin && route.startsWith('/api/'), 'Foreign HTTP route');
      return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers }, (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65_536) {
              res.destroy();
              reject(new Error('HTTP response too large'));
            } else chunks.push(chunk);
          });
          res.on('end', () => {
            clearTimeout(timer);
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              type: String(res.headers['content-type'] ?? ''),
              allowedOrigin: String(res.headers['access-control-allow-origin'] ?? ''),
            });
          });
          res.on('error', () => {
            clearTimeout(timer);
            reject(new Error('HTTP response failed'));
          });
        });
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error('HTTP observation deadline'));
        }, 5000);
        req.on('error', () => {
          clearTimeout(timer);
          reject(new Error('HTTP request failed'));
        });
        req.end(body);
      });
    }
    const baseline = hash(await readFile(configFile));
    for (const authorization of ['missing', 'wrong'])
      for (const route of ['/api/auth/ready', '/api/config', '/api/projects', '/api/events']) {
        const result = await request(
          'GET',
          route,
          authorization === 'missing' ? {} : { Authorization: `Bearer ${wrong}` }
        );
        check(
          result.status === 401 &&
            !result.type.startsWith('text/event-stream') &&
            !result.body.includes(token) &&
            !result.body.includes('"data"'),
          'Unauthorized read exposed data'
        );
        denied.push({ path: route, authorization, status: result.status });
      }
    // Trusted cross-origin browser clients must be able to observe rejection status.
    // A 401 without this header becomes a fetch network failure instead of expired.
    for (const authorization of ['missing', 'wrong']) {
      const result = await request('GET', '/api/auth/ready', {
        Origin: rendererOrigin,
        ...(authorization === 'wrong' ? { Authorization: `Bearer ${wrong}` } : {}),
      });
      check(
        result.status === 401 && result.allowedOrigin === rendererOrigin,
        'Trusted-Origin auth rejection is not readable by browser'
      );
      denied.push({
        path: '/api/auth/ready',
        authorization: authorization + '-trusted-origin',
        status: result.status,
      });
    }
    const update = JSON.stringify({
      section: 'general',
      data: { theme: 'light' },
    });
    for (const authorization of ['missing', 'wrong']) {
      const result = await request(
        'POST',
        '/api/config/update',
        {
          'Content-Type': 'application/json',
          ...(authorization === 'wrong' ? { Authorization: `Bearer ${wrong}` } : {}),
        },
        update
      );
      check(result.status === 401, 'Unauthorized mutation admitted');
    }
    await pause(400);
    check(
      hash(await readFile(configFile)) === baseline &&
        (await cdp.inspect('window.electronAPI.config.get().then(c => c.general.theme)')) ===
          'dark',
      'Unauthorized config changed'
    );
    const authHeaders = { Authorization: `Bearer ${token}` };
    const ready = await request('GET', '/api/auth/ready', authHeaders),
      readyJson: unknown = JSON.parse(ready.body);
    check(
      ready.status === 200 &&
        record(readyJson) &&
        !ready.body.includes(token) &&
        readyJson.ready === true &&
        readyJson.service === 'api' &&
        Object.keys(readyJson).sort().join(',') === 'ready,service',
      'Authenticated readiness mismatch'
    );
    const positive = await request(
        'POST',
        '/api/config/update',
        { ...authHeaders, 'Content-Type': 'application/json' },
        update
      ),
      positiveJson: unknown = JSON.parse(positive.body);
    check(
      positive.status === 200 &&
        record(positiveJson) &&
        positiveJson.success === true &&
        !positive.body.includes(token) &&
        (await cdp.inspect('window.electronAPI.config.get().then(c => c.general.theme)')) ===
          'light',
      'Authenticated mutation failed'
    );
    await until(async () => (await persistedTheme()) === 'light', 'HTTP mutation not persisted');
    const restored = await request(
      'POST',
      '/api/config/update',
      { ...authHeaders, 'Content-Type': 'application/json' },
      JSON.stringify({ section: 'general', data: { theme: 'dark' } })
    );
    const restoredJson: unknown = JSON.parse(restored.body);
    check(
      restored.status === 200 && record(restoredJson) && restoredJson.success === true,
      'HTTP restore failed'
    );
    await until(async () => (await persistedTheme()) === 'dark', 'HTTP restore not persisted');
    check(
      hash(await readFile(configFile)) === baseline,
      'Authenticated mutation did not restore exact config bytes'
    );
    check(
      (
        await request('GET', '/api/config', {
          ...authHeaders,
          Host: 'foreign.invalid',
        })
      ).status === 403,
      'Wrong Host admitted'
    );
    check(
      (
        await request('GET', '/api/config', {
          ...authHeaders,
          Origin: 'http://foreign.invalid',
        })
      ).status === 403,
      'Foreign Origin admitted'
    );
    check(
      (
        await request('OPTIONS', '/api/config/update', {
          Origin: rendererOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        })
      ).status === 204,
      'Exact origin preflight refused'
    );
    check(
      (
        await request('OPTIONS', '/api/config/update', {
          Origin: rendererOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-foreign-header',
        })
      ).status === 403,
      'Foreign preflight header admitted'
    );
    passed.push(phase);
    phase = 'browser-app-entrypoint';
    desktopCdp = cdp;
    const browserTargetsResponse = await fetch(`${browserCdpOrigin}/json/list`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const browserTargets: unknown = await browserTargetsResponse.json();
    check(Array.isArray(browserTargets), 'Invalid owned Chrome targets');
    const blankPages = browserTargets.filter(
      (target: unknown) => record(target) && target.type === 'page' && target.url === 'about:blank'
    );
    check(blankPages.length === 1, 'Owned Chrome blank page is ambiguous');
    const browserSocket = textField(blankPages[0], 'webSocketDebuggerUrl');
    const browserWs = new URL(browserSocket),
      browserHttp = new URL(browserCdpOrigin);
    check(
      browserWs.protocol === 'ws:' &&
        browserWs.hostname === browserHttp.hostname &&
        browserWs.port === browserHttp.port &&
        !browserWs.username &&
        !browserWs.password,
      'Foreign Chrome CDP websocket'
    );
    cdp = await Cdp.connect(browserSocket, apiOrigin, rendererOrigin);
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    const browserUrl = rendererOrigin + '/?port=' + new URL(apiOrigin).port;
    await cdp.send('Page.navigate', { url: browserUrl });
    await until(
      async () =>
        (await cdp?.inspect(
          "!('electronAPI' in window) && !!document.querySelector('#root #api-access-key')"
        )) === true,
      'Normal browser App gate did not render',
      60_000
    );
    check((await cdp.inspect('location.href')) === browserUrl, 'Browser App URL changed');
    check(cdp.counts.size === 0, 'Browser App sent API data requests before authentication');
    const initial = Object.fromEntries(cdp.counts);
    check(
      (await cdp.call(installBrowserProbe, [apiOrigin])) === 'required',
      'Browser initial gate failed'
    );
    await pause(1200);
    check(
      JSON.stringify(Object.fromEntries(cdp.counts)) === JSON.stringify(initial),
      'Missing-key browser sent request'
    );
    check(
      (await enterBrowserKey(cdp, wrong, 'expired')) === 'expired',
      'Wrong browser key admitted'
    );
    const expiredCounts = JSON.stringify(Object.fromEntries(cdp.counts));
    await pause(1600);
    check(
      JSON.stringify(Object.fromEntries(cdp.counts)) === expiredCounts,
      'Expired browser retried a request'
    );
    const eventRequests = cdp.counts.get('/api/events') ?? 0;
    check((await enterBrowserKey(cdp, token, 'ready')) === 'ready', 'Valid browser key refused');
    passed.push(phase);
    phase = 'browser-session-sse';
    await until(
      async () => (cdp?.counts.get('/api/events') ?? 0) === eventRequests + 1,
      'SSE did not connect'
    );
    const project = path.join(run, `synthetic-project-${randomUUID()}`);
    await mkdir(project, { mode: 0o700 });
    const projects = path.join(profile, 'projects');
    await directory(projects, true);
    const projectId = project.replace(/[/\\]/g, '-'),
      sessionId = randomUUID(),
      logs = path.join(projects, projectId);
    await mkdir(logs, { mode: 0o700 });
    const sessionFile = path.join(logs, `${sessionId}.jsonl`);
    await pause(1500);
    const line = (): string =>
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        cwd: project,
        isMeta: false,
        message: {
          role: 'user',
          content: 'Synthetic desktop local-auth fixture',
        },
      }) + '\n';
    const fixture = await open(
      sessionFile,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
    try {
      await fixture.writeFile(line());
      await fixture.sync();
    } finally {
      await fixture.close();
    }
    await until(async () => {
      const observed = await cdp?.inspect('window.__ownedDesktopAuthProbe.events');
      return (
        Array.isArray(observed) &&
        observed.some(
          (event: unknown) =>
            record(event) &&
            event.path === sessionFile &&
            event.projectId === projectId &&
            event.sessionId === sessionId
        )
      );
    }, 'Actual FileWatcher/SSE fixture not observed');
    const live: unknown = await cdp.inspect(
      '({first:window.__ownedDesktopAuthProbe.first,second:window.__ownedDesktopAuthProbe.second})'
    );
    check(
      record(live) &&
        typeof live.first === 'number' &&
        live.first > 0 &&
        live.first === live.second &&
        (cdp.counts.get('/api/events') ?? 0) === eventRequests + 1,
      'Multiple listeners did not share one productive stream'
    );
    check(cdp.activeSseRequests.size === 1, 'Productive SSE request is not singular');
    const retired = await cdp.call(retireBrowserProbe);
    check(record(retired) && retired.state === 'required', 'Owned browser retirement failed');
    await until(
      async () => cdp?.activeSseRequests.size === 0,
      'Disposed SSE body was not canceled'
    );
    const retiredRequests = cdp.counts.get('/api/events') ?? 0;
    await appendFile(sessionFile, line());
    await pause(6000);
    const after: unknown = await cdp.inspect(
      '({first:window.__ownedDesktopAuthProbe.first,second:window.__ownedDesktopAuthProbe.second})'
    );
    check(
      record(after) &&
        after.first === live.first &&
        after.second === live.second &&
        (cdp.counts.get('/api/events') ?? 0) === retiredRequests,
      'Retired browser produced late work'
    );
    passed.push(phase);
    phase = 'final-binding';
    await sourceBinding();
    // Readiness has no generation field. Prove current private reference/descriptor identity,
    // then physically call the same listener with its current key, without changing production.
    const currentReference = discovery.validateDiscoveryReference(
      await storage.readPrivateJson(path.join(profile, 'team-control-api.json')),
      profile,
      scope
    );
    check(
      record(currentReference) &&
        textField(currentReference, 'generation') === textField(reference, 'generation') &&
        textField(currentReference, 'instanceId') === textField(reference, 'instanceId') &&
        textField(currentReference, 'descriptorPath') === textField(reference, 'descriptorPath'),
      'Authority reference changed'
    );
    const currentAuthority = domain.validateAuthority(
      await storage.readPrivateJson(textField(currentReference, 'descriptorPath')),
      scope
    );
    check(
      record(currentAuthority) &&
        textField(currentAuthority, 'token') === token &&
        textField(currentAuthority, 'baseUrl') === apiOrigin &&
        (await request('GET', '/api/auth/ready', authHeaders)).status === 200,
      'Current physical authority no longer matches'
    );
    check(!cdp.credentialUrlDetected, 'Credential-bearing browser URL');
    succeeded = true;
  } catch (error) {
    failure = phase;
    failureCode = error instanceof QualificationFailure ? error.message : 'operation-failed';
  } finally {
    let desktopFailureState: unknown = null;
    let browserFailureState: unknown = null;
    if (!succeeded && phase === 'desktop-ipc' && cdp) {
      try {
        desktopFailureState = await cdp.inspect(
          `(async () => {
            const root = document.getElementById('root');
            const splash = document.getElementById('splash');
            const api = window.electronAPI;
            const bootstrap = window.__claudeTeamsRendererBootstrap;
            const facts = {
              documentState: document.readyState,
              entryImportState: ['pending','resolved','rejected'].includes(bootstrap?.importState)
                ? bootstrap.importState : 'not-observed',
              mainBootstrapPhase: ['evaluating','startup-bridge','mount-started'].includes(bootstrap?.mainPhase)
                ? bootstrap.mainPhase : 'not-observed',
              entryImportErrorClass: ['module-export','module-fetch','SyntaxError','ReferenceError','TypeError','other'].includes(bootstrap?.errorClass)
                ? bootstrap.errorClass : null,
              electronApiPresent: !!api,
              startupBridgePresent: typeof api?.startup?.getStatus === 'function',
              uiInitializationStarted: window.__claudeTeamsUiDidInit === true,
              rootPresent: !!root,
              rootHasChildren: !!root?.children.length,
              splashPresent: !!splash,
              splashExiting: splash?.classList.contains('splash-exiting') === true,
              splashError: splash?.classList.contains('splash-status-error') === true,
              startup: { outcome: 'bridge-missing' }
            };
            if (!facts.startupBridgePresent) return facts;
            let timer;
            try {
              facts.startup = await Promise.race([
                api.startup.getStatus().then(status => ({
                  outcome: 'observed',
                  phase: ['boot','electron-ready','services','runtime-host-preflight',
                    'runtime','settings','team-backups','ipc','readying','ready','failed']
                    .includes(status.phase) ? status.phase : 'other',
                  ready: status.ready === true,
                  errorPresent: !!status.error
                }), () => ({ outcome: 'rejected' })),
                new Promise(resolve => {
                  timer = setTimeout(() => resolve({ outcome: 'timeout' }), 1000);
                })
              ]);
            } finally { clearTimeout(timer); }
            return facts;
          })()`
        );
      } catch {
        desktopFailureState = { outcome: 'snapshot-unavailable' };
      }
    }
    if (!succeeded && desktopCdp && cdp) {
      try {
        browserFailureState = await cdp.inspect(
          "(() => { const state = window.__ownedDesktopAuthProbe?.session.getSnapshot(); return { state: ['required','checking','ready','expired'].includes(state) ? state : 'unknown', keyGateVisible: !!document.querySelector('#api-access-key'), errorAlertVisible: !!document.querySelector('#root [role=alert]') }; })()"
        );
      } catch {
        /* Retain only protocol status if the renderer is unavailable. */
      }
    }
    if (cdp) {
      try {
        await cdp.call(retireBrowserProbe);
      } catch {
        /* App may already have closed. */
      }
    }
    await durable(path.join(out, 'RESULT.json'), {
      status: succeeded ? 'PASS' : 'FAIL',
      passed,
      failurePhase: failure,
      failureCode,
      denied,
      requestCounts: cdp ? Object.fromEntries(cdp.counts) : {},
      responses: cdp?.responses ?? [],
      corsFailures: cdp?.corsFailures ?? [],
      desktopFailureState,
      desktopUiReadyElapsedMs,
      desktopRendererNetwork: (desktopCdp ?? cdp)?.rendererNetworkSnapshot() ?? null,
      rendererFailureClasses: (desktopCdp ?? cdp)?.rendererFailures ?? [],
      browserFailureState,
      sourceRechecked: succeeded,
      sseRequestsStillActive: cdp?.activeSseRequests.size ?? 0,
      appLaunchPerformed: true,
      providerOrTeamStarted: false,
      nativeQualification: false,
      browserAppEntrypointQualified: succeeded,
      browserAccessGateUiQualified: succeeded,
      completeBrowserUiQualification: false,
    });
    cdp?.close();
    desktopCdp?.close();
  }
  return succeeded;
}
