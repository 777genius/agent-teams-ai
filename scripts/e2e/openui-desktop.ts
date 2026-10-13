#!/usr/bin/env -S pnpm exec tsx
// Synthetic desktop smoke. No providers are launched and no real project is opened.
// Run: xvfb-run -a pnpm exec tsx scripts/e2e/openui-desktop.ts
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Existing raw CDP client; all interaction stays in the owned dev:mcp renderer.
// @ts-expect-error Existing JavaScript harness has no declaration file.
import { CdpClient } from './comment-notification/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keep = process.env.OPENUI_E2E_KEEP === '1';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logs: string[] = [];
const rendererErrors: unknown[] = [];
let app: ChildProcess | undefined;
interface SmokeCdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}
let cdp: SmokeCdp;

async function screenshot(file: string) {
  await delay(250); // Let the Radix opening animation settle before visual evidence.
  await cdp.screenshot(file);
}

// Await the evaluated expression itself: Boolean(Promise) would pass asynchronous
// production IPC checks before their result exists.
async function waitFor(expression: string, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    } catch (error) {
      if (
        !/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
          String(error)
        )
      )
        throw error;
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'openui-desktop-')));
  const teamName = 'openui-smoke-' + randomUUID();
  const projectPath = path.join(root, 'sandbox-project');
  const claudeRoot = path.join(root, '.claude');
  const teamDir = path.join(claudeRoot, 'teams', teamName);
  const shots = process.env.OPENUI_E2E_OUTPUT_DIR ?? path.join(root, 'screenshots');
  const runtime = path.join(root, 'deny-runtime.cjs');
  const audit = path.join(root, 'runtime-audit.ndjson');
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  const env: Record<string, string> = {
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
    HOME: path.join(root, 'home'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
  };
  await Promise.all(
    [
      projectPath,
      shots,
      ...Object.values(env),
      path.join(teamDir, 'inboxes'),
      path.join(claudeRoot, 'projects'),
      path.join(claudeRoot, 'tasks', teamName),
    ].map((dir) => mkdir(dir, { recursive: true }))
  );
  await writeFile(audit, '');
  await writeFile(
    runtime,
    `#!${await realpath(process.execPath)}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + '\\n');\nif (args.length === 1 && args[0] === '--version') { console.log(${JSON.stringify(runtimeLock.version)}); process.exit(0); }\nprocess.stderr.write('Synthetic smoke denies runtime/provider execution\\n'); process.exit(77);\n`
  );
  await chmod(runtime, 0o755);
  const members = ['lead', 'alice', 'bob'].map((name, index) => ({
    name,
    agentId: name + '@' + teamName,
    agentType: index === 0 ? 'team-lead' : 'developer',
    role: index === 0 ? 'Lead' : 'Developer',
    providerId: 'opencode',
    providerBackendId: 'opencode-cli',
    model: 'test-model',
    color: ['blue', 'green', 'yellow'][index],
    cwd: projectPath,
    joinedAt: Date.now() - 600_000,
    subscriptions: [],
  }));
  await json(path.join(claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: teamName,
    description: 'Disposable custom group smoke',
    language: 'en',
    color: 'blue',
    createdAt: Date.now() - 600_000,
    leadAgentId: members[0].agentId,
    members,
    projectPath,
    projectPathHistory: [projectPath],
  });
  await json(path.join(teamDir, 'members.meta.json'), { version: 1, members });
  await json(path.join(teamDir, 'team.meta.json'), {
    version: 1,
    cwd: projectPath,
    providerId: 'opencode',
    model: 'test-model',
    prompt: 'Synthetic renderer fixture only. Never launch providers.',
    createdAt: Date.now() - 600_000,
  });
  await writeFile(path.join(projectPath, 'README.md'), '# Disposable custom group smoke\n');
  const direct = {
    from: 'alice',
    to: 'user',
    text: 'PRIVATE_DM_ONLY',
    timestamp: new Date().toISOString(),
    read: false,
    messageId: randomUUID(),
    source: 'inbox',
  };
  await json(path.join(teamDir, 'inboxes', 'user.json'), [direct]);
  return { root, shots, teamDir, teamName, projectPath, members, direct, env, runtime, audit };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  app = spawn('pnpm', ['dev:mcp', ...(process.getuid?.() === 0 ? ['--noSandbox'] : [])], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...f.env,
      NODE_BINARY: await realpath(process.execPath),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: f.runtime,
      CLAUDE_TERMINAL_DAEMON_BINARY: f.runtime,
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      SHELL: '/bin/sh',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      pnpm_config_verify_deps_before_run: 'false',
    },
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      if (logs.length > 300) logs.shift();
    });
  // Discover this process's actual port rather than attaching to another app on 9222.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error('Owned dev:mcp exited: ' + app.exitCode);
    const port = logs
      .join('')
      .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//)?.[1];
    if (port) {
      try {
        const targets = (await fetch('http://127.0.0.1:' + port + '/json/list').then((r) =>
          r.json()
        )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        const renderer = targets.find(
          (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
        );
        if (renderer) {
          cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
          return Number(port);
        }
      } catch {
        /* Electron renderer is still starting. */
      }
    }
    await delay(100);
  }
  throw new Error('Owned dev:mcp renderer did not appear');
}

