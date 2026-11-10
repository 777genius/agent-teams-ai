/** Hosted Linux: two packaged app owners, one fresh root, no agent launch.
 * pnpm exec tsx scripts/e2e/external-agent-shared-root.ts <packaged-executable> <source-sha>
 * Caller owns DISPLAY. Failed evidence and sandbox data are retained.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  BOUND_CONTROL_CONTEXT_HEADER,
  EXTERNAL_AGENT_RENDERER_MARKER,
  type ConnectionInfoV1,
} from '../../src/features/external-agent-connection/contracts/index.ts';
import { Cdp, waitFor } from './release-updater/cdp.mts';
import { serializedFunction } from './release-updater/serialized-function.mts';

import type { ElectronAPI } from '../../src/shared/types/api.ts';
import type { TeamCreateConfigRequest, TeamCreateRequest } from '../../src/shared/types/team.ts';

type Api = Pick<ElectronAPI, 'externalAgentConnection' | 'httpServer' | 'teams' | 'windowControls'>;
interface Target {
  id: string;
  type: string;
  webSocketDebuggerUrl?: string;
}
interface Snapshot {
  info: ConnectionInfoV1;
  marker: unknown;
  port: number;
}
interface Evaluation<T> {
  result: { value: T };
  exceptionDetails?: { text: string; exception?: { description: string } };
}
interface Instance {
  label: string;
  userData: string;
  child: ChildProcess;
  closed: Promise<unknown>;
  client?: Cdp;
  snapshot?: Snapshot;
  baseUrl?: string;
  mainStartTicks?: string;
  ownedMcp?: OwnedMcp[];
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
async function snapshot(marker: string): Promise<Snapshot | null> {
  const api = (window as unknown as { electronAPI?: Api }).electronAPI;
  if (!api?.externalAgentConnection || !api.httpServer) return null;
  try {
    const [info, status] = await Promise.all([
      api.externalAgentConnection.getConnectionInfo(),
      api.httpServer.getStatus(),
    ]);
    if (!status.running || info.mcp.status !== 'ready' || info.control.status !== 'ready')
      return null;
    return {
      info,
      port: status.port,
      marker: (window as unknown as Record<string, unknown>)[marker],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('No handler registered for')) return null;
    throw error;
  }
}
function loopback(value: string): URL {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && !url.username && !url.password && !url.hash);
  return url;
}
async function json<T>(url: string): Promise<T> {
  loopback(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const [executableArg, sourceSha] = process.argv.slice(2);
assert(
  executableArg && sourceSha && /^[a-f0-9]{40}$/.test(sourceSha),
  'Expected executable and exact source SHA'
);
assert.equal(process.platform, 'linux');
assert(process.env.DISPLAY, 'Caller must provide an owned Xvfb DISPLAY');
const executable = path.resolve(executableArg);
await access(executable);
const root = await mkdtemp(path.join(os.tmpdir(), 'external-agent-shared-root-TEST-'));
console.log(JSON.stringify({ sandbox: root }));
const claude = path.join(root, 'claude');
const project = path.join(root, 'sandbox-project');
await Promise.all([mkdir(claude), mkdir(project)]);
await writeFile(path.join(root, '.test-only'), 'two packaged owners shared-root draft conflict\n');
await writeFile(path.join(project, 'README.md'), '# Shared-root draft-only test\n');
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const address = listener.address();
assert(address && typeof address !== 'string');
const preferredPort = address.port;
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve()))
);
await writeFile(
  path.join(claude, 'agent-teams-config.json'),
  JSON.stringify({
    general: { externalAgentCdpEnabled: true, theme: 'dark', appLocale: 'en' },
    notifications: { enabled: false, soundEnabled: false },
    httpServer: { enabled: false, port: preferredPort },
  })
);
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  root,
  sourceSha,
  executable,
  preferredPort,
  executableSha256: await sha256(executable),
  appAsarSha256: await sha256(path.join(path.dirname(executable), 'resources', 'app.asar')),
  display: process.env.DISPLAY,
  launchFlags: ['--no-sandbox', '--disable-gpu'],
  boundary: 'two packaged Electron main processes, bound HTTP create, preload readback',
};
const instances: Instance[] = [];
async function launch(label: string): Promise<Instance> {
  const home = path.join(root, `${label}-home`);
  const userData = path.join(root, `${label}-user-data`);
  await Promise.all([mkdir(home), mkdir(userData)]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'NODE_OPTIONS' ||
      key === 'ELECTRON_RUN_AS_NODE' ||
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)
    )
      delete env[key];
  }
  Object.assign(env, {
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
  const child = spawn(executable, ['--no-sandbox', '--disable-gpu'], {
    cwd: project,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createWriteStream(path.join(root, `${label}.log`));
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      output.end();
      resolve();
    })
  );
  // Register immediately so every launch failure still cleans up only its own process.
  const instance: Instance = { label, userData, child, closed };
  instances.push(instance);
  await once(child, 'spawn');
  assert(child.pid);
  instance.mainStartTicks = (await processIdentity(child.pid))?.startTicks;
  assert(instance.mainStartTicks, 'Own app process birth identity missing');
  return instance;
}
function alive(instance: Instance): void {
  assert(
    instance.child.pid && instance.child.exitCode === null && instance.child.signalCode === null,
    `${instance.label} exited; inspect ${root}`
  );
}
function transientCdp(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:Execution context was destroyed|Cannot find context with specified id|Inspected target navigated|Native CDP (?:closed|connection timeout|connection failed))/.test(
      error.message
    )
  );
}
async function attach(instance: Instance): Promise<void> {
  const attached = await waitFor(
    async () => {
      alive(instance);
      let lines: string[];
      try {
        lines = (await readFile(path.join(instance.userData, 'DevToolsActivePort'), 'utf8'))
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
      let version: { webSocketDebuggerUrl: string };
      let targets: Target[];
      try {
        version = await json<{ webSocketDebuggerUrl: string }>(`${origin}/json/version`);
        targets = await json<Target[]>(`${origin}/json/list`);
      } catch (error) {
        if (
          error instanceof TypeError &&
          ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(
            (error.cause as NodeJS.ErrnoException | undefined)?.code ?? ''
          )
        )
          return false;
        throw error;
      }
      assert.equal(loopback(version.webSocketDebuggerUrl).pathname, lines[1]);
      assert.equal(loopback(version.webSocketDebuggerUrl).port, String(port));
      for (const target of targets.filter(
        (candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl
      )) {
        const wsUrl = target.webSocketDebuggerUrl!;
        assert.equal(loopback(wsUrl).port, String(port));
        let client: Cdp;
        try {
          client = await Cdp.connect(wsUrl);
        } catch (error) {
          if (transientCdp(error)) continue;
          throw error;
        }
        let selected = false;
        try {
          let value: Snapshot | null;
          try {
            value = await evaluate(client, snapshot, [EXTERNAL_AGENT_RENDERER_MARKER]);
          } catch (error) {
            if (transientCdp(error)) continue;
            throw error;
          }
          if (!value || value.info.cdp.rendererTargetId !== target.id) continue;
          assert.equal(value.info.cdp.status, 'ready');
          assert.equal(value.info.cdp.httpOrigin, origin);
          assert.equal(value.info.cdp.browserWsUrl, version.webSocketDebuggerUrl);
          assert.equal(value.info.cdp.rendererWsUrl, wsUrl);
          assert.deepEqual(value.marker, value.info.context);
          assert(Number.isInteger(value.port) && value.port > 0);
          selected = true;
          return { client, value };
        } finally {
          if (!selected) client.close();
        }
      }
      return false;
    },
    `${instance.label}: own exact renderer and control discovery`,
    120_000
  );
  instance.client = attached.client;
  instance.snapshot = attached.value;
  instance.baseUrl = `http://127.0.0.1:${attached.value.port}`;
  const http = await json<ConnectionInfoV1>(`${instance.baseUrl}/api/app/connection`);
  assert.deepEqual(http.context, attached.value.info.context);
  assert.equal(http.mcp.url, attached.value.info.mcp.url);
  instance.ownedMcp = await captureOwnedMcp(instance);
}
async function refusesConnection(url: string): Promise<boolean> {
  const endpoint = loopback(url);
  return new Promise((resolve) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
interface OwnedMcp {
  pid: number;
  startTicks: string;
  ownerInstanceId: string;
  appInstanceId: string;
  commandSha256: string;
}
async function processIdentity(pid: number): Promise<{ startTicks: string; live: boolean } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    assert(fields[19] && /^\d+$/.test(fields[19]), 'Invalid process birth identity');
    return { startTicks: fields[19], live: fields[0] !== 'Z' };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
async function proveMcp(instance: Instance, pid: number): Promise<OwnedMcp | null> {
  const birth = await processIdentity(pid);
  if (!birth?.live) return null;
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  const args = command.split('\0').filter(Boolean);
  const scriptRoot = `${instance.userData}/mcp-server/`;
  if (
    !args.some(
      (arg) => arg.startsWith(scriptRoot) && /^[^/]+\/index\.js$/.test(arg.slice(scriptRoot.length))
    )
  )
    return null;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert(args.includes('--transport') && flag('--transport') === 'httpStream');
  assert(args.includes('--host') && flag('--host') === '127.0.0.1');
  assert(args.includes('--endpoint') && flag('--endpoint') === '/mcp');
  const environment = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
  const value = (key: string) =>
    environment.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(value('AGENT_TEAMS_MCP_CLAUDE_DIR'), claude);
  assert.equal(value('AGENT_TEAMS_MCP_HTTP_OWNER_PID'), String(instance.child.pid));
  assert.equal(
    value('CLAUDE_TEAM_APP_PROFILE_SCOPE'),
    createHash('sha256')
      .update(JSON.stringify([instance.userData, claude]))
      .digest('hex')
  );
  assert.equal(value('AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE'), 'agent-teams-mcp-http');
  assert.equal(value('AGENT_TEAMS_MCP_HTTP_PORT'), flag('--port'));
  assert.equal(value('AGENT_TEAMS_MCP_HTTP_HOST'), '127.0.0.1');
  assert.equal(value('AGENT_TEAMS_MCP_HTTP_ENDPOINT'), '/mcp');
  assert.equal(value('AGENT_TEAMS_MCP_TRANSPORT'), 'httpStream');
  const ownerInstanceId = value('AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID');
  const appInstanceId = value('CLAUDE_TEAM_APP_INSTANCE_ID');
  assert(ownerInstanceId && appInstanceId, 'Owned MCP process identity missing');
  const context = JSON.parse(
    value('AGENT_TEAMS_BOUND_CONTEXT_JSON') ?? 'null'
  ) as ConnectionInfoV1['context'];
  assert.equal(context?.appInstanceId, appInstanceId);
  assert(Number.isSafeInteger(context?.connectionGeneration) && context.connectionGeneration > 0);
  assert.equal(context?.dataRootFingerprint, createHash('sha256').update(claude).digest('hex'));
  if (instance.snapshot) assert.equal(appInstanceId, instance.snapshot.info.context.appInstanceId);
  assert(instance.mainStartTicks && BigInt(birth.startTicks) >= BigInt(instance.mainStartTicks));
  if ((await processIdentity(pid))?.startTicks !== birth.startTicks) return null;
  return {
    pid,
    startTicks: birth.startTicks,
    ownerInstanceId,
    appInstanceId,
    commandSha256: createHash('sha256').update(command).digest('hex'),
  };
}
async function captureOwnedMcp(instance: Instance): Promise<OwnedMcp[]> {
  const candidates: OwnedMcp[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const owned = await proveMcp(instance, Number(entry));
      if (owned) candidates.push(owned);
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        continue;
      throw error;
    }
  }
  // Stronger listener evidence is captured before failure when state and health are available.
  try {
    const state = JSON.parse(
      await readFile(path.join(instance.userData, 'data/mcp-http-server/state.json'), 'utf8')
    ) as Record<string, unknown>;
    const owned = candidates.find((candidate) => candidate.pid === state.pid);
    assert(owned, 'MCP state PID does not match proven sandbox child');
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
    ])
      assert.equal(health[key], state[key], `Owned MCP health mismatch: ${key}`);
    assert.equal(state.ownerInstanceId, owned.ownerInstanceId);
    assert.equal(state.claudeDirHash, createHash('sha256').update(claude).digest('hex'));
    assert.equal(state.service, 'agent-teams-mcp-http');
    assert.equal(state.schemaVersion, 1);
  } catch (error) {
    // An absent/dead listener cannot invalidate independent immutable process evidence.
    if (
      !['ENOENT', 'ESRCH', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      ) &&
      !(
        error instanceof TypeError &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED'
      )
    )
      throw error;
  }
  return candidates;
}
async function cleanupOwnedMcp(instance: Instance, owned: OwnedMcp): Promise<boolean> {
  const same = async () => {
    try {
      const current = await proveMcp(instance, owned.pid);
      return Boolean(
        current &&
        current.startTicks === owned.startTicks &&
        current.ownerInstanceId === owned.ownerInstanceId &&
        current.appInstanceId === owned.appInstanceId &&
        current.commandSha256 === owned.commandSha256
      );
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  };
  if (!(await same())) return false;
  const signal = async (value: NodeJS.Signals) => {
    if (!(await same())) return;
    try {
      process.kill(owned.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  await signal('SIGTERM');
  const deadline = Date.now() + 5000;
  while (await same()) {
    if (Date.now() >= deadline) {
      await signal('SIGKILL');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitFor(
    async () => !(await same()),
    `${instance.label}: verified owned MCP process exit`,
    5000
  );
  return true;
}
async function stop(instance: Instance): Promise<void> {
  const pid = instance.child.pid;
  if (!pid) return;
  let ownershipError: unknown;
  try {
    instance.ownedMcp = await captureOwnedMcp(instance);
  } catch (error) {
    ownershipError = error;
  }
  let normalQuitRequested = false;
  let hardFallback = false;
  let detachedMcpCleanup = false;
  let mainShutdownError: unknown;
  const shutdownEvidence = {
    label: instance.label,
    mainPid: pid,
    verifiedMcp: instance.ownedMcp ?? [],
    hardFallback: false,
    detachedMcpCleanup: false,
    endpointsClosed: [] as string[],
    ownershipError: ownershipError instanceof Error ? ownershipError.message : null,
  };
  const shutdown = (evidence.shutdown ??= []) as unknown[];
  shutdown.push(shutdownEvidence);
  const signal = async (value: NodeJS.Signals) => {
    const birth = await processIdentity(pid);
    if (!birth?.live || birth.startTicks !== instance.mainStartTicks) return;
    try {
      process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  // The normal quit path revokes authority and stops the detached MCP child.
  // SIGTERM first would bypass this app-owned teardown.
  const mainBirth = await processIdentity(pid);
  if (
    instance.client &&
    mainBirth?.live &&
    mainBirth.startTicks === instance.mainStartTicks &&
    instance.child.exitCode === null &&
    instance.child.signalCode === null
  ) {
    normalQuitRequested = true;
    await evaluate(instance.client, () => {
      void (window as unknown as { electronAPI: Api }).electronAPI.windowControls.close();
      return true;
    }).catch(() => undefined); // Renderer closure may destroy the acknowledgement.
  }
  let deadline: NodeJS.Timeout | undefined;
  const closedWithinBudget = await Promise.race([
    instance.closed.then(() => true),
    new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), 45_000);
    }),
  ]);
  clearTimeout(deadline);
  instance.client?.close();
  if (!closedWithinBudget) {
    hardFallback = true;
    await signal('SIGTERM');
    const exited = await Promise.race([
      instance.closed.then(() => true),
      new Promise<false>((resolve) => {
        deadline = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(deadline);
    if (!exited) await signal('SIGKILL');
    try {
      await waitFor(
        async () => instance.child.exitCode !== null || instance.child.signalCode !== null,
        `${instance.label}: owned main exit after forced shutdown`,
        5000
      );
    } catch (error) {
      mainShutdownError = error;
    }
  }
  for (const owned of instance.ownedMcp ?? [])
    detachedMcpCleanup = (await cleanupOwnedMcp(instance, owned)) || detachedMcpCleanup;
  const normalQuit =
    normalQuitRequested &&
    closedWithinBudget &&
    instance.child.exitCode === 0 &&
    instance.child.signalCode === null &&
    !hardFallback &&
    !detachedMcpCleanup;
  Object.assign(shutdownEvidence, {
    normalQuitRequested,
    normalQuit,
    exitCode: instance.child.exitCode,
    signalCode: instance.child.signalCode,
    hardFallback,
    detachedMcpCleanup,
  });
  if (ownershipError) throw ownershipError;
  if (mainShutdownError) throw mainShutdownError;
  if (instance.snapshot && instance.baseUrl) {
    for (const endpoint of [
      instance.baseUrl,
      instance.snapshot.info.mcp.url!,
      instance.snapshot.info.cdp.httpOrigin!,
    ]) {
      await waitFor(
        () => refusesConnection(endpoint),
        `${instance.label}: owned endpoint closed`,
        8000
      );
      shutdownEvidence.endpointsClosed.push(endpoint);
    }
  }
  assert(
    normalQuit,
    `${instance.label} did not complete requested normal app quit; preserve sandbox and inspect detached children`
  );
}

async function create(
  instance: Instance,
  draft: TeamCreateConfigRequest,
  context = instance.snapshot!.info.context
) {
  alive(instance);
  const response = await fetch(`${instance.baseUrl}/api/teams`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(context),
    },
    body: JSON.stringify({ ...draft, expectedContext: context }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
async function files(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, digest] of Object.entries(await files(file)))
        result[`${entry.name}/${name}`] = digest;
    else if (entry.isFile()) result[entry.name] = await sha256(file);
  }
  return result;
}
let failure: unknown;
try {
  const first = await launch('first');
  await attach(first);
  const second = await launch('second');
  await attach(second);
  const a = first.snapshot!.info,
    b = second.snapshot!.info;
  assert.notEqual(first.child.pid, second.child.pid);
  assert.notEqual(a.context.appInstanceId, b.context.appInstanceId);
  assert.notEqual(a.profileFingerprint, b.profileFingerprint);
  assert.equal(a.context.dataRootFingerprint, b.context.dataRootFingerprint);
  assert.equal(first.snapshot!.port, preferredPort);
  assert(second.snapshot!.port > preferredPort && second.snapshot!.port <= preferredPort + 10);
  assert.notEqual(first.baseUrl, second.baseUrl);
  assert.notEqual(a.cdp.httpOrigin, b.cdp.httpOrigin);
  assert(a.mcp.url && b.mcp.url);
  assert.notEqual(a.mcp.url, b.mcp.url);
  const owners = await Promise.all(
    [a, b].map((info) => json<{ ownerInstanceId: string }>(new URL('/health', info.mcp.url!).href))
  );
  assert(owners[0]!.ownerInstanceId && owners[1]!.ownerInstanceId);
  assert.notEqual(owners[0]!.ownerInstanceId, owners[1]!.ownerInstanceId);
  if (process.env.EXTERNAL_AGENT_VERIFY_FAILURE_CLEANUP === '1') {
    assert(first.ownedMcp?.length === 1 && second.ownedMcp?.length === 1);
    assert.equal(first.ownedMcp[0]!.ownerInstanceId, owners[0]!.ownerInstanceId);
    assert.equal(second.ownedMcp[0]!.ownerInstanceId, owners[1]!.ownerInstanceId);
    alive(first);
    assert.equal((await processIdentity(first.child.pid!))?.startTicks, first.mainStartTicks);
    evidence.failureInjection = {
      label: first.label,
      mainPid: first.child.pid,
      mcp: first.ownedMcp[0],
    };
    process.kill(-first.child.pid!, 'SIGKILL');
    throw new Error('Intentional owned app crash for detached MCP cleanup verification');
  }
  const teamName = 'shared-root-conflict';
  const drafts: TeamCreateConfigRequest[] = ['first', 'second'].map((label) => ({
    runtimeSelectionVersion: 1,
    teamName,
    cwd: project,
    displayName: `${label} writer`,
    prompt: `Saved only by ${label}; never launch.`,
    members: [{ name: `${label}-worker`, role: 'tester', workflow: `${label} workflow` }],
  }));
  const results = await Promise.all([create(first, drafts[0]!), create(second, drafts[1]!)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = drafts[results.findIndex((result) => result.status === 201)]!;
  const saved = await Promise.all(
    instances.map((instance) =>
      evaluate(
        instance.client!,
        async (name: string) =>
          (window as unknown as { electronAPI: Api }).electronAPI.teams.getSavedRequest(name),
        [teamName]
      )
    )
  );
  for (const request of saved as (TeamCreateRequest | null)[]) {
    assert(request);
    assert.equal(request.prompt, winner.prompt);
    assert.equal(request.displayName, winner.displayName);
    assert.equal(request.members[0]?.name, winner.members[0]?.name);
    assert.equal(request.members[0]?.workflow, winner.members[0]?.workflow);
  }
  const directory = path.join(claude, 'teams', teamName);
  const meta = JSON.parse(await readFile(path.join(directory, 'team.meta.json'), 'utf8')) as {
    prompt: string;
  };
  assert.equal(meta.prompt, winner.prompt);
  const tasks = path.join(claude, 'tasks', teamName);
  const before = { team: await files(directory), tasks: await files(tasks) };
  const loser = results.findIndex((result) => result.status === 409);
  assert.equal((await create(instances[loser]!, drafts[loser]!)).status, 409);
  // Cross-app immutable expectations must also refuse admission before mutation.
  assert.equal(
    (await create(second, { ...drafts[1]!, teamName: 'foreign-binding' }, a.context)).status,
    409
  );
  assert.deepEqual(
    { team: await files(directory), tasks: await files(tasks) },
    before,
    'Conflict must not overwrite winner artifacts'
  );
  for (const file of [
    'config.json',
    'launch-state.json',
    'bootstrap-state.json',
    'bootstrap-journal.jsonl',
  ])
    await assert.rejects(access(path.join(directory, file)), { code: 'ENOENT' });
  await assert.rejects(access(path.join(claude, 'teams', 'foreign-binding')), { code: 'ENOENT' });
  Object.assign(evidence, {
    status: 'passed',
    instances: instances.map((instance, index) => ({
      pid: instance.child.pid,
      userData: instance.userData,
      control: instance.baseUrl,
      connection: instance.snapshot!.info,
      healthOwner: owners[index]!.ownerInstanceId,
    })),
    results,
    saved,
    winner: winner.displayName,
    artifactHashes: before,
    noLaunch: true,
    foreignBindingStatus: 409,
  });
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.stack : String(error);
  failure = error;
} finally {
  const stopped = await Promise.allSettled(instances.map(stop));
  if (stopped.some((result) => result.status === 'rejected')) evidence.status = 'failed';
  evidence.cleanup = stopped.map((result) =>
    result.status === 'fulfilled'
      ? 'normal app quit; owned endpoints closed'
      : String(result.reason)
  );
  await writeFile(path.join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({ evidence: path.join(root, 'evidence.json'), status: evidence.status })
  );
  const failures = stopped.filter((result) => result.status === 'rejected');
  if (failures.length)
    failure ??= new AggregateError(
      failures.map((result) => result.reason),
      'Owned app cleanup failed'
    );
}

if (failure) throw failure;
