/**
 * Hosted Linux only: DISPLAY must belong to the caller's isolated Xvfb.
 * pnpm exec tsx scripts/e2e/external-agent-connection-desktop.ts <packaged-executable> <source-sha>
 * No debugging startup flags: the persisted setting must open the ephemeral listener.
 * Native Codex app-server tools prove MCP separately from CDP and preload draft persistence.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  BOUND_CONTROL_CONTEXT_HEADER,
  EXTERNAL_AGENT_RENDERER_MARKER,
  type ConnectionInfoV1,
} from '../../src/features/external-agent-connection/contracts/index.ts';
import {
  applyTeamTemplate,
  TEAM_TEMPLATES,
  type TeamTemplateV1,
} from '../../src/features/team-templates/index.ts';
import { verifyNativeCodexMcp } from './lib/nativeCodexMcp.ts';
import { Cdp, waitFor } from './release-updater/cdp.mts';
import { serializedFunction } from './release-updater/serialized-function.mts';

import type { ElectronAPI } from '../../src/shared/types/api.ts';
import type {
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
} from '../../src/shared/types/team.ts';

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}
interface RendererSnapshot {
  info: ConnectionInfoV1;
  marker: unknown;
}
interface Evaluation<T> {
  result: { value: T };
  exceptionDetails?: { text: string; exception?: { description: string } };
}
interface ControlState {
  baseUrl: string;
  pid: number;
}
type HarnessApi = Pick<
  ElectronAPI,
  'externalAgentConnection' | 'teams' | 'config' | 'windowControls'
>;

interface OwnedMcpProcess {
  pid: number;
  startTicks: string;
  ownerInstanceId: string;
}

async function evaluate<T>(
  client: Cdp,
  callback: (...args: never[]) => T | Promise<T>,
  args: unknown[] = []
): Promise<T> {
  const result = await client.send<Evaluation<T>>('Runtime.evaluate', {
    expression: `${serializedFunction(callback)}(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function rendererSnapshot(markerName: string): Promise<RendererSnapshot | null> {
  const host = window as unknown as { electronAPI?: HarnessApi };
  if (!host.electronAPI?.externalAgentConnection) return null;
  try {
    const info = await host.electronAPI.externalAgentConnection.getConnectionInfo();
    return { info, marker: (window as unknown as Record<string, unknown>)[markerName] };
  } catch (error) {
    // The window can exist before main finishes registering this startup handler.
    const missingHandler = "No handler registered for 'external-agent-connection:getInfo'";
    if (
      error instanceof Error &&
      (error.message === missingHandler ||
        error.message ===
          `Error invoking remote method 'external-agent-connection:getInfo': Error: ${missingHandler}`)
    )
      return null;
    throw error;
  }
}

const [executableArg, sourceSha] = process.argv.slice(2);
assert(
  executableArg && sourceSha && /^[a-f0-9]{40}$/.test(sourceSha),
  'Expected packaged executable and exact source SHA'
);
assert.equal(process.platform, 'linux', 'Run packaged proof on hosted Linux');
assert(process.env.DISPLAY, 'Caller must provide its owned Xvfb DISPLAY');
const executable = path.resolve(executableArg);
await access(executable);
const root = await mkdtemp(path.join(os.tmpdir(), 'external-agent-desktop-TEST-'));
const home = path.join(root, 'home');
const userData = path.join(root, 'user-data');
const claude = path.join(root, 'claude');
const project = path.join(root, 'sandbox-project');
for (const directory of [home, userData, claude, project]) await mkdir(directory);
await writeFile(path.join(root, '.test-only'), 'external-agent-connection-desktop-v1\n');
await writeFile(path.join(project, 'README.md'), '# Disposable external-agent connection test\n');

const portServer = createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const address = portServer.address();
assert(address && typeof address !== 'string');
const controlPort = address.port;
await new Promise<void>((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve()))
);
const configPath = path.join(claude, 'agent-teams-config.json');
await writeFile(
  configPath,
  JSON.stringify({
    general: {
      externalAgentCdpEnabled: true,
      theme: 'dark',
      appLocale: 'en',
      multimodelEnabled: true,
    },
    notifications: { enabled: false, soundEnabled: false },
    httpServer: { enabled: false, port: controlPort, host: '127.0.0.1' },
  })
);

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
const asar = path.join(path.dirname(executable), 'resources', 'app.asar');
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  root,
  sourceSha,
  executable,
  executableSha256: await sha256(executable),
  appAsarSha256: await sha256(asar),
  isolation: { home, userData, claude, project, display: process.env.DISPLAY },
  launchFlags: ['--no-sandbox', '--disable-gpu'],
  nativeExternalClientMcp: 'pending native Codex CLI app-server tool calls; no SDK fallback',
  sdkMcpTransport: 'not exercised by this harness',
  multipleBrowserWindows: 'not exercised: no supported extra-window test hook',
};
let child: ChildProcess | null = null;
let client: Cdp | null = null;
let phase = '';
let shutdownError: Error | undefined;
const closedChildren = new WeakSet<ChildProcess>();
const ownedProcesses: number[] = [];
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (
    key === 'NODE_OPTIONS' ||
    key === 'ELECTRON_RUN_AS_NODE' ||
    /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)
  )
    delete childEnv[key];
}
Object.assign(childEnv, {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'),
  CLAUDE_CONFIG_DIR: claude,
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
  AGENT_TEAMS_MCP_CLAUDE_DIR: claude,
});

function assertAlive(): ChildProcess {
  assert(
    child?.pid && child.exitCode === null && child.signalCode === null,
    `Owned app exited during ${phase}; inspect ${root}/${phase}.log`
  );
  return child;
}
async function launch(label: string): Promise<void> {
  assert.equal(child, null);
  phase = label;
  child = spawn(executable, ['--no-sandbox', '--disable-gpu'], {
    cwd: project,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createWriteStream(path.join(root, `${phase}.log`));
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });
  const launched = child;
  child.once('close', () => {
    closedChildren.add(launched);
    output.end();
  });
  await once(child, 'spawn');
  assert(child.pid);
  ownedProcesses.push(child.pid);
}
async function captureOwnedMcp(): Promise<OwnedMcpProcess | null> {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(
      await readFile(path.join(userData, 'data/mcp-http-server/state.json'), 'utf8')
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assert(
    Number.isSafeInteger(state.pid) && Number(state.pid) > 0,
    'MCP state must identify its child'
  );
  const pid = Number(state.pid);
  const health = await json<Record<string, unknown>>(
    `${loopback(String(state.url)).origin}/health`
  );
  for (const key of [
    'schemaVersion',
    'service',
    'transport',
    'host',
    'port',
    'endpoint',
    'claudeDirHash',
    'launchSpecHash',
    'ownerInstanceId',
  ]) {
    assert.notEqual(state[key], undefined, `MCP cleanup requires state identity ${key}`);
    assert.equal(health[key], state[key], `MCP cleanup requires matching health ${key}`);
  }
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.service, 'agent-teams-mcp-http');
  assert.equal(state.transport, 'httpStream');
  assert.equal(state.claudeDirHash, createHash('sha256').update(claude).digest('hex'));
  assert(typeof state.ownerInstanceId === 'string' && state.ownerInstanceId);
  const [args, environment, stat] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`, 'utf8'),
    readFile(`/proc/${pid}/environ`, 'utf8'),
    readFile(`/proc/${pid}/stat`, 'utf8'),
  ]);
  assert(
    args.split('\0').some((arg) => arg.startsWith(`${userData}/mcp`)),
    'MCP child must run own extracted bundle'
  );
  const values = new Map(
    environment.split('\0').map((entry) => {
      const equals = entry.indexOf('=');
      return [entry.slice(0, equals), entry.slice(equals + 1)];
    })
  );
  assert.equal(values.get('AGENT_TEAMS_MCP_CLAUDE_DIR'), claude);
  assert.equal(values.get('AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID'), state.ownerInstanceId);
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  assert(startTicks && /^\d+$/.test(startTicks));
  return { pid, startTicks, ownerInstanceId: state.ownerInstanceId };
}
async function cleanupOwnedMcp(owned: OwnedMcpProcess): Promise<boolean> {
  const sameProcess = async (): Promise<boolean> => {
    try {
      const stat = await readFile(`/proc/${owned.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] === owned.startTicks && fields[0] !== 'Z';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const signal = async (value: NodeJS.Signals): Promise<void> => {
    if (!(await sameProcess())) return;
    try {
      process.kill(owned.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (!(await sameProcess())) return false;
  await signal('SIGTERM');
  const deadline = Date.now() + 5000;
  while (await sameProcess()) {
    if (Date.now() >= deadline) {
      await signal('SIGKILL');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitFor(async () => !(await sameProcess()), 'verified owned MCP child exit', 5000);
  return true;
}
async function stop(): Promise<void> {
  const owned = child;
  if (!owned?.pid) return;
  let ownedMcp: OwnedMcpProcess | null = null;
  let captureError: unknown;
  try {
    ownedMcp = await captureOwnedMcp();
  } catch (error) {
    captureError = error;
  }
  const shutdown = {
    mainPid: owned.pid,
    verifiedMcpPid: ownedMcp?.pid ?? null,
    gracefulRequested: false,
    hardFallback: false,
    detachedMcpCleanup: false,
  };
  evidence[`${phase}Shutdown`] = shutdown;
  const closed = closedChildren.has(owned) ? Promise.resolve() : once(owned, 'close');
  const waitClosed = async (timeout: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-owned.pid!, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  try {
    if (client && !closedChildren.has(owned)) {
      shutdown.gracefulRequested = true;
      try {
        await evaluate(client, async () =>
          (window as unknown as { electronAPI: HarnessApi }).electronAPI.windowControls.close()
        );
      } catch (error) {
        evidence[`${phase}QuitRequestResult`] = String(error);
      }
      if (!(await waitClosed(10_000))) {
        shutdown.hardFallback = true;
        signal('SIGTERM');
      }
    } else {
      shutdown.hardFallback = true;
      signal('SIGTERM');
    }
    if (!(await waitClosed(10_000))) {
      signal('SIGKILL');
      assert(await waitClosed(5000), 'Owned app must exit after hard shutdown fallback');
    }
  } finally {
    client?.close();
    client = null;
    child = null;
    signal('SIGKILL');
    if (ownedMcp) shutdown.detachedMcpCleanup = await cleanupOwnedMcp(ownedMcp);
  }
  if (captureError) throw captureError;
  assert(
    !shutdown.gracefulRequested || (!shutdown.hardFallback && !shutdown.detachedMcpCleanup),
    'Ready renderer must quit main and MCP through the actual app lifecycle without forced cleanup'
  );
}
function loopback(value: string): URL {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && !url.username && !url.password && !url.hash);
  return url;
}
function getClient(): Cdp {
  assert(client, 'A validated renderer connection is required');
  return client;
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  loopback(url);
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  assert(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}
function checkRenderer(snapshot: RendererSnapshot, targetId: string, wsUrl: string): void {
  assert.equal(snapshot.info.schemaVersion, 1);
  assert.equal(snapshot.info.cdp.rendererTargetId, targetId);
  assert.equal(snapshot.info.cdp.rendererWsUrl, wsUrl);
  assert.deepEqual(snapshot.marker, snapshot.info.context);
  assert.equal(new URL(wsUrl).pathname, `/devtools/page/${targetId}`);
}
async function attach(): Promise<RendererSnapshot> {
  const attached = await waitFor(async () => {
    assertAlive();
    let lines: string[];
    try {
      lines = (await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8'))
        .trim()
        .split(/\r?\n/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const port = Number(lines[0]);
    assert(Number.isInteger(port) && port > 0 && port < 65536);
    assert(lines[1]?.startsWith('/devtools/browser/'));
    const origin = `http://127.0.0.1:${port}`;
    let version: { webSocketDebuggerUrl: string }, targets: Target[];
    try {
      [version, targets] = await Promise.all([
        json<{ webSocketDebuggerUrl: string }>(`${origin}/json/version`),
        json<Target[]>(`${origin}/json/list`),
      ]);
    } catch {
      return false;
    }
    assert.equal(loopback(version.webSocketDebuggerUrl).pathname, lines[1]);
    assert.equal(loopback(version.webSocketDebuggerUrl).port, String(port));
    const matches: { client: Cdp; snapshot: RendererSnapshot }[] = [];
    for (const target of targets.filter((candidate) => candidate.type === 'page')) {
      if (!target.webSocketDebuggerUrl) continue;
      const ws = loopback(target.webSocketDebuggerUrl);
      assert.equal(ws.port, String(port));
      const candidate = await Cdp.connect(target.webSocketDebuggerUrl);
      let selected = false;
      try {
        const snapshot = await evaluate(candidate, rendererSnapshot, [
          EXTERNAL_AGENT_RENDERER_MARKER,
        ]);
        if (
          snapshot?.info.cdp.rendererTargetId === target.id &&
          ['ready', 'restart-required'].includes(snapshot.info.cdp.status)
        ) {
          checkRenderer(snapshot, target.id, target.webSocketDebuggerUrl);
          assert.equal(snapshot.info.cdp.httpOrigin, origin);
          assert.equal(snapshot.info.cdp.browserWsUrl, version.webSocketDebuggerUrl);
          matches.push({ client: candidate, snapshot });
          selected = true;
        }
      } finally {
        if (!selected) candidate.close();
      }
    }
    if (matches.length === 0) return false;
    if (matches.length !== 1) {
      for (const match of matches) match.client.close();
      throw new Error('Ambiguous validated main renderers');
    }
    evidence[`${phase}Targets`] = targets.map(({ id, type, url }) => ({ id, type, url }));
    return matches[0]!;
  }, `${phase}: exact renderer from instance discovery`);
  client = attached.client;
  return waitFor(async () => {
    const snapshot = await evaluate(attached.client, rendererSnapshot, [
      EXTERNAL_AGENT_RENDERER_MARKER,
    ]);
    if (
      !snapshot ||
      snapshot.info.mcp.status !== 'ready' ||
      snapshot.info.control.status !== 'ready'
    )
      return false;
    checkRenderer(
      snapshot,
      attached.snapshot.info.cdp.rendererTargetId!,
      attached.snapshot.info.cdp.rendererWsUrl!
    );
    return snapshot;
  }, `${phase}: MCP/control readiness`);
}
async function readControl(): Promise<{ state: ControlState; info: ConnectionInfoV1 }> {
  return waitFor(async () => {
    const owner = assertAlive();
    let state: ControlState;
    try {
      state = JSON.parse(
        await readFile(path.join(claude, 'team-control-api.json'), 'utf8')
      ) as ControlState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (state.pid !== owner.pid) return false;
    const info = await json<ConnectionInfoV1>(`${state.baseUrl}/api/app/connection`);
    return info.mcp.status === 'ready' && info.control.status === 'ready' ? { state, info } : false;
  }, `${phase}: own process control snapshot`);
}
async function button(
  label: string,
  selector = false,
  menuTrigger: string | null = null,
  teamDisplayName: string | null = null
): Promise<void> {
  assert(client);
  const point = await waitFor(
    () =>
      evaluate(
        client!,
        (wanted: string, css: boolean, triggerLabel: string | null, teamLabel: string | null) => {
          const visible = (node: Element): boolean => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              Boolean(rect.width && rect.height) &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          };
          const triggers = triggerLabel
            ? [...document.querySelectorAll('button')].filter(
                (node) => node.getAttribute('aria-label') === triggerLabel && visible(node)
              )
            : [];
          if (triggerLabel && triggers.length !== 1)
            throw new Error(
              `Expected one visible menu trigger: ${triggerLabel}, found ${triggers.length}`
            );
          const cards = teamLabel
            ? [...document.querySelectorAll('div[role="button"]')].filter(
                (node) =>
                  node.querySelector('h3')?.textContent?.trim() === teamLabel && visible(node)
              )
            : [];
          if (teamLabel && cards.length > 1)
            throw new Error(`Ambiguous visible team card: ${teamLabel}`);
          if (teamLabel && cards.length === 0) return null;
          const scope = teamLabel ? cards[0] : triggerLabel ? triggers[0]!.parentElement : document;
          if (!scope) return null;
          const matches = css
            ? [...scope.querySelectorAll(wanted)]
            : [...scope.querySelectorAll('button, [role="menuitem"]')].filter(
                (node) =>
                  node.getAttribute('aria-label') === wanted ||
                  node.querySelector('span')?.textContent?.replace(/\s+/g, ' ').trim() === wanted ||
                  node.textContent?.replace(/\s+/g, ' ').trim() === wanted
              );
          const enabled = matches.filter(
            (node) =>
              visible(node) &&
              !node.hasAttribute('disabled') &&
              node.getAttribute('aria-disabled') !== 'true'
          );
          if (enabled.length > 1)
            throw new Error(`Ambiguous visible control: ${wanted}, found ${enabled.length}`);
          const element = enabled[0];
          if (!(element instanceof HTMLElement)) return null;
          element.scrollIntoView({ block: 'center' });
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height || getComputedStyle(element).pointerEvents === 'none')
            return null;
          const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          return hit && (hit === element || element.contains(hit)) ? point : null;
        },
        [label, selector, menuTrigger, teamDisplayName]
      ),
    `visible button: ${label}`
  );
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point,
  });
}
async function openMenu(label: string): Promise<void> {
  await button('More actions');
  await button(label, false, 'More actions');
}
async function screenshot(label: string): Promise<void> {
  const capture = await getClient().send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(path.join(root, `${label}.png`), Buffer.from(capture.data, 'base64'));
}
async function captureDomEvidence(label: string): Promise<void> {
  if (!client) return;
  try {
    const dom = await evaluate(client, () => ({
      url: location.href,
      text: document.body.innerText.slice(0, 8000),
      dialogText: [...document.querySelectorAll('[role="dialog"]')].map((dialog) =>
        (dialog as HTMLElement).innerText.slice(-8000)
      ),
      controls: [
        ...document.querySelectorAll('button, input, textarea, [role="menuitem"], [role="dialog"]'),
      ]
        .slice(0, 160)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            tag: node.tagName,
            role: node.getAttribute('role'),
            id: node.id,
            label: node.getAttribute('aria-label'),
            text: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160),
            value:
              node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
                ? node.value
                : undefined,
            disabled: node.hasAttribute('disabled'),
            state: node.getAttribute('data-state'),
            pointerEvents: getComputedStyle(node).pointerEvents,
            visible: Boolean(rect.width && rect.height),
            unobstructed: Boolean(hit && (hit === node || node.contains(hit))),
          };
        }),
    }));
    await writeFile(path.join(root, `${label}-dom.json`), JSON.stringify(dom, null, 2) + '\n');
    await screenshot(label);
    evidence[`${label}Diagnostics`] = { dom: `${label}-dom.json`, screenshot: `${label}.png` };
  } catch (error) {
    evidence[`${label}DiagnosticsError`] = String(error);
  }
}
async function verifyCopyProviderMode(providerlessName: string): Promise<void> {
  const active = getClient();
  const selectedName = 'external-e2e-copy-codex-source';
  const unresolvedName = 'external-e2e-copy-unresolved-source';
  const sources = await evaluate(
    active,
    async (name: string, unresolved: string, original: string, cwd: string) => {
      const api = (window as unknown as { electronAPI: HarnessApi }).electronAPI;
      await api.teams.createConfig({
        teamName: name,
        displayName: 'External E2E selected copy source',
        description:
          'Sandbox fixture for copying explicit runtime selection with multimodel disabled.',
        prompt:
          'Coordinate this disposable Copy verification. Preserve the saved provider selection and never launch agents.',
        cwd,
        runtimeSelectionVersion: 1,
        providerId: 'codex',
        members: [],
        syncModelsWithLead: true,
      });
      const providerless = await api.teams.getSavedRequest(original);
      if (!providerless)
        throw new Error('Providerless copy fixture requires original saved request');
      await api.teams.createConfig({
        ...providerless,
        teamName: unresolved,
        displayName: 'External E2E unresolved copy source',
        cwd,
      });
      await api.config.update('general', { multimodelEnabled: false });
      return [await api.teams.getSavedRequest(name), await api.teams.getSavedRequest(unresolved)];
    },
    [selectedName, unresolvedName, providerlessName, project]
  );
  // Copy is supported for configured teams, not pending drafts. These sandbox files
  // mirror the canonical offline config shape without starting any team runtime.
  for (const source of sources) {
    assert(source);
    await assertNoLaunch(source.teamName);
    const config: TeamConfig = {
      name: source.displayName ?? source.teamName,
      description: source.description,
      projectPath: project,
      members: [
        {
          name: 'team-lead',
          role: 'team-lead',
          agentType: 'team-lead',
          providerId: source.providerId,
        },
        ...source.members.map((member) => ({ ...member, agentType: 'teammate' })),
      ],
    };
    await writeFile(
      path.join(claude, 'teams', source.teamName, 'config.json'),
      JSON.stringify(config)
    );
  }
  evidence.copySourceFixture =
    'Offline configured sandbox teams with canonical saved requests; no pending draft Copy or runtime launch';
  const reload = async (): Promise<void> => {
    const count = active.events.filter((event) => event.method === 'Page.loadEventFired').length;
    await active.send('Page.reload');
    await waitFor(
      async () =>
        active.events.filter((event) => event.method === 'Page.loadEventFired').length > count,
      'copy mode renderer reload'
    );
    await waitFor(
      async () =>
        Boolean(await evaluate(active, rendererSnapshot, [EXTERNAL_AGENT_RENDERER_MARKER])),
      'copy mode preload readiness'
    );
  };
  try {
    await reload();
    assert.equal(
      await evaluate(
        active,
        async () =>
          (await (window as unknown as { electronAPI: HarnessApi }).electronAPI.config.get())
            .general.multimodelEnabled
      ),
      false
    );
    for (const testCase of [
      {
        source: selectedName,
        displayName: 'External E2E selected copy source',
        destination: 'external-e2e-copy-selected',
        provider: 'anthropic',
      },
      {
        source: unresolvedName,
        displayName: 'External E2E unresolved copy source',
        destination: 'external-e2e-copy-unresolved',
        provider: undefined,
      },
    ] as const) {
      await assertNoLaunch(testCase.source, true);
      await waitFor(async () => {
        const source = await evaluate(
          active,
          async (name: string) =>
            (
              await (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.list()
            ).find((team) => team.teamName === name),
          [testCase.source]
        );
        return source && !source.pendingCreate ? source : false;
      }, 'configured copy source is readable, not pending draft');
      const sourceRequest = await evaluate(
        active,
        async (name: string) =>
          (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.getSavedRequest(
            name
          ),
        [testCase.source]
      );
      assert(sourceRequest);
      assert.equal(sourceRequest.runtimeSelectionVersion, 1);
      assert.equal(sourceRequest.providerId, testCase.provider ? 'codex' : undefined);
      await openMenu('Teams');
      await button('Copy team', false, null, testCase.displayName);
      await waitFor(
        () =>
          evaluate(
            active,
            (source: string) =>
              (document.getElementById('team-name') as HTMLInputElement | null)?.value.startsWith(
                `${source}-`
              ) === true,
            [testCase.source]
          ),
        'copy source initializes after persisted draft hydration'
      );
      await evaluate(active, () => document.getElementById('team-name')?.focus());
      await active.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await active.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
      });
      await active.send('Input.insertText', { text: testCase.destination });
      await waitFor(
        () =>
          evaluate(
            active,
            (name: string) =>
              (document.getElementById('team-name') as HTMLInputElement | null)?.value === name,
            [testCase.destination]
          ),
        'native input sets exact copied destination name'
      );
      const launchChecked = await evaluate(active, () =>
        document.getElementById('launch-team')?.getAttribute('data-state')
      );
      assert(
        launchChecked === 'checked' || launchChecked === 'unchecked',
        'Initialized Copy dialog must expose a launch choice'
      );
      if (launchChecked === 'checked') {
        assert.equal(
          await evaluate(active, () => {
            const checkbox = document.getElementById('launch-team');
            if (
              !(checkbox instanceof HTMLButtonElement) ||
              checkbox.disabled ||
              checkbox.getAttribute('aria-disabled') === 'true'
            )
              return false;
            checkbox.focus();
            return document.activeElement === checkbox;
          }),
          true,
          'Launch checkbox must accept keyboard focus before opting out'
        );
        await active.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ' ',
          code: 'Space',
          windowsVirtualKeyCode: 32,
        });
        await active.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: ' ',
          code: 'Space',
          windowsVirtualKeyCode: 32,
        });
      }
      await waitFor(
        () =>
          evaluate(
            active,
            () => document.getElementById('launch-team')?.getAttribute('data-state') === 'unchecked'
          ),
        'single launch opt-out is applied before saving Copy'
      );
      assert.equal(
        await evaluate(active, () =>
          document.getElementById('launch-team')?.getAttribute('data-state')
        ),
        'unchecked',
        'Copy proof must save only, never launch'
      );
      await captureDomEvidence('copy-provider-mode-before-save');
      await button('Create');
      const saved = await waitFor(
        async () =>
          evaluate(
            active,
            async (name: string) =>
              (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.getSavedRequest(
                name
              ),
            [testCase.destination]
          ),
        'copied draft persisted'
      );
      assert.equal(saved.runtimeSelectionVersion, 1);
      assert.equal(saved.providerId, testCase.provider);
      if (!testCase.provider) assert.equal(saved.model, undefined);
      await assertNoLaunch(testCase.destination);
      await waitFor(
        () => evaluate(active, () => !document.getElementById('team-name')),
        'copy dialog saved and closed'
      );
      evidence[`${testCase.destination}ProviderMode`] = {
        provider: saved.providerId ?? null,
        runtimeSelectionVersion: saved.runtimeSelectionVersion,
        noLaunch: true,
      };
    }
  } catch (error) {
    await captureDomEvidence('copy-provider-mode-failure');
    throw error;
  } finally {
    await evaluate(active, async () =>
      (window as unknown as { electronAPI: HarnessApi }).electronAPI.config.update('general', {
        multimodelEnabled: true,
      })
    );
    await reload();
  }
}
async function copyPrompt(
  info: ConnectionInfoV1,
  label: string,
  expectEmpty: boolean
): Promise<void> {
  const active = getClient();
  await openMenu('Teams');
  const before = await evaluate(active, async () =>
    (await (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.list())
      .map((team) => team.teamName)
      .sort()
  );
  await button('[data-testid="external-agent-prompt-open"]', true);
  await waitFor(
    () => evaluate(active, () => Boolean(document.getElementById('external-agent-task'))),
    'prompt task field'
  );
  if (expectEmpty)
    assert.equal(
      await evaluate(
        active,
        () =>
          (
            document.querySelector(
              '[data-testid="external-agent-prompt-copy"]'
            ) as HTMLButtonElement | null
          )?.disabled
      ),
      true
    );
  const references = await evaluate(active, () =>
    [...document.querySelectorAll('[data-template-reference]')]
      .map((card) => card.getAttribute('data-template-reference'))
      .sort()
  );
  assert.deepEqual(references, [
    'content',
    'customer-support',
    'learning',
    'marketing',
    'operations',
    'research',
    'sales',
    'software-product',
  ]);
  await button('[data-template-reference="software-product"] > button', true);
  await button(
    '[data-template-reference="software-product"] button[aria-label="Responsibilities for Coordinator"]',
    true
  );
  await waitFor(
    () =>
      evaluate(
        active,
        (workflow: string) =>
          document
            .querySelector('[data-template-reference="software-product"]')
            ?.textContent?.includes(workflow) ?? false,
        [TEAM_TEMPLATES.find((template) => template.id === 'software-product')!.teamPrompt]
      ),
    'reference coordinator responsibilities'
  );
  await evaluate(active, () => document.getElementById('external-agent-task')?.focus());
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 0,
    windowsVirtualKeyCode: 65,
  });
  const task = `Create one saved draft for ${label} in ${project}. Do not launch agents.`;
  await active.send('Input.insertText', { text: task });
  await waitFor(
    () =>
      evaluate(
        active,
        (request: string) => {
          const preview = document.querySelector<HTMLElement>(
            '[data-testid="external-agent-prompt-preview"]'
          );
          return Boolean(
            preview &&
            !preview.isContentEditable &&
            preview.getClientRects().length &&
            preview.textContent?.includes(request)
          );
        },
        [task]
      ),
    'visible read-only final prompt without a reveal action'
  );
  assert(info.cdp.browserWsUrl);
  const browser = await Cdp.connect(info.cdp.browserWsUrl);
  try {
    await browser.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await active.send('Page.bringToFront');
    await button('[data-testid="external-agent-prompt-copy"]', true);
    const copied = await waitFor(async () => {
      const value = await evaluate(active, async () => navigator.clipboard.readText());
      return value.includes(task) ? value : false;
    }, 'actual native clipboard prompt');
    await waitFor(
      () =>
        evaluate(
          active,
          () =>
            document
              .querySelector('[data-testid="external-agent-prompt-dialog"]')
              ?.textContent?.includes(
                'Prompt copied. This does not mean the external agent has connected or completed your request.'
              ) ?? false
        ),
      'honest clipboard success status'
    );
    assert(copied.includes(JSON.stringify(info.context)));
    assert(info.mcp.url && copied.includes(info.mcp.url));
    assert(info.cdp.rendererWsUrl && copied.includes(info.cdp.rendererWsUrl));
    const separator = 'Task and canonical reference templates (JSON):\n';
    assert(copied.includes(separator));
    const data = JSON.parse(copied.slice(copied.lastIndexOf(separator) + separator.length)) as {
      task: string;
      templates: TeamTemplateV1[];
    };
    assert.equal(data.task, task);
    assert.equal(data.templates.length, TEAM_TEMPLATES.length);
    for (const template of TEAM_TEMPLATES) {
      const reference = data.templates.find((candidate) => candidate.id === template.id);
      assert(reference);
      assert.equal(reference.teamPrompt, template.teamPrompt);
      assert.deepEqual(reference.members, template.members);
    }
    await writeFile(path.join(root, `${label}.txt`), copied);
    const preview = await evaluate(
      active,
      () =>
        (
          document.querySelector(
            '[data-testid="external-agent-prompt-preview"]'
          ) as HTMLElement | null
        )?.textContent
    );
    assert.equal(preview, copied, 'Preview and actual clipboard must show the same live prompt');
    await screenshot(label);
    evidence[label] = {
      clipboardVerified: true,
      templates: data.templates.map((template) => template.id),
      task,
    };
    if (expectEmpty) {
      const failureTask = `${task} Verify clipboard recovery.`;
      try {
        await evaluate(active, () => {
          const host = window as unknown as { __externalAgentE2ERestoreClipboard?: () => void };
          const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
          host.__externalAgentE2ERestoreClipboard = () => {
            if (descriptor) Object.defineProperty(navigator.clipboard, 'writeText', descriptor);
            else Reflect.deleteProperty(navigator.clipboard, 'writeText');
            delete host.__externalAgentE2ERestoreClipboard;
          };
          Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => {
              throw new Error('Isolated E2E clipboard rejection');
            },
          });
          const taskField = document.getElementById('external-agent-task') as HTMLTextAreaElement;
          taskField.focus();
          taskField.setSelectionRange(taskField.value.length, taskField.value.length);
        });
        await active.send('Input.insertText', { text: ' Verify clipboard recovery.' });
        await waitFor(
          () =>
            evaluate(active, () => {
              const dialog = document.querySelector('[data-testid="external-agent-prompt-dialog"]');
              return !dialog?.textContent?.includes('Prompt copied.');
            }),
          'task edit invalidates clipboard success receipt'
        );
        await button('[data-testid="external-agent-prompt-copy"]', true);
        await waitFor(
          () =>
            evaluate(
              active,
              () =>
                document
                  .querySelector('[data-testid="external-agent-prompt-dialog"]')
                  ?.textContent?.includes(
                    'Clipboard write failed. Select and copy the final prompt manually.'
                  ) ?? false
            ),
          'actual clipboard rejection is shown'
        );
        await evaluate(active, () => {
          document
            .querySelector<HTMLElement>('[data-testid="external-agent-prompt-preview"]')
            ?.focus();
        });
        await active.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
        });
        await active.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: 0,
          windowsVirtualKeyCode: 65,
        });
        const failed = await evaluate(active, () => {
          const dialog = document.querySelector('[data-testid="external-agent-prompt-dialog"]');
          const previewField = document.querySelector(
            '[data-testid="external-agent-prompt-preview"]'
          ) as HTMLElement | null;
          if (!previewField) throw new Error('Clipboard failure must expose preview');
          const selection = window.getSelection();
          return {
            success: dialog?.textContent?.includes('Prompt copied.') ?? false,
            buttonText: dialog
              ?.querySelector('[data-testid="external-agent-prompt-copy"]')
              ?.textContent?.trim(),
            preview: previewField.textContent ?? '',
            readOnly: !previewField.isContentEditable,
            disabled: previewField.hasAttribute('disabled'),
            visible: Boolean(previewField.getBoundingClientRect().height),
            selectedLength: selection?.toString().length ?? 0,
          };
        });
        assert.equal(failed.success, false);
        assert.notEqual(failed.buttonText, 'Copied');
        assert(failed.preview.includes(failureTask));
        assert.equal(failed.readOnly, true);
        assert.equal(failed.disabled, false);
        assert.equal(failed.visible, true);
        assert.equal(failed.selectedLength, failed.preview.length);
        await screenshot('clipboard-failure');
        evidence.clipboardFailure = {
          inlineFailure: true,
          noSuccessReceipt: true,
          selectablePreview: true,
        };
      } finally {
        await evaluate(active, () => {
          (
            window as unknown as { __externalAgentE2ERestoreClipboard?: () => void }
          ).__externalAgentE2ERestoreClipboard?.();
        });
      }
      await button('[data-testid="external-agent-prompt-copy"]', true);
      await waitFor(async () => {
        const recovered = await evaluate(active, async () => navigator.clipboard.readText());
        const success = await evaluate(
          active,
          () =>
            document
              .querySelector('[data-testid="external-agent-prompt-dialog"]')
              ?.textContent?.includes('Prompt copied.') ?? false
        );
        return recovered.includes(failureTask) && success;
      }, 'restored actual clipboard succeeds after failure');
      evidence.clipboardRecovery = true;
    }
  } finally {
    await browser.send('Browser.resetPermissions');
    browser.close();
  }
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await waitFor(
    () =>
      evaluate(
        active,
        () => document.querySelector('[data-testid="external-agent-prompt-dialog"]') === null
      ),
    'prompt dialog closed'
  );
  const after = await evaluate(active, async () =>
    (await (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.list())
      .map((team) => team.teamName)
      .sort()
  );
  assert.deepEqual(after, before, 'Copy must not create local teams');
}
async function settingsSnapshot(
  label: string,
  info: ConnectionInfoV1,
  theme: 'dark' | 'light'
): Promise<void> {
  assert(client);
  await openMenu('Settings');
  const text = await waitFor(
    () =>
      evaluate(client!, () => {
        const section = document.querySelector('section[aria-label="External agent connection"]');
        if (!section) return null;
        section.scrollIntoView({ block: 'center' });
        return { text: section.textContent ?? '', theme: document.documentElement.className };
      }),
    'connection settings section'
  );
  assert(text.theme.split(' ').includes(theme));
  const endpointsText = await waitFor(async () => {
    const rendered = await evaluate(
      client!,
      () =>
        document.querySelector('section[aria-label="External agent connection"]')?.textContent ?? ''
    );
    return info.mcp.url &&
      info.cdp.rendererWsUrl &&
      rendered.includes(info.mcp.url) &&
      rendered.includes(info.cdp.rendererWsUrl)
      ? rendered
      : false;
  }, 'actual endpoints in settings');
  evidence[label] = { text: endpointsText, theme: text.theme };
  await screenshot(label);
}
async function assertNoLaunch(teamName: string, configuredFixture = false): Promise<void> {
  for (const filename of [
    ...(configuredFixture ? [] : ['config.json']),
    'launch-state.json',
    'bootstrap-state.json',
    'bootstrap-journal.jsonl',
  ]) {
    await assert.rejects(access(path.join(claude, 'teams', teamName, filename)), {
      code: 'ENOENT',
    });
  }
}
async function refusesConnection(origin: string): Promise<void> {
  const url = loopback(origin);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Disabled CDP still listens: ${origin}`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error('Cannot establish disabled-listener evidence'));
    });
  });
}
async function optionalPortFile(): Promise<string | null> {
  try {
    return await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

try {
  await launch('enabled-dark');
  const first = await attach();
  let active = getClient();
  const firstControl = await readControl();
  assert.deepEqual(firstControl.info.context, first.info.context);
  evidence.enabled = first;
  assert(first.info.mcp.url);
  const nativeTeamName = 'sandbox-native-codex';
  evidence.nativeExternalClientMcp = await verifyNativeCodexMcp({
    url: first.info.mcp.url,
    expectedContext: first.info.context,
    cwd: project,
    workRoot: path.join(root, 'native-codex'),
    teamName: nativeTeamName,
  });
  await assertNoLaunch(nativeTeamName);
  await active.send('Runtime.enable');
  await active.send('Network.enable');
  await active.send('Page.enable');
  assert.equal(await evaluate(active, () => 40 + 2), 42);
  const consoleMarker = `external-agent-e2e-${sourceSha}`;
  await evaluate(active, (message: string) => console.debug(message), [consoleMarker]);
  await waitFor(
    async () =>
      client!.events.some(
        (event) =>
          event.method === 'Runtime.consoleAPICalled' &&
          JSON.stringify(event.params).includes(consoleMarker)
      ),
    'raw CDP console event'
  );

  const template = TEAM_TEMPLATES.find((item) => item.id === 'software-product');
  assert(template);
  const teamName = 'external-e2e-feature';
  const draft: TeamCreateConfigRequest = {
    ...applyTeamTemplate(template),
    teamName,
    displayName: 'External E2E feature',
    cwd: project,
  };
  assert(draft.members[0]);
  assert(draft.members[0].workflow);
  draft.members[0].workflow += ' Report sandbox-only evidence.';
  const saved = await evaluate(
    active,
    async (request: TeamCreateConfigRequest): Promise<TeamCreateRequest | null> => {
      const api = (window as unknown as { electronAPI: HarnessApi }).electronAPI;
      await api.teams.createConfig(request);
      return api.teams.getSavedRequest(request.teamName);
    },
    [draft]
  );
  assert(saved);
  assert.equal(saved.runtimeSelectionVersion, 1);
  assert.equal(saved.providerId, undefined);
  assert.equal(saved.model, undefined);
  assert.equal(saved.providerBackendId, undefined);
  assert.equal(saved.prompt, template.teamPrompt);
  for (const member of draft.members) {
    const persisted: TeamCreateRequest['members'][number] | undefined = saved.members.find(
      (item) => item.name === member.name
    );
    assert(persisted);
    assert.equal(persisted.role, member.role);
    assert.equal(persisted.workflow, member.workflow);
    assert.equal(persisted.providerId, undefined);
    assert.equal(persisted.model, undefined);
  }
  evidence.draft = saved;
  await assertNoLaunch(teamName);
  await openMenu('Teams');
  await waitFor(
    async () =>
      evaluate(client!, () => document.body.textContent?.includes('External E2E feature') ?? false),
    'draft visible in team list'
  );
  await screenshot('providerless-draft');
  await copyPrompt(first.info, 'prompt-dark', true);
  await verifyCopyProviderMode(teamName);
  await settingsSnapshot('settings-dark', first.info, 'dark');

  const reloadEventsBefore = active.events.filter(
    (event) => event.method === 'Page.loadEventFired'
  ).length;
  const networkEventsBefore = active.events.length;
  await active.send('Page.reload');
  await waitFor(
    async () =>
      active.events.filter((event) => event.method === 'Page.loadEventFired').length >
      reloadEventsBefore,
    'renderer reload completed'
  );
  await waitFor(async () => {
    const next = await evaluate(client!, rendererSnapshot, [EXTERNAL_AGENT_RENDERER_MARKER]);
    if (!next || next.info.cdp.status !== 'ready') return false;
    checkRenderer(next, first.info.cdp.rendererTargetId!, first.info.cdp.rendererWsUrl!);
    return true;
  }, 'renderer reload rediscovery and marker');
  await waitFor(
    async () =>
      active.events
        .slice(networkEventsBefore)
        .some((event) => event.method === 'Network.requestWillBeSent'),
    'raw CDP network event on renderer reload'
  );
  evidence.rendererReload = 'verified; new BrowserWindow recreation not exercised';

  const beforeCrash = await evaluate(active, rendererSnapshot, [EXTERNAL_AGENT_RENDERER_MARKER]);
  assert(beforeCrash && beforeCrash.info.cdp.status === 'ready');
  const mainPidBeforeCrash = assertAlive().pid;
  const mcpBeforeCrash = await captureOwnedMcp();
  assert(mcpBeforeCrash, 'Renderer crash proof requires an owned ready MCP child');
  // Crashing the selected renderer can disconnect CDP or leave Page.crash unanswered.
  // Its existing 30s command bound is accepted only alongside independent recovery evidence.
  const crashCommandResult = await active.send('Page.crash').then(
    () => 'acknowledged',
    (error: unknown) => {
      if (
        error instanceof Error &&
        ['Native CDP closed', 'Target crashed', 'CDP timeout: Page.crash'].includes(error.message)
      )
        return error.message;
      throw error;
    }
  );
  await waitFor(
    async () => {
      assert.equal(assertAlive().pid, mainPidBeforeCrash);
      const info = await json<ConnectionInfoV1>(`${firstControl.state.baseUrl}/api/app/connection`);
      assert.deepEqual(info.context, beforeCrash.info.context);
      assert.equal(info.mcp.status, 'ready');
      assert.equal(info.control.status, 'ready');
      return info.cdp.status === 'ready' &&
        info.cdp.targetGeneration > beforeCrash.info.cdp.targetGeneration
        ? info
        : false;
    },
    'renderer crash automatically recovered in the same app',
    60_000
  );
  active.close();
  client = null;
  const recovered = await attach();
  active = getClient();
  assert.equal(assertAlive().pid, mainPidBeforeCrash);
  assert.deepEqual(recovered.info.context, beforeCrash.info.context);
  assert.equal(recovered.info.profileFingerprint, beforeCrash.info.profileFingerprint);
  assert.equal(recovered.info.cdp.browserWsUrl, beforeCrash.info.cdp.browserWsUrl);
  checkRenderer(
    recovered,
    beforeCrash.info.cdp.rendererTargetId!,
    beforeCrash.info.cdp.rendererWsUrl!
  );
  assert(recovered.info.cdp.targetGeneration > beforeCrash.info.cdp.targetGeneration);
  assert.equal(recovered.info.mcp.status, 'ready');
  assert.equal(recovered.info.mcp.url, beforeCrash.info.mcp.url);
  const mcpAfterCrash = await captureOwnedMcp();
  assert(mcpAfterCrash, 'Recovered renderer requires an owned ready MCP child');
  assert.deepEqual(
    mcpAfterCrash,
    mcpBeforeCrash,
    'MCP process identity changed after renderer crash'
  );
  const crashDraft = await evaluate(
    active,
    async (name: string) =>
      (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.getSavedRequest(name),
    [teamName]
  );
  assert.deepEqual(crashDraft, saved);
  await assertNoLaunch(teamName);
  evidence.rendererCrashRecovery = {
    trigger: 'raw CDP Page.crash',
    commandResult: crashCommandResult,
    mainPid: mainPidBeforeCrash,
    before: beforeCrash.info.cdp,
    after: recovered.info.cdp,
    context: recovered.info.context,
    mcpProcessBefore: mcpBeforeCrash,
    mcpProcessAfter: mcpAfterCrash,
    draftReadback: crashDraft,
    noLaunch: true,
    scope:
      'renderer crash and automatic recovery in the same main target; new BrowserWindow recreation not exercised',
  };
  await openMenu('Settings');
  await waitFor(
    () =>
      evaluate(active, () => {
        const toggle = document.getElementById('external-agent-cdp');
        if (
          !(toggle instanceof HTMLButtonElement) ||
          toggle.disabled ||
          toggle.getAttribute('aria-disabled') === 'true'
        )
          return false;
        toggle.scrollIntoView({ block: 'center' });
        const rect = toggle.getBoundingClientRect();
        const style = getComputedStyle(toggle);
        if (
          !rect.width ||
          !rect.height ||
          rect.top < 0 ||
          rect.bottom > innerHeight ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          return false;
        if (
          toggle.getAttribute('role') !== 'switch' ||
          toggle.getAttribute('aria-checked') !== 'true'
        )
          throw new Error(
            'Expected enabled checked external-agent CDP switch before single keyboard toggle'
          );
        toggle.focus();
        return document.activeElement === toggle;
      }),
    'visible enabled checked CDP switch has exact keyboard focus after renderer recovery'
  );
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await active.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  evidence.disabledSettingInput = 'one native Space down/up on verified focused checked CDP switch';
  const disabledLive = await waitFor(async () => {
    const next = await evaluate(client!, rendererSnapshot, [EXTERNAL_AGENT_RENDERER_MARKER]);
    return next?.info.cdp.status === 'restart-required' ? next : false;
  }, 'disabled setting requires restart');
  checkRenderer(disabledLive, first.info.cdp.rendererTargetId!, first.info.cdp.rendererWsUrl!);
  assert.equal(
    await evaluate(
      active,
      async () =>
        (await (window as unknown as { electronAPI: HarnessApi }).electronAPI.config.get()).general
          .externalAgentCdpEnabled
    ),
    false
  );
  assert.equal(await evaluate(active, () => 6 * 7), 42, 'Access remains live until restart');
  await waitFor(
    async () =>
      (
        JSON.parse(await readFile(configPath, 'utf8')) as {
          general: { externalAgentCdpEnabled: boolean };
        }
      ).general.externalAgentCdpEnabled === false,
    'disabled setting persisted'
  );
  evidence.disabledBeforeRestart = disabledLive;
  await stop();
  const portFileBeforeDisabled = await optionalPortFile();

  await launch('disabled');
  const disabled = await readControl();
  assert.equal(
    await optionalPortFile(),
    portFileBeforeDisabled,
    'Disabled startup must not publish another debugging listener'
  );
  assert.notEqual(disabled.info.context.appInstanceId, first.info.context.appInstanceId);
  assert.equal(disabled.info.cdp.status, 'disabled');
  for (const key of ['httpOrigin', 'browserWsUrl', 'rendererTargetId', 'rendererWsUrl'] as const)
    assert.equal(disabled.info.cdp[key], null);
  await refusesConnection(first.info.cdp.httpOrigin!);
  evidence.disabledAfterRestart = disabled.info;
  const reenabled = await json<{ success: boolean; error?: string }>(
    `${disabled.state.baseUrl}/api/config/update`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(disabled.info.context),
      },
      body: JSON.stringify({
        section: 'general',
        data: { externalAgentCdpEnabled: true, theme: 'light' },
      }),
    }
  );
  assert.equal(reenabled.success, true, reenabled.error);
  const pending = await json<ConnectionInfoV1>(`${disabled.state.baseUrl}/api/app/connection`);
  assert.equal(pending.cdp.status, 'restart-required');
  assert.equal(pending.cdp.httpOrigin, null);
  await waitFor(
    async () =>
      (
        JSON.parse(await readFile(configPath, 'utf8')) as {
          general: { externalAgentCdpEnabled: boolean };
        }
      ).general.externalAgentCdpEnabled === true,
    'reenabled setting persisted'
  );
  await stop();

  await launch('reenabled-light');
  const final = await attach();
  assert.notEqual(final.info.context.appInstanceId, disabled.info.context.appInstanceId);
  assert.equal(final.info.cdp.status, 'ready');
  assert.equal(final.info.profileFingerprint, first.info.profileFingerprint);
  assert.equal(final.info.context.dataRootFingerprint, first.info.context.dataRootFingerprint);
  await settingsSnapshot('settings-light', final.info, 'light');
  await copyPrompt(final.info, 'prompt-light', false);
  const reopened = await evaluate(
    client!,
    async (name: string) =>
      (window as unknown as { electronAPI: HarnessApi }).electronAPI.teams.getSavedRequest(name),
    [teamName]
  );
  assert(reopened);
  assert.equal(reopened.runtimeSelectionVersion, 1);
  assert.equal(reopened.providerId, undefined);
  assert.equal(reopened.model, undefined);
  await assertNoLaunch(teamName);
  evidence.reenabled = final;
  evidence.reopenedDraft = reopened;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.stack : String(error);
  await captureDomEvidence('failure');
  throw error;
} finally {
  try {
    await stop();
  } catch (error) {
    shutdownError = error instanceof Error ? error : new Error(String(error));
    evidence.status = 'failed';
    evidence.shutdownError = shutdownError.stack;
  }
  evidence.ownedAppPids = ownedProcesses;
  await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify({ status: evidence.status, evidence: path.join(root, 'evidence.json') })
  );
}
if (shutdownError) throw shutdownError;