async function click(expression: string) {
  await cdp.evaluate(
    `(() => { const e = ${expression}; if (e instanceof HTMLElement) e.scrollIntoView({ block: 'nearest', behavior: 'instant' }); })()`
  );
  await waitFor(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return false; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.width > 0 && r.height > 0 && (hit === e || e.contains(hit)); })()`,
    'unobstructed click target: ' + expression
  );
  const point = await cdp.evaluate(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return null; const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`
  );
  assert(point && typeof point === 'object', 'Missing click target: ' + expression);
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
const button = (text: string, root = 'document') =>
  `Array.from(${root}.querySelectorAll('button')).find(e => e.textContent?.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)})`;
const back = () => click(`document.querySelector('button[aria-label="Back to chats"]')`);
async function fill(selector: string, value: string) {
  await click(`document.querySelector(${JSON.stringify(selector)})`);
  await cdp.send('Input.insertText', { text: value });
}
async function key(key: string, code = key) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      ...(key === ' ' ? { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 } : {}),
    });
}

const program =
  'root = Stack([Card([CardHeader("Smoke report"), Table([Col("Name", ["Alpha", "Beta"], "string"), Col("Value", [10, 20], "number")]), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);';
const richText =
  'VISIBLE_REPORT\n\n```openui-lang\n' +
  program +
  '\n```\n\n```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```';
const shell = (kind: string) =>
  `document.querySelector('[data-chat-visualization-kind="${kind}"]')`;

