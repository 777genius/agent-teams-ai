/** Hosted source Electron proof. Caller owns Xvfb DISPLAY and scratch TMPDIR.
 * pnpm exec tsx scripts/e2e/team-prompt-management-desktop.ts <exact-source-sha>
 * No inference, agent launch, terminal, real project or production test hooks.
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  EXTERNAL_AGENT_RENDERER_MARKER,
  type ConnectionInfoV1,
} from '../../src/features/external-agent-connection/contracts/index.ts';
import { nativeAgentRunArgs } from '../../src/features/external-agent-connection/main/nativeAgentRunArgs.ts';
import { TEAM_TEMPLATES } from '../../src/features/team-templates/index.ts';
import type { ElectronAPI } from '../../src/shared/types/api.ts';
import { withNativeCodexMcp } from './lib/nativeCodexMcp.ts';
import { Cdp, waitFor } from './release-updater/cdp.mts';
import { serializedFunction } from './release-updater/serialized-function.mts';

const execute = promisify(execFile);
const [sourceSha] = process.argv.slice(2);
assert(sourceSha && /^[a-f0-9]{40}$/.test(sourceSha), 'Exact source SHA required');
assert.equal(process.platform, 'linux', 'Hosted Linux only');
assert(process.env.DISPLAY, 'Caller must supply an owned Xvfb DISPLAY');
assert(
  process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR),
  'Caller must supply scratch TMPDIR'
);
const repo = await realpath(process.cwd());
assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(), sourceSha);
assert.equal(
  (
    await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })
  ).stdout.trim(),
  '',
  'Source checkout must match exact SHA without untracked additions'
);
const scratch = await realpath(process.env.TMPDIR);
const scratchAnchor = await realpath(
  process.env.TEAM_MANAGEMENT_E2E_SCRATCH_ROOT ?? '/srv/workers'
);
const scratchStat = await stat(scratchAnchor);
assert.equal(
  (await stat(scratch)).dev,
  scratchStat.dev,
  'TMPDIR must reside on verified scratch filesystem'
);
assert.equal((await stat(repo)).dev, scratchStat.dev, 'Source dev build must reside on scratch');
const filesystem = await statfs(scratch);
const root = await mkdtemp(path.join(scratch, 'team-prompt-management-TEST-'));
const home = path.join(root, 'home');
const userData = path.join(root, 'user-data');
const claude = path.join(root, 'claude');
const project = path.join(root, 'TEST-sandbox-project');
for (const directory of [home, userData, claude, project]) await mkdir(directory);
await writeFile(path.join(root, '.test-only'), 'team-prompt-management-desktop-v1\n');
await writeFile(path.join(project, 'README.md'), '# Disposable management proof\n');

async function reservePort(port: number): Promise<number> {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
const controlPort = await reservePort(0);
await writeFile(
  path.join(claude, 'agent-teams-config.json'),
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
const owner = randomUUID();
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env))
  if (
    key === 'NODE_OPTIONS' ||
    key === 'ELECTRON_RUN_AS_NODE' ||
    /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)
  )
    delete env[key];
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'),
  TMPDIR: root,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  CLAUDE_CONFIG_DIR: claude,
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
  AGENT_TEAMS_MCP_CLAUDE_DIR: claude,
  CLAUDE_DEV_RUNTIME_CACHE_ROOT: path.join(root, 'runtime-cache'),
  TEAM_MANAGEMENT_E2E_OWNER: owner,
  ELECTRON_DISABLE_SANDBOX: '1',
});
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  sourceSha,
  root,
  machineId: (await readFile('/etc/machine-id', 'utf8')).trim(),
  isolation: { home, userData, claude, project, display: process.env.DISPLAY },
  scratch: {
    path: scratch,
    anchor: scratchAnchor,
    device: scratchStat.dev,
    availableBytes: filesystem.bavail * filesystem.bsize,
  },
  launch: ['pnpm', 'dev:mcp'],
  calls: [],
  screenshots: [],
};
let child: ChildProcess | null = null;
let client: Cdp | null = null;
let mainPid: number | null = null;
interface OwnedProcess {
  pid: number;
  startTicks: string;
  processGroup: number;
}
let spawnLease: OwnedProcess | null = null;
const ownedProcesses = new Map<number, OwnedProcess>();

function getClient(): Cdp {
  assert(client, 'A validated owned renderer is required');
  return client;
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function evaluate<T>(
  callback: (...args: never[]) => T | Promise<T>,
  args: unknown[] = []
): Promise<T> {
  assert(client);
  const result = await getClient().send<{
    result: { value: T };
    exceptionDetails?: { text: string; exception?: { description: string } };
  }>('Runtime.evaluate', {
    expression: `${serializedFunction(callback)}(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(wanted: string, selector = false, cardName: string | null = null) {
  const point = await waitFor(
    () =>
      evaluate(
        async (label: string, css: boolean, team: string | null) => {
          const matches = [
            ...document.querySelectorAll(css ? label : 'button,[role="menuitem"]'),
          ].filter(
            (node) =>
              (css ||
                node.getAttribute('aria-label') === label ||
                node.textContent?.trim() === label) &&
              (!team ||
                node.closest('.group')?.querySelector('h3')?.textContent?.trim() === team) &&
              !node.hasAttribute('disabled')
          );
          const visible = matches.filter(
            (node) =>
              node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden'
          );
          if (visible.length > 1) throw new Error(`Ambiguous control: ${label}`);
          const element = visible[0];
          if (!(element instanceof HTMLElement)) return null;
          element.scrollIntoView({ block: 'center', behavior: 'instant' });
          // Scrolling, reflow and dialog transitions must settle before real mouse input.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const previous = element.getBoundingClientRect();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const rect = element.getBoundingClientRect();
          if (
            !element.isConnected ||
            !rect.width ||
            !rect.height ||
            rect.x !== previous.x ||
            rect.y !== previous.y ||
            rect.width !== previous.width ||
            rect.height !== previous.height
          )
            return null;
          const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          return hit && (hit === element || element.contains(hit)) ? point : null;
        },
        [wanted, selector, cardName]
      ),
    `click ${wanted}`
  );
  assert(client);
  await getClient().send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await getClient().send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  await getClient().send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point,
  });
}
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  assert(client);
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode,
  });
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode,
  });
}
async function screenshot(label: string) {
  assert(client);
  await waitFor(
    () =>
      evaluate(() =>
        [...document.querySelectorAll('[data-template-reference] button > svg')].every((icon) =>
          icon.getAnimations().every((animation) => animation.playState !== 'running')
        )
      ),
    'Template chevrons settle before screenshot',
    5_000
  );
  const { data } = await getClient().send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const output = path.join(root, `${label}.png`);
  await writeFile(output, Buffer.from(data, 'base64'));
  (evidence.screenshots as string[]).push(output);
}
async function openTeams() {
  await click('More actions');
  await click('Teams');
}
async function listFacts() {
  return evaluate(() => ({
    cards: [...document.querySelectorAll('.team-row-zebra-card')].map((card) => ({
      name: card.querySelector('h3')?.textContent?.trim(),
      text: card.textContent ?? '',
      badges: [...card.querySelectorAll('span')]
        .map((node) => node.textContent?.trim())
        .filter((text) => text === 'Created' || text === 'Edited'),
    })),
    sections: [...document.querySelectorAll('section')].map((section) => ({
      title: section.querySelector('h3')?.textContent?.trim(),
      names: [...section.querySelectorAll('.team-row-zebra-card h3')].map((node) =>
        node.textContent?.trim()
      ),
    })),
    text: document.body.innerText,
  }));
}
async function processIdentity(pid: number): Promise<OwnedProcess | null> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    assert(fields[19] && /^\d+$/.test(fields[19]), 'Process start lease required');
    return { pid, startTicks: fields[19], processGroup: Number(fields[2]) };
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return null;
    throw error;
  }
}
async function groupLeaseCurrent(): Promise<boolean> {
  if (!spawnLease) return false;
  // A surviving previously captured member keeps the exact fresh process group leased.
  for (const captured of [spawnLease, ...ownedProcesses.values()]) {
    if (captured.processGroup !== spawnLease.processGroup) continue;
    const live = await processIdentity(captured.pid);
    if (live?.processGroup === captured.processGroup && live.startTicks === captured.startTicks)
      return true;
  }
  return false;
}
async function ownedIdentity(pid: number): Promise<OwnedProcess | null> {
  const identity = await processIdentity(pid);
  if (!identity) return null;
  if (identity.processGroup === spawnLease?.processGroup && (await groupLeaseCurrent()))
    return identity;
  // Only consulted for an already-known owned PID or the MCP state in our new userData.
  try {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environment.split('\0').includes(`TEAM_MANAGEMENT_E2E_OWNER=${owner}`) ? identity : null;
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return null;
    throw error;
  }
}
async function captureOwnedProcesses() {
  if (await groupLeaseCurrent()) {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const identity = await processIdentity(Number(entry));
      if (
        identity &&
        identity.processGroup === spawnLease?.processGroup &&
        (await groupLeaseCurrent())
      )
        ownedProcesses.set(identity.pid, identity);
    }
  }
  // MCP can detach from the Vite group; its state path and unique marker both remain scoped.
  try {
    const state = object(
      JSON.parse(await readFile(path.join(userData, 'data/mcp-http-server/state.json'), 'utf8'))
    );
    if (Number.isSafeInteger(state.pid) && Number(state.pid) > 0) {
      const identity = await ownedIdentity(Number(state.pid));
      if (identity) ownedProcesses.set(identity.pid, identity);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function cleanup() {
  await captureOwnedProcesses();
  const facts = {
    ownedLeases: [...ownedProcesses.values()],
    gracefulRequested: false,
    mainExitedNormally: false,
    fallbackPids: [] as number[],
    remainingPids: [] as number[],
  };
  evidence.cleanup = facts;
  if (client && mainPid) {
    facts.gracefulRequested = true;
    try {
      await evaluate(async () =>
        (window as unknown as { electronAPI: ElectronAPI }).electronAPI.windowControls.close()
      );
    } catch (error) {
      evidence.quitRequest = String(error);
    }
    const deadline = Date.now() + 10_000;
    while (await ownedIdentity(mainPid)) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    facts.mainExitedNormally = !(await ownedIdentity(mainPid));
  }
  client?.close();
  client = null;
  // dev:mcp's Vite/pnpm supervisors can remain after the normal app quit.
  await captureOwnedProcesses();
  facts.ownedLeases = [...ownedProcesses.values()];
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const identity of ownedProcesses.values()) {
      const live = await ownedIdentity(identity.pid);
      if (!live || live.startTicks !== identity.startTicks) continue;
      if (!facts.fallbackPids.includes(identity.pid)) facts.fallbackPids.push(identity.pid);
      try {
        process.kill(identity.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, signal === 'SIGTERM' ? 2000 : 300));
  }
  for (const identity of ownedProcesses.values())
    if ((await ownedIdentity(identity.pid))?.startTicks === identity.startTicks)
      facts.remainingPids.push(identity.pid);
  assert.equal(facts.remainingPids.length, 0, 'Owned processes must stop');
}

async function attach(): Promise<ConnectionInfoV1> {
  return waitFor(
    async () => {
      assert(
        child?.pid && child.exitCode === null && child.signalCode === null,
        'Owned dev:mcp exited'
      );
      let state: { pid: number; baseUrl: string };
      try {
        state = JSON.parse(await readFile(path.join(claude, 'team-control-api.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      const mainIdentity = await ownedIdentity(state.pid);
      if (!mainIdentity) return false;
      assert(spawnLease);
      assert.equal(
        mainIdentity.processGroup,
        spawnLease.processGroup,
        'Main must belong to the fresh detached source group'
      );
      const mainCwd = await realpath(`/proc/${state.pid}/cwd`);
      assert(
        mainCwd === repo || mainCwd.startsWith(`${repo}/`),
        'Main cwd must belong to exact source checkout'
      );
      const mainArgs = (await readFile(`/proc/${state.pid}/cmdline`, 'utf8')).split('\0');
      assert(
        mainArgs.some(
          (arg) => arg.startsWith(`${repo}/`) || arg === '.' || arg.startsWith('dist-electron/')
        ),
        'Main command must identify source checkout'
      );
      ownedProcesses.set(mainIdentity.pid, mainIdentity);
      evidence.mainIdentity = {
        ...mainIdentity,
        cwd: mainCwd,
        ownership: 'fresh source process-group lease',
      };
      const control = new URL(state.baseUrl);
      assert.equal(control.hostname, '127.0.0.1');
      let response: Response;
      try {
        response = await fetch(`${control.origin}/api/app/connection`, {
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        return false;
      }
      if (!response.ok) return false;
      const expected = (await response.json()) as ConnectionInfoV1;
      if (
        expected.mcp.status !== 'ready' ||
        expected.control.status !== 'ready' ||
        expected.cdp.status !== 'ready' ||
        !expected.cdp.httpOrigin ||
        !expected.cdp.browserWsUrl ||
        !expected.cdp.rendererWsUrl ||
        !expected.cdp.rendererTargetId
      )
        return false;
      assert.equal(
        expected.context.dataRootFingerprint,
        createHash('sha256').update(claude).digest('hex'),
        'Discovery must be bound to the fresh TEST root'
      );
      const inspector = new URL(expected.cdp.httpOrigin);
      assert.equal(inspector.protocol, 'http:');
      assert.equal(inspector.hostname, '127.0.0.1');
      assert(!inspector.username && !inspector.password && !inspector.search && !inspector.hash);
      assert.equal(inspector.pathname, '/');
      const inspectorPort = Number(inspector.port);
      assert(Number.isInteger(inspectorPort) && inspectorPort > 0 && inspectorPort < 65536);
      const browserWs = new URL(expected.cdp.browserWsUrl);
      assert.equal(browserWs.protocol, 'ws:');
      assert.equal(browserWs.hostname, inspector.hostname);
      assert.equal(browserWs.port, inspector.port);
      assert(browserWs.pathname.startsWith('/devtools/browser/'));
      assert(!browserWs.username && !browserWs.password && !browserWs.search && !browserWs.hash);
      let targetResponse: Response;
      try {
        targetResponse = await fetch(`${inspector.origin}/json/list`, {
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        return false;
      }
      if (!targetResponse.ok) return false;
      const targets = (await targetResponse.json()) as {
        id: string;
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      for (const target of targets) {
        if (
          target.type !== 'page' ||
          target.id !== expected.cdp.rendererTargetId ||
          !target.webSocketDebuggerUrl
        )
          continue;
        assert.equal(target.webSocketDebuggerUrl, expected.cdp.rendererWsUrl);
        const rendererWs = new URL(target.webSocketDebuggerUrl);
        assert.equal(rendererWs.protocol, 'ws:');
        assert.equal(rendererWs.hostname, inspector.hostname);
        assert.equal(rendererWs.port, inspector.port);
        assert.equal(rendererWs.pathname, `/devtools/page/${target.id}`);
        assert(
          !rendererWs.username && !rendererWs.password && !rendererWs.search && !rendererWs.hash
        );
        client?.close();
        client = await Cdp.connect(target.webSocketDebuggerUrl);
        const snapshot = await evaluate(
          async (marker: string) => ({
            info: await (
              window as unknown as { electronAPI: ElectronAPI }
            ).electronAPI.externalAgentConnection.getConnectionInfo(),
            marker: (window as unknown as Record<string, unknown>)[marker],
          }),
          [EXTERNAL_AGENT_RENDERER_MARKER]
        );
        if (!snapshot.marker) return false;
        assert.deepEqual(
          snapshot.info.context,
          expected.context,
          'CDP target must belong to this exact app instance/root'
        );
        assert.deepEqual(snapshot.marker, expected.context);
        assert.equal(snapshot.info.cdp.httpOrigin, inspector.origin);
        assert.equal(snapshot.info.cdp.browserWsUrl, browserWs.href);
        if (snapshot.info.mcp.status !== 'ready' || snapshot.info.control.status !== 'ready')
          return false;
        assert(
          snapshot.info.capabilities.configurationEdit &&
            snapshot.info.capabilities.reversibleTrash,
          'Management capability proof requires wired tools'
        );
        mainPid = state.pid;
        evidence.renderer = {
          targetId: target.id,
          cdpOrigin: inspector.origin,
          cdpPort: inspectorPort,
          context: snapshot.info.context,
          mcpUrl: snapshot.info.mcp.url,
        };
        return snapshot.info;
      }
      return false;
    },
    'owned source app discovery and exact renderer',
    180_000
  );
}
async function popup(info: ConnectionInfoV1, theme: 'dark' | 'light', narrow: boolean) {
  assert(client);
  await getClient().send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('[data-testid="external-agent-prompt-open"]', true);
  await waitFor(
    () => evaluate(() => document.activeElement?.id === 'external-agent-task'),
    'free request autofocus'
  );
  if (narrow)
    await getClient().send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const request = `Use Software Product Team and Content Studio templates to create two teams in ${project}. Edit the first team, retain partial successes, and trash only the second. Do not launch.`;
  if (theme === 'light')
    await waitFor(
      () =>
        evaluate(
          (value: string) =>
            (document.getElementById('external-agent-task') as HTMLTextAreaElement | null)
              ?.value === value,
          [request]
        ),
      'request survives reload under stable profile/root'
    );
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 0,
  });
  await getClient().send('Input.insertText', { text: request });
  const templateIds = ['software-product', 'marketing', 'content', 'research'];
  assert(
    await evaluate(() =>
      [...document.querySelectorAll('[data-template-reference]')].every(
        (card) =>
          card.getAttribute('data-state') === 'closed' &&
          !card.querySelector('[data-role="template-participant"]') &&
          Boolean(card.querySelector('button svg'))
      )
    ),
    'Every team starts collapsed with a thematic icon'
  );
  for (const templateId of templateIds)
    await click(`[data-template-reference="${templateId}"] > button`, true);
  const references = await evaluate(() => ({
    ids: [...document.querySelectorAll('[data-template-reference]')]
      .map((node) => node.getAttribute('data-template-reference'))
      .sort(),
    participants: document.querySelectorAll('[data-role="template-participant"]').length,
    identities: [...document.querySelectorAll('[data-role="template-participant"]')].filter(
      (node) => node.querySelector('img[alt=""]')
    ).length,
    editableControls: document.querySelectorAll(
      '[data-template-reference] input,[data-template-reference] textarea,[data-template-reference] select,[data-template-reference] [role="checkbox"]'
    ).length,
    theme: document.documentElement.className,
  }));
  assert.deepEqual(references.ids, ['content', 'marketing', 'research', 'software-product']);
  assert.equal(
    references.participants,
    TEAM_TEMPLATES.reduce((sum, template) => sum + template.members.length + 1, 0)
  );
  assert.equal(
    references.identities,
    references.participants,
    'Shared participant identity presentation'
  );
  assert.equal(references.editableControls, 0, 'References must be read-only');
  assert(references.theme.split(' ').includes(theme));
  await click(
    '[data-template-reference="software-product"] button[aria-label="Responsibilities for team-lead"]',
    true
  );
  await waitFor(
    () =>
      evaluate(
        (text: string) =>
          document
            .querySelector('[data-template-reference="software-product"]')
            ?.textContent?.includes(text) ?? false,
        [TEAM_TEMPLATES.find((template) => template.id === 'software-product')!.teamPrompt]
      ),
    'read-only coordinator responsibilities'
  );
  await click(
    '[data-template-reference="software-product"] button[aria-label="Responsibilities for team-lead"]',
    true
  );
  await key('Tab', 'Tab', 9);
  assert(
    await evaluate(() =>
      Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))
    ),
    'Keyboard focus stays in popup'
  );
  assert(
    await evaluate(() => {
      const task = document.querySelector('#external-agent-task');
      const preview = document.querySelector<HTMLElement>(
        '[data-testid="external-agent-prompt-preview"]'
      );
      const copy = document.querySelector('[data-testid="external-agent-prompt-copy"]');
      const label = document.querySelector('#external-agent-prompt-preview-label');
      const references = document.querySelector('[data-template-reference]');
      return Boolean(
        task &&
        preview &&
        copy &&
        label &&
        references &&
        !preview.isContentEditable &&
        !preview.matches('input,textarea') &&
        preview.textContent &&
        preview.scrollHeight > preview.clientHeight &&
        preview.clientHeight <= 150 &&
        preview.getClientRects().length &&
        task.parentElement?.nextElementSibling?.contains(preview) &&
        label.parentElement?.contains(copy) &&
        preview.compareDocumentPosition(references) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    }),
    'Final prompt is visible immediately after the request, with adjacent copy before templates'
  );
  await evaluate(() =>
    document.querySelector<HTMLElement>('[data-testid="external-agent-prompt-preview"]')?.focus()
  );
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await getClient().send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 0,
    windowsVirtualKeyCode: 65,
  });
  assert(
    await evaluate(
      () =>
        window.getSelection()?.toString() ===
        document.querySelector('[data-testid="external-agent-prompt-preview"]')?.textContent
    ),
    'Native Select All must select only the final prompt'
  );
  assert(info.cdp.browserWsUrl);
  const browser = await Cdp.connect(info.cdp.browserWsUrl);
  try {
    await browser.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await getClient().send('Page.bringToFront');
    await click('[data-testid="external-agent-prompt-copy"]', true);
    const copied = await waitFor(async () => {
      const text = await evaluate(async () => navigator.clipboard.readText());
      return text.includes(request) ? text : false;
    }, 'actual clipboard output');
    assert(
      copied.includes(info.mcp.url!) && copied.includes(info.cdp.rendererWsUrl!),
      'Copy uses live MCP/CDP endpoints'
    );
    assert(copied.includes('Use team_update') && copied.includes('Use team_trash'));
    assert.equal(
      await evaluate(
        () => document.querySelector('[data-testid="external-agent-prompt-preview"]')?.textContent
      ),
      copied,
      'Final text matches the actual copied prompt'
    );
    evidence[`${theme}Popup`] = {
      ...references,
      clipboardVerified: true,
      copiedBytes: Buffer.byteLength(copied),
    };
  } finally {
    browser.close();
  }
  const width = await evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    return { client: dialog.clientWidth, scroll: dialog.scrollWidth, viewport: innerWidth };
  });
  assert(width.scroll <= width.client + 2, 'Popup must reflow without horizontal overflow');
  await evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    dialog.scrollTop = 0;
  });
  for (const templateId of templateIds)
    await click(`[data-template-reference="${templateId}"] > button`, true);
  await evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    dialog.scrollTop = 0;
  });
  await screenshot(`popup-${theme}-${narrow ? '320' : '1280'}`);
  await evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    dialog.scrollTop = dialog.scrollHeight;
  });
  await screenshot(`templates-collapsed-${theme}`);
  await click('[data-template-reference="marketing"] > button', true);
  await evaluate(() => {
    document
      .querySelector('[data-template-reference="marketing"]')
      ?.scrollIntoView({ block: 'start' });
  });
  await screenshot(`template-marketing-expanded-${theme}`);

  await key('Escape', 'Escape', 27);
  await waitFor(
    () => evaluate(() => !document.querySelector('[data-testid="external-agent-prompt-dialog"]')),
    'keyboard closes popup'
  );
}
function assertProviderless(readback: Record<string, unknown>, names: string[]) {
  assert.equal(readback.pendingCreate, true);
  assert.equal(typeof readback.configurationRevision, 'string');
  const saved = object(readback.savedRequest);
  assert.equal(saved.runtimeSelectionVersion, 1);
  assert.equal(saved.providerId, undefined);
  assert.equal(saved.model, undefined);
  assert(Array.isArray(saved.members));
  assert.deepEqual(
    saved.members.map((value) => String(object(value).name)).sort(),
    [...names].sort()
  );
  for (const member of saved.members) assert.equal(object(member).providerId, undefined);
  return saved;
}
try {
  const log = createWriteStream(path.join(root, 'dev-mcp.log'));
  child = spawn('pnpm', ['dev:mcp'], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('close', () => log.end());
  await once(child, 'spawn');
  assert(child.pid);
  spawnLease = await processIdentity(child.pid);
  assert(
    spawnLease && spawnLease.processGroup === child.pid,
    'Fresh detached pnpm group lease required'
  );
  ownedProcesses.set(spawnLease.pid, spawnLease);
  evidence.spawnIdentity = {
    ...spawnLease,
    detached: true,
    ownership: 'spawned child PID/startTicks/processGroup',
  };
  await captureOwnedProcesses();
  const info = await attach();
  await openTeams();
  await popup(info, 'dark', true);
  assert(client);
  await getClient().send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert(info.mcp.url);
  evidence.native = await withNativeCodexMcp(
    {
      url: info.mcp.url,
      expectedContext: info.context,
      cwd: project,
      workRoot: path.join(root, 'native-codex'),
      perRunConfig: {
        serverName: 'agent-teams',
        args: nativeAgentRunArgs('codex', info).flatMap((arg, index, args) =>
          arg === '-c' ? [arg, args[index + 1]] : []
        ),
      },
      requiredTools: [
        'app_get_connection_info',
        'team_list',
        'team_get',
        'team_create',
        'team_update',
        'team_trash',
      ],
    },
    async ({ call: nativeCall, nativeVersion, toolNames }) => {
      assert.deepEqual(
        toolNames,
        [
          'app_get_connection_info',
          'team_create',
          'team_get',
          'team_list',
          'team_trash',
          'team_update',
        ],
        'Native per-run Codex config must expose only management tools'
      );
      const calls = evidence.calls as Record<string, unknown>[];
      const call = async (tool: string, args: Record<string, unknown>) => {
        try {
          const result = object(await nativeCall(tool, args));
          calls.push({
            tool,
            teamName: args.teamName,
            outcome: 'success',
            revision: result.configurationRevision,
          });
          return result;
        } catch (error) {
          calls.push({ tool, teamName: args.teamName, outcome: 'rejected', error: String(error) });
          throw error;
        }
      };
      const listed = await nativeCall('team_list', {});
      assert(Array.isArray(listed), 'Native team_list must return an array');
      calls.push({ tool: 'team_list', outcome: 'success', count: listed.length });
      const first = 'management-e2e-feature';
      const second = 'management-e2e-review';
      for (const teamName of [first, second]) {
        const created = await call('team_create', {
          teamName,
          cwd: project,
          runtimeSelectionVersion: 1,
          expectedContext: info.context,
          prompt: 'Coordinate only this disposable test.',
          members: [{ name: 'developer', role: 'developer', workflow: 'Sandbox implementation.' }],
        });
        assert.equal(created.runtimeSelectionVersion, 1);
        assert.equal(created.runtimeSelection, 'unresolved');
        assertProviderless(await call('team_get', { teamName, configuration: true }), [
          'developer',
        ]);
      }
      evidence.createdUi = await waitFor(async () => {
        const facts = await listFacts();
        return [first, second].every(
          (name) =>
            facts.cards.filter((card) => card.name === name && card.text.includes('Created'))
              .length === 1
        )
          ? facts
          : false;
      }, 'two canonical Created cards');
      let fresh = await call('team_get', { teamName: first, configuration: true });
      await call('team_update', {
        teamName: first,
        expectedContext: info.context,
        expectedRevision: fresh.configurationRevision,
        metadata: { displayName: 'Edited test feature', description: 'Native management proof' },
      });
      evidence.metadataUi = await waitFor(async () => {
        const facts = await listFacts();
        return facts.cards.some(
          (card) =>
            card.name === 'Edited test feature' &&
            card.text.includes('Edited') &&
            card.text.includes('Description changed')
        )
          ? facts
          : false;
      }, 'committed metadata fact');
      fresh = await call('team_get', { teamName: first, configuration: true });
      await call('team_update', {
        teamName: first,
        expectedContext: info.context,
        expectedRevision: fresh.configurationRevision,
        members: [
          { name: 'developer', role: 'implementer', workflow: 'Narrow sandbox work.' },
          { name: 'auditor', role: 'reviewer', workflow: 'Independent sandbox review.' },
        ],
      });
      const edited = await call('team_get', { teamName: first, configuration: true });
      const editedSaved = assertProviderless(edited, ['developer', 'auditor']);
      const editedByName = new Map(
        (editedSaved.members as unknown[]).map((value) => {
          const member = object(value);
          return [member.name, member] as const;
        })
      );
      assert.equal(editedByName.get('developer')?.role, 'implementer');
      assert.equal(editedByName.get('developer')?.workflow, 'Narrow sandbox work.');
      assert.equal(editedByName.get('auditor')?.role, 'reviewer');
      assert.equal(editedByName.get('auditor')?.workflow, 'Independent sandbox review.');
      await assert.rejects(
        call('team_update', {
          teamName: second,
          expectedContext: info.context,
          expectedRevision: 'deliberately-stale-test-revision',
          metadata: { description: 'Must never save' },
        }),
        /TEAM_REVISION_MISMATCH/
      );
      const unchanged = assertProviderless(
        await call('team_get', { teamName: second, configuration: true }),
        ['developer']
      );
      assert.notEqual(unchanged.description, 'Must never save');
      evidence.partialUi = await waitFor(async () => {
        const facts = await listFacts();
        const recent = facts.sections.find((section) => section.title === 'Recent changes');
        return facts.cards.filter((card) => card.name === 'Edited test feature').length === 1 &&
          facts.cards.some(
            (card) => card.name === 'Edited test feature' && card.text.includes('Roles: +1/-0')
          ) &&
          facts.cards.filter((card) => card.name === second).length === 1 &&
          recent?.names[0] === 'Edited test feature'
          ? facts
          : false;
      }, 'partial outcome preserved and factual recent group without duplicates');
      await screenshot('partial-management-results');
      fresh = await call('team_get', { teamName: second, configuration: true });
      await call('team_trash', {
        teamName: second,
        expectedContext: info.context,
        expectedRevision: fresh.configurationRevision,
      });
      const trashed = await call('team_get', { teamName: second, configuration: true });
      assert.equal(typeof trashed.deletedAt, 'string');
      assertProviderless(trashed, ['developer']);
      await access(path.join(claude, 'teams', second, 'team.meta.json'));
      await waitFor(async () => {
        const facts = await listFacts();
        return !facts.cards.some((card) => card.name === second) &&
          /\btrash\s*\(1\)/i.test(facts.text)
          ? facts
          : false;
      }, 'reversible trash section');
      await screenshot('trash-before-restore');
      await click('Restore team', false, second);
      const restored = await waitFor(async () => {
        const team = await call('team_get', { teamName: second, configuration: true });
        return !team.deletedAt ? team : false;
      }, 'UI restores the original draft');
      const restoredSaved = assertProviderless(restored, ['developer']);
      const restoredMember = object((restoredSaved.members as unknown[])[0]);
      assert.equal(restoredMember.role, 'developer');
      assert.equal(restoredMember.workflow, 'Sandbox implementation.');
      await waitFor(
        async () => (await listFacts()).cards.some((card) => card.name === second),
        'restored canonical card'
      );
      for (const teamName of [first, second])
        for (const filename of [
          'config.json',
          'launch-state.json',
          'bootstrap-state.json',
          'bootstrap-journal.jsonl',
        ])
          await assert.rejects(access(path.join(claude, 'teams', teamName, filename)), {
            code: 'ENOENT',
          });
      return {
        client: 'codex-cli-app-server',
        nativeVersion,
        toolNames,
        edited,
        restored,
        noLaunchArtifacts: true,
      };
    }
  );
  await getClient().send('Page.reload');
  await attach();
  await openTeams();
  evidence.reloadUi = await waitFor(async () => {
    const facts = await listFacts();
    return facts.cards.length === 2 &&
      !facts.text.includes('Recent changes') &&
      facts.cards.every((card) => card.badges.length === 0)
      ? facts
      : false;
  }, 'reload retains teams and clears session-only change details');
  await evaluate(async () =>
    (window as unknown as { electronAPI: ElectronAPI }).electronAPI.config.update('general', {
      theme: 'light',
    })
  );
  await getClient().send('Page.reload');
  const light = await attach();
  await openTeams();
  await popup(light, 'light', false);
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = String(error);
  if (client) {
    try {
      await screenshot('failure');
      evidence.failureUi = await listFacts();
    } catch {
      /* preserve original error */
    }
  }
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    evidence.cleanupError = String(error);
    process.exitCode = 1;
  }
  await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify({ status: evidence.status, evidence: path.join(root, 'evidence.json') })
  );
}
