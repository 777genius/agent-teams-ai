// Hosted Linux Electron E2E: disposable project/profile, no team or agent launch.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, waitFor } from '../release-updater/cdp.mts';
import { cdpCallFunction } from '../release-updater/cdp-values.mts';
import { processIdentity, stopOwnedGroup } from '../release-updater/native-window.mts';

const repo = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const mode = process.argv[2];
assert(['red', 'green', 'persistent'].includes(mode));
assert.equal(process.platform, 'linux');
assert(process.env.DISPLAY, 'Run under isolated xvfb-run');
const root = await mkdtemp(path.join(tmpdir(), 'opencode-recovery-test-'));
const project = path.join(root, 'sandbox-project');
const home = path.join(root, 'home');
const userData = path.join(root, 'user-data');
const bin = path.join(root, 'bin');
const output = path.resolve(process.argv[3] ?? path.join(root, 'evidence'));
await mkdir(output); // A new directory prevents stale passed evidence on a failed rerun.
for (const directory of [project, home, userData, bin, path.join(root, 'tmp')])
  await mkdir(directory, { recursive: true });
const fixture = fileURLToPath(new URL('./fixture.mts', import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const role of ['orchestrator', 'opencode'])
  await writeFile(
    path.join(bin, role),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${role} "$@"\n`,
    { mode: 0o755 }
  );
await writeFile(path.join(project, 'README.md'), '# Disposable OpenCode status recovery E2E\n');
const claude = path.join(home, '.claude');
const encoded = project.replace(/[/\\]/g, '-');
const sessionDir = path.join(claude, 'projects', encoded);
await mkdir(sessionDir, { recursive: true });
await writeFile(
  path.join(sessionDir, 'test-session.jsonl'),
  JSON.stringify({
    type: 'user',
    cwd: project,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Synthetic sandbox session' },
    isMeta: false,
  }) + '\n'
);
await writeFile(
  path.join(claude, 'agent-teams-config.json'),
  JSON.stringify({
    general: { appLocale: 'en', theme: 'light', defaultTab: 'dashboard', multimodelEnabled: true },
    notifications: { enabled: false, soundEnabled: false },
  })
);
await writeFile(path.join(root, 'phase'), 'broken');
const manifest = path.join(userData, 'data/runtimes/opencode/current.json');
await mkdir(path.dirname(manifest), { recursive: true });
await writeFile(
  manifest,
  JSON.stringify({
    schemaVersion: 1,
    version: '1.18.29',
    platformPackage: 'test-fixture',
    binaryPath: path.join(bin, 'opencode'),
    integrity: 'disposable-fixture',
    installedAt: new Date().toISOString(),
  })
);

// dev:mcp selects a free port. Read it from this launch's own output.
let port: number | null = null;
const environment: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL'])
  environment[key] = process.env[key];
Object.assign(environment, {
  HOME: home,
  USERPROFILE: home,
  SHELL: '/bin/sh',
  TMPDIR: path.join(root, 'tmp'),
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
  CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: path.join(bin, 'orchestrator'),
  CLAUDE_CLI_PATH: path.join(bin, 'orchestrator'),
  CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: path.join(bin, 'opencode'),
  OPENCODE_BIN_PATH: path.join(bin, 'opencode'),
  OPENCODE_RECOVERY_FIXTURE_ROOT: root,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_STATE_HOME: path.join(home, '.local/state'),
  CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  AGENT_TEAMS_ORG_DEMO: '0',
  NODE_BINARY: process.execPath,
  pnpm_config_verify_deps_before_run: 'false',
});
let log = '';
let cdp: Cdp | undefined;
let owner: Awaited<ReturnType<typeof processIdentity>> = null;
let failure: unknown;
const evidence: Record<string, unknown> = {
  mode,
  root,
  project,
  output,
  started: new Date().toISOString(),
  boundary: 'Electron dev:mcp -> real preload IPC -> main -> read-only controlled CLI subprocess',
  fixtureHash: createHash('sha256')
    .update(await readFile(fixture))
    .digest('hex'),
  base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  productionSourceHashes: Object.fromEntries(
    await Promise.all(
      [
        'src/renderer/hooks/useOpenCodePassiveStatusPrefetch.ts',
        'src/renderer/components/team/dialogs/TeamModelSelector.tsx',
      ].map(async (file) => [
        file,
        createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex'),
      ])
    )
  ),
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = async () =>
  (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          scoped: boolean;
          phase: string;
          source?: string;
          failed?: boolean;
          model?: string | null;
          args: string[];
        }
    );
async function evaluate<T>(expression: string): Promise<T> {
  assert(cdp);
  const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function click(expression: string) {
  const point = await evaluate<{ x: number; y: number } | null>(`(() => {
    const node = ${expression}; if (!node || node.disabled) return null;
    node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert(point, `Control unavailable: ${expression}`);
  await clickPoint(point);
}
async function clickPoint(point: { x: number; y: number }) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp!.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
}
async function sourceModelState(source: string) {
  assert(cdp);
  return (
    (await cdpCallFunction<{
      selectable: boolean;
      selected: boolean;
      point: { x: number; y: number } | null;
    } | null>(
      cdp,
      `source => {
        const normalized = source.replace(/[^a-z]/g, '');
        const group = [...document.querySelectorAll('[data-testid="team-model-selector-opencode-group"]')]
          .find(g => g.querySelector('h4')?.textContent.toLowerCase().replace(/[^a-z]/g, '').includes(normalized));
        const model = [...(group?.querySelectorAll('[data-testid="team-model-selector-model-option"]') ?? [])]
          .find(b => b.textContent.includes('recovery-model'));
        if (!model) return null;
        model.scrollIntoView({block:'center'});
        const r = model.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return {
          selectable: model.getAttribute('aria-disabled') === 'false',
          selected: model.getAttribute('aria-pressed') === 'true',
          point: r.width && r.height && model.contains(document.elementFromPoint(x, y)) ? {x, y} : null,
        };
      }`,
      [source]
    )) ?? null
  );
}
async function snapshot(name: string) {
  const text = await evaluate<string>('document.body.innerText');
  await writeFile(path.join(output, `${name}.txt`), text);
  const shot = await cdp!.send<{ data: string }>('Page.captureScreenshot');
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
  return text;
}
async function assertEndpointOwnership() {
  assert(owner);
  const listeners = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert(listeners.length);
  for (const pid of listeners) {
    const current = await processIdentity(pid);
    assert(
      current && current.group === owner.group && BigInt(current.start) >= BigInt(owner.start),
      'CDP listener must belong to this exact detached launch'
    );
  }
}
try {
  const child = spawn('pnpm', ['dev:mcp', '--noSandbox'], {
    cwd: repo,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    log += String(chunk);
  });
  assert(child.pid);
  owner = await processIdentity(child.pid);
  assert(owner);
  evidence.owner = owner;
  await waitFor(
    async () => {
      assert(
        child.exitCode === null && child.signalCode === null,
        `Desktop exited: ${log.slice(-6000)}`
      );
      const match = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) port = Number(match[1]);
      return port !== null || null;
    },
    'own Electron CDP',
    180_000
  );
  await assertEndpointOwnership();
  evidence.port = port;
  const target = await waitFor(async () => {
    await assertEndpointOwnership();
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }[];
    return (
      targets.find(
        (item) => item.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(item.url)
      ) ?? null
    );
  }, 'actual Electron renderer');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(
    async () =>
      (await evaluate<boolean>(
        'Boolean(window.electronAPI && window.__agentTeamsDevStore?.getState().appConfig)'
      )) || null,
    'native preload'
  );
  await evaluate(`window.__agentTeamsDevStore.getState().openDashboard()`);
  await waitFor(
    async () => (await evaluate<boolean>(`document.body.innerText.includes('OpenRouter')`)) || null,
    'connected dashboard directory'
  );
  // Existing navigation actions only. Never replace APIs or fabricate store statuses.
  await evaluate(`(async () => {
    const store = window.__agentTeamsDevStore.getState(); await store.fetchProjects();
    const p = window.__agentTeamsDevStore.getState().projects.find(p => p.path === ${JSON.stringify(project)});
    if (!p) throw new Error('Sandbox project missing from actual IPC');
    store.selectProject(p.id); store.openTeamsTab(${JSON.stringify(project)});
  })()`);
  await waitFor(
    async () =>
      (await evaluate<boolean>(
        `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create Team')`
      )) || null,
    'Create Team action'
  );
  await click(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create Team')`
  );
  await waitFor(
    async () =>
      (await evaluate<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`)) || null,
    'Create Team dialog'
  );
  await waitFor(
    async () =>
      (await evaluate<boolean>(
        `[...document.querySelectorAll('[role="dialog"] button')].some(b => /Opus/.test(b.textContent))`
      )) || null,
    'loaded lead model selector'
  );
  await snapshot('dialog');
  await click(
    `[...document.querySelectorAll('[role="dialog"] button')].find(b => /Opus/.test(b.textContent))`
  );
  await waitFor(
    async () =>
      (await evaluate<boolean>(
        `[...document.querySelectorAll('button')].some(b => /^OpenCode(?:\\s|$)/.test(b.textContent.trim()))`
      )) || null,
    'OpenCode navigation'
  );
  await click(
    `[...document.querySelectorAll('button')].find(b => /^OpenCode(?:\\s|$)/.test(b.textContent.trim()))`
  );
  await waitFor(async () => {
    const text = await evaluate<string>('document.body.innerText');
    return text.includes('runtime temporarily unavailable') &&
      text.includes('OpenCode models could not be refreshed')
      ? true
      : null;
  }, 'both screenshot warnings');
  evidence.before = await snapshot('before');
  const beforeCalls = await calls();
  const statusCountBefore = beforeCalls.filter(
    (call) =>
      call.event === 'status-response' &&
      call.scoped &&
      call.args[call.args.indexOf('--provider') + 1] === 'opencode'
  ).length;
  evidence.statusCountBefore = statusCountBefore;
  assert.equal(statusCountBefore, 1, 'Exactly one failed scoped status check before recovery');
  assert(
    beforeCalls.some((call) => call.event === 'models-response' && call.failed),
    'Actual CLI catalog failure required'
  );
  await writeFile(path.join(root, 'phase'), mode === 'persistent' ? 'persistent' : 'healthy');
  // Change source without invalidating status scope, to exercise catalog-triggered recovery.
  await click(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('OpenRouter'))`
  );
  await waitFor(
    async () =>
      (await calls()).some(
        (call) =>
          call.event === 'models-response' &&
          call.source === 'openrouter' &&
          call.scoped &&
          !call.failed
      ) || null,
    'fresh scoped OpenRouter catalog'
  );
  if (mode === 'green') {
    await waitFor(async () => {
      const text = await evaluate<string>('document.body.innerText');
      return text.includes('recovery-model') && !text.includes('runtime temporarily unavailable')
        ? true
        : null;
    }, 'runtime recovery and visible OpenRouter models');
    evidence.recovered = await snapshot('recovered');
    for (const [label, source] of [
      ['OpenRouter', 'openrouter'],
      ['Opencode Zen', 'opencode-zen'],
      ['Agentrouter', 'agentrouter'],
    ]) {
      await click(
        `[...document.querySelectorAll('button')].find(b => b.getAttribute('role') === 'tab' && b.textContent.includes(${JSON.stringify(label)}))`
      );
      await waitFor(
        async () =>
          (await calls()).some(
            (call) =>
              call.event === 'models-response' &&
              call.source === source &&
              call.scoped &&
              call.phase === 'healthy'
          ) || null,
        `${source}: actual scoped catalog response`
      );
      await waitFor(
        async () => (await sourceModelState(source))?.selectable || null,
        `${source}: selectable model`
      );
      await snapshot(`selectable-${source}`);
      // The default card can show the same resolved model name. Select the
      // explicit card inside this source's group, then verify its qualified route.
      const model = await sourceModelState(source);
      assert(model?.selectable && model.point, `${source}: explicit model must be clickable`);
      await clickPoint(model.point);
      await waitFor(
        async () => (await sourceModelState(source))?.selected || null,
        `${source}: model selection committed`
      );
      await waitFor(
        async () =>
          (await calls()).some(
            (call) =>
              call.event === 'readiness-response' &&
              call.phase === 'healthy' &&
              call.model === `${source}/recovery-model`
          ) || null,
        `${source}: qualified route checked through preload IPC`
      );
      await snapshot(`selected-${source}`);
    }
    await waitFor(
      async () =>
        (await evaluate<boolean>(
          `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === 'Create' && !b.disabled)`
        )) || null,
      'Create Team readiness recovered'
    );
    evidence.ready = await snapshot('ready');
  } else {
    if (mode === 'persistent') {
      for (const [label, source] of [
        ['Opencode Zen', 'opencode-zen'],
        ['Agentrouter', 'agentrouter'],
      ]) {
        await click(
          `[...document.querySelectorAll('button')].find(b => b.getAttribute('role') === 'tab' && b.textContent.includes(${JSON.stringify(label)}))`
        );
        await waitFor(
          async () =>
            (await calls()).some(
              (call) =>
                call.event === 'models-response' &&
                call.source === source &&
                call.scoped &&
                !call.failed
            ) || null,
          `${source}: another fresh catalog during failure`
        );
      }
    }
    await pause(2500);
    const text = await snapshot('after');
    const blocked = await evaluate<boolean>(
      `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === 'Create' && b.disabled)`
    );
    assert(blocked, 'Unverified runtime must keep Create disabled');
    assert(
      text.includes('runtime temporarily unavailable'),
      'Unverified runtime must remain blocked'
    );
  }
  const finalCalls = await calls();
  const count = finalCalls.filter(
    (call) =>
      call.event === 'status-response' &&
      call.scoped &&
      call.args[call.args.indexOf('--provider') + 1] === 'opencode'
  ).length;
  assert.equal(count, mode === 'red' ? 1 : 2, 'At most one automatic exact-project recovery retry');
  evidence.statusCountAfter = count;
  evidence.calls = finalCalls;
} catch (error) {
  failure = error;
  evidence.error = String(error);
  if (cdp) await snapshot('failure').catch(() => {});
} finally {
  cdp?.close();
  try {
    if (owner) {
      const cleanup = await stopOwnedGroup(owner);
      evidence.cleanup = cleanup;
      assert.equal(
        cleanup.remaining.length,
        0,
        'Owned desktop processes must be stopped before success'
      );
    }
  } catch (error) {
    evidence.cleanupError = String(error);
    failure ??= error;
  }
  evidence.result = failure ? 'failed' : 'passed';
  await writeFile(path.join(output, 'desktop.log'), log);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}

if (failure) throw failure;
console.log(
  JSON.stringify({
    mode,
    output,
    statusCountBefore: evidence.statusCountBefore,
    statusCountAfter: evidence.statusCountAfter,
    result: evidence.result,
  })
);