async function main() {
  const f = await fixture();
  try {
    const port = await start(f);
    cdp.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'desktop API',
      60_000
    );
    await waitFor(
      '(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()',
      'startup',
      60_000
    );
    await waitFor(
      `window.__agentTeamsDevStore.getState().teams.some(t => t.teamName === ${JSON.stringify(f.teamName)})`,
      'sandbox team',
      60_000
    );
    // Vite may reload once after optimizing new vendor packages. Reapply the
    // existing sandbox navigation only until its actual chat list is visible.
    await waitFor(
      `(async () => {
        if (${button('Create group chat')}) return true;
        if (!window.electronAPI?.teams || !window.__agentTeamsDevStore) return false;
        if (!(await window.electronAPI.startup.getStatus()).ready) return false;
        const s = window.__agentTeamsDevStore.getState();
        if (!s.teams.some(t => t.teamName === ${JSON.stringify(f.teamName)})) return false;
        if (Date.now() - (window.__openuiSmokeNavigationAt || 0) < 2000) return false;
        window.__openuiSmokeNavigationAt = Date.now();
        s.openTeamTab(${JSON.stringify(f.teamName)}, ${JSON.stringify(f.projectPath)});
        await s.selectTeam(${JSON.stringify(f.teamName)}, { skipProjectAutoSelect: true });
        s.setMessagesPanelMode('sidebar');
        return Boolean(${button('Create group chat')});
      })()`,
      'chat list after dependency reload',
      60_000
    );
    await click(button('Create group chat'));
    const dialog = `document.querySelector('[data-testid="create-group-chat-dialog"]')`;
    await waitFor(dialog, 'group picker');
    await fill('[data-testid="create-group-chat-dialog"] input', 'Visualization smoke');
    await click(button('Create group chat', dialog));
    await waitFor(
      `!${dialog} && document.querySelector('[data-testid="group-chat-composer"]')`,
      'sandbox group'
    );
    const groups = (await cdp.evaluate(
      `window.electronAPI.teamGroupChats.list({ teamName: ${JSON.stringify(f.teamName)} })`
    )) as { id: string }[];
    assert.equal(groups.length, 1);
    const id = groups[0].id;
    const message = {
      ...f.direct,
      text: richText,
      source: 'runtime_delivery',
      groupChatName: 'Visualization smoke',
      groupChatId: id,
      groupMessageId: f.direct.messageId,
      groupChatProtocolVersion: 1,
      groupRecipientNames: ['alice', 'bob', 'lead'],
      groupRecipientRunKeys: { alice: 'offline-alice', bob: 'offline-bob', lead: 'offline-lead' },
    };
    let history: Record<string, unknown>[] = [message];
    const writeHistory = () => json(path.join(f.teamDir, 'inboxes', 'user.json'), history);
    await writeHistory();
    await waitFor(shell('openui'), 'group OpenUI');

    async function verifySurface(name: string) {
      await waitFor(shell('openui'), name + ' OpenUI shell');
      await waitFor(shell('mermaid'), name + ' Mermaid shell');
      await delay(250); // ExpandableContent measures its clipping in animation frames.
      const expand = button('Show more');
      if (await cdp.evaluate(`Boolean(${expand})`)) {
        await click(expand);
        await waitFor(`!${expand}`, name + ' expanded message');
      }
      for (const kind of ['openui', 'mermaid']) {
        if (await cdp.evaluate(`Boolean(${expand})`)) {
          await click(expand);
          await waitFor(`!${expand}`, name + ' expanded ' + kind + ' message');
        }
        await waitFor(
          `${shell(kind)}?.getAttribute('data-chat-visualization-presentation') === 'card'`,
          name + ' narrow ' + kind
        );
        const opener = button('Open visualization', shell(kind));
        await click(opener);
        await waitFor(`document.querySelector('[role="dialog"]')`, name + ' ' + kind + ' dialog');
        await waitFor(
          kind === 'openui'
            ? `document.querySelector('[role="dialog"] [data-openui-chart="bar"]')`
            : `document.querySelector('[role="dialog"] svg')`,
          kind + ' actual content'
        );
        await screenshot(path.join(f.shots, name + '-' + kind + '-dialog.png'));
        await key('Escape');
        await waitFor(`!document.querySelector('[role="dialog"]')`, 'dialog closes');
        await waitFor(
          `document.activeElement === ${opener}`,
          'Escape restores opener focus',
          2_000
        );
      }
      await click(`document.querySelector('[role="switch"][aria-label="Full Screen"]')`);
      await waitFor(
        `${shell('openui')}?.getAttribute('data-chat-visualization-presentation') === 'inline'`,
        name + ' wide'
      );
      await waitFor(
        `document.querySelector('[data-openui-chart="bar"]') && ${shell('mermaid')}?.querySelector('svg')`,
        name + ' both actual renderers'
      );
      assert.equal(
        await cdp.evaluate(
          `${shell('openui')}.textContent.includes('Smoke report') && ${shell('openui')}.textContent.includes('Alpha')`
        ),
        true
      );
      for (const theme of ['dark', 'light']) {
        await cdp.evaluate(
          `window.__agentTeamsDevStore.getState().updateConfig('general', { theme: ${JSON.stringify(theme)} })`
        );
        await delay(250);
        await screenshot(path.join(f.shots, name + '-wide-' + theme + '.png'));
      }
      await click(`document.querySelector('[role="switch"][aria-label="Full Screen"]')`);
      await waitFor(
        `${shell('openui')}?.getAttribute('data-chat-visualization-presentation') === 'card'`,
        name + ' resized card'
      );
    }
    await verifySurface('group');
    await back();
    history = [{ ...f.direct, from: 'lead', messageId: randomUUID(), text: richText }];
    await writeHistory();
    await click(
      `Array.from(document.querySelectorAll('button[aria-label]')).find(e => e.getAttribute('aria-label')?.startsWith('Group chat,'))`
    );
    await verifySurface('main');
    await back();
    history = [{ ...f.direct, text: richText }];
    await writeHistory();
    await click(
      `Array.from(document.querySelectorAll('button[aria-label]')).find(e => e.getAttribute('aria-label')?.startsWith('alice,'))`
    );
    await verifySurface('dm');

    // Existing inbox watcher replaces the same message ID, rather than a new transport.
    history[0].text =
      'PROGRESSIVE_REPORT\n\n```openui-lang\nroot = Stack([Card([CardHeader("Growing")]), Card([TextContent("';
    await writeHistory();
    await waitFor(
      `${shell('openui')}?.getAttribute('data-chat-visualization-status') === 'incomplete'`,
      'partial message'
    );
    await cdp.evaluate(`void (window.__openuiSmokeShell = ${shell('openui')})`);
    await click(button('Open visualization', shell('openui')));
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent.includes('Growing')`,
      'partial first Card rendered'
    );
    await cdp.evaluate(
      `(() => { window.__openuiSmokeDialog = document.querySelector('[role="dialog"]'); window.__openuiSmokeHeading = Array.from(window.__openuiSmokeDialog.querySelectorAll('*')).find(e => e.textContent === 'Growing'); window.__openuiSmokeFocus = document.activeElement; })()`
    );
    history[0].text += 'Second card")])]);';
    await writeHistory();
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent.includes('Second card')`,
      'next accumulated chunk'
    );
    assert.equal(
      await cdp.evaluate(
        `window.__openuiSmokeDialog === document.querySelector('[role="dialog"]') && window.__openuiSmokeHeading.isConnected && window.__openuiSmokeFocus === document.activeElement`
      ),
      true,
      'progress preserves dialog, first Card and focus'
    );
    history[0].text =
      'PROGRESSIVE_REPORT\n\n```openui-lang\nroot = Stack([Card([CardHeader("Growing")]), Card([TextContent("Second card"), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);\n```';
    await writeHistory();
    await waitFor(
      `${shell('openui')}?.getAttribute('data-chat-visualization-status') === 'content'`,
      'final progressive content'
    );
    await waitFor(
      `document.querySelector('[role="dialog"] [data-openui-chart="bar"]')`,
      'progressive final chart'
    );
    assert.equal(
      await cdp.evaluate(`window.__openuiSmokeShell === ${shell('openui')}`),
      true,
      'message update preserves shell DOM identity'
    );
    assert.equal(
      await cdp.evaluate(
        `window.__openuiSmokeDialog === document.querySelector('[role="dialog"]') && window.__openuiSmokeHeading.isConnected`
      ),
      true,
      'final chunk preserves rendered first Card'
    );
    await key('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'progressive dialog closes');
    for (const [source, status] of [
      ['root = Nope();', 'unavailable'],
      [' '.repeat(32_001), 'limit'],
    ] as const) {
      history[0].text = '```openui-lang\n' + source + '\n```';
      await writeHistory();
      await waitFor(
        `${shell('openui')}?.getAttribute('data-chat-visualization-status') === ${JSON.stringify(status)}`,
        status + ' handled locally'
      );
      assert.equal(
        await cdp.evaluate(`document.querySelectorAll('[data-openui-chart]').length`),
        0
      );
    }
    history[0].text = richText;
    await writeHistory();
    await waitFor(
      `${shell('openui')}?.getAttribute('data-chat-visualization-status') === 'content'`,
      'recovery'
    );
    if (process.env.OPENUI_E2E_GENERATED_MESSAGE_FILE) {
      let generatedText: string | null = null;
      const deadline = Date.now() + 120_000;
      while (generatedText === null && Date.now() < deadline) {
        try {
          generatedText = await readFile(process.env.OPENUI_E2E_GENERATED_MESSAGE_FILE, 'utf8');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          await delay(250);
        }
      }
      assert(generatedText !== null, 'Sandbox agent output did not arrive');
      const generatedTitle = generatedText.match(/CardHeader\("([^"\n]+)"/)?.[1];
      assert(
        generatedTitle && generatedTitle !== 'Smoke report',
        'Agent fixture must have a distinct report title'
      );
      history[0].text = generatedText;
      await writeHistory();
      await waitFor(
        `${shell('openui')}?.getAttribute('data-chat-visualization-status') === 'content' && document.body.innerText.includes(${JSON.stringify(generatedTitle)})`,
        'actual sandbox-agent message'
      );
      await click(button('Open visualization', shell('openui')));
      await waitFor(
        `document.querySelector('[role="dialog"] [data-openui-chart]') && document.querySelector('[role="dialog"] table') && document.querySelector('[role="dialog"]').textContent.includes(${JSON.stringify(generatedTitle)})`,
        'actual generated chart and table'
      );
      await screenshot(path.join(f.shots, 'agent-generated-dialog.png'));
      await key('Escape');
    }
    assert.deepEqual(rendererErrors, [], 'uncaught renderer exceptions');
    const audit = (await readFile(f.audit, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert(
      audit.every(
        (args) =>
          args[0] === '--version' ||
          (args[0] === 'runtime' && ['status', 'providers', 'opencode-command'].includes(args[1]))
      ),
      'no provider lifecycle'
    );
    await json(path.join(f.shots, 'result.json'), {
      ok: true,
      port,
      fixtureRoot: f.root,
      screenshots: f.shots,
      coverage: [
        'main/group/DM',
        'OpenUI/Mermaid',
        'wide/narrow/dialog/focus',
        'light/dark',
        'same-message progressive watcher',
        'malformed/limit/recovery',
      ],
      rendererErrors,
      limitation:
        'Offline synthetic fixture; actual sandbox-agent generation is verified separately.',
    });
    console.log(JSON.stringify({ ok: true, fixtureRoot: f.root, screenshots: f.shots }));
  } catch (error) {
    await cdp?.screenshot(path.join(f.shots, 'failure.png')).catch(() => undefined);
    await json(path.join(f.shots, 'failure-context.json'), {
      error: String(error),
      rendererErrors,
      body: await cdp?.evaluate('document.body.innerText').catch(() => null),
      logs,
    });
    throw error;
  } finally {
    await cdp?.close().catch(() => undefined);
    if (!keep && app?.pid) {
      try {
        process.kill(process.platform === 'win32' ? app.pid : -app.pid, 'SIGTERM');
      } catch {
        /* Owned app already exited. */
      }
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
