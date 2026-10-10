#!/usr/bin/env -S pnpm exec tsx
// Synthetic desktop smoke. No providers are launched and no real project is opened.
// Run: pnpm exec tsx scripts/e2e/group-chats-desktop.ts
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Existing raw CDP client; all interaction stays in the owned dev:mcp renderer.
// @ts-expect-error Existing JavaScript harness has no declaration file.
import { CdpClient } from './comment-notification/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keep = process.env.GROUP_CHATS_E2E_KEEP === '1';
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

// Await the evaluated expression itself: Boolean(Promise) would pass asynchronous
// production IPC checks before their result exists.
async function waitFor(expression: string, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    } catch (error) {
      if (!/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(String(error))) throw error;
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'group-chats-desktop-')));
  const teamName = 'group-smoke-' + randomUUID();
  const projectPath = path.join(root, 'sandbox-project');
  const claudeRoot = path.join(root, '.claude');
  const teamDir = path.join(claudeRoot, 'teams', teamName);
  const shots = process.env.GROUP_CHATS_E2E_OUTPUT_DIR ?? path.join(root, 'screenshots');
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
  const point = await cdp.evaluate(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`
  );
  assert(point && typeof point === 'object', 'Missing click target: ' + expression);
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
const button = (text: string, root = 'document') =>
  `Array.from(${root}.querySelectorAll('button')).find(e => e.textContent?.trim() === ${JSON.stringify(text)})`;
const row = (id: string) => `document.querySelector('[data-group-chat-id="${id}"]')`;
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

async function main() {
  const f = await fixture();
  let succeeded = false;
  try {
    console.log("Starting owned synthetic desktop", f.root);
    const port = await start(f);
    console.log("Owned CDP connected", port);
    cdp.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'desktop API',
      60_000
    );
    await waitFor(
      '(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()',
      'desktop startup',
      60_000
    );
    await waitFor(
      `window.__agentTeamsDevStore.getState().teams.some(t => t.teamName === ${JSON.stringify(f.teamName)})`,
      'fixture team',
      60_000
    );
    await cdp.evaluate(
      `(async () => { const s = window.__agentTeamsDevStore.getState(); s.openTeamTab(${JSON.stringify(f.teamName)}, ${JSON.stringify(f.projectPath)}); await s.selectTeam(${JSON.stringify(f.teamName)}, { skipProjectAutoSelect: true }); s.setMessagesPanelMode('sidebar'); })()`
    );
    await waitFor(
      `document.querySelector('[data-testid="group-chat-list"]')`,
      'custom chat list'
    );
    await click(button('Create group chat'));
    const dialog = `document.querySelector('[data-testid="create-group-chat-dialog"]')`;
    await waitFor(dialog, 'create dialog');
    assert.deepEqual(
      await cdp.evaluate(
        `Array.from(${dialog}.querySelectorAll('[role="checkbox"]')).map(e => e.getAttribute('data-state'))`
      ),
      ['checked', 'checked', 'checked', 'checked']
    );
    // Row click must toggle once, without opening a profile. Space works on the checkbox.
    const alice = `${dialog}.querySelector('[role="checkbox"][aria-label="alice"]')`;
    await click(`${alice}.closest('label').querySelector('span')`);
    assert.equal(await cdp.evaluate(`${alice}.getAttribute('data-state')`), 'unchecked');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`), 1);
    await click(alice); // two agents -> three again
    await key(' ', 'Space'); // three -> two
    assert.equal(await cdp.evaluate(`${alice}.getAttribute('data-state')`), 'unchecked');
    await fill('[data-testid="create-group-chat-dialog"] input', 'Architecture smoke');
    await click(`${dialog}.querySelector('[role="checkbox"][aria-label="bob"]')`);
    assert.equal(
      await cdp.evaluate(`${button('Create group chat', dialog)}.disabled`),
      true,
      'one selected agent must not create'
    );
    await click(`${dialog}.querySelector('[role="checkbox"][aria-label="bob"]')`);
    await click(button('Create group chat', dialog));
    await waitFor(
      `!${dialog} && document.querySelector('[data-testid="group-chat-composer"]')`,
      'created group'
    );
    const groups = await cdp.evaluate(
      `window.electronAPI.teamGroupChats.list({ teamName: ${JSON.stringify(f.teamName)} })`
    );
    assert(Array.isArray(groups));
    assert.equal(groups.length, 1);
    const id: string = groups[0].id;
    assert.equal(groups[0].name, 'Architecture smoke');
    assert.deepEqual(groups[0].memberNames.slice().sort(), ['bob', 'lead']);
    assert.equal(groups[0].membership.kind, 'auto');
    await waitFor(`!document.querySelector('[data-testid="group-chat-composer"] textarea')?.disabled`, 'offline draft loaded');
    await fill('[data-testid="group-chat-composer"] textarea', 'OFFLINE_DRAFT_PRESERVED');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="group-chat-composer"] textarea').readOnly`), false);
    assert.equal(await cdp.evaluate(`${button('Send', `document.querySelector('[data-testid="group-chat-composer"]')`)}.disabled`), true);
    // History is fixture input, not a simulated send: providers are intentionally offline.
    const messageId = randomUUID();
    const canonical = {
      from: 'lead',
      to: 'user',
      text: 'GROUP_HISTORY_ONLY',
      timestamp: new Date().toISOString(),
      read: false,
      source: 'runtime_delivery',
      groupChatName: 'Architecture smoke',
      messageId,
      groupMessageId: messageId,
      groupChatId: id,
      groupChatProtocolVersion: 1,
      groupRecipientNames: ['bob', 'lead'],
      groupRecipientRunKeys: { bob: 'offline-bob', lead: 'offline-lead' },
    };
    const savedId = randomUUID();
    const saved = { ...canonical, from: 'user', source: 'user_sent', text: 'SAVED_USER_GROUP_POST',
      messageId: savedId, groupMessageId: savedId,
      groupDeliverySummary: { recordedAt: new Date().toISOString(), recipients: [
        { memberName: 'bob', physicalMessageId: 'synthetic-bob-physical', status: 'queued' },
        { memberName: 'lead', physicalMessageId: 'synthetic-lead-physical', status: 'unknown' },
      ] } };
    await json(path.join(f.teamDir, 'inboxes', 'user.json'), [f.direct, canonical, saved]);
    await waitFor(
      `document.body.innerText.includes('GROUP_HISTORY_ONLY')`,
      'canonical group history',
      30_000
    );
    assert.equal(
      await cdp.evaluate(
        `document.querySelector('[data-messages-thread-container="true"]')?.textContent?.includes('PRIVATE_DM_ONLY') ?? false`
      ),
      false,
      'DM must not enter group history'
    );
    await cdp.evaluate('window.__groupSmokeReloadToken = true');
    await cdp.send('Page.reload');
    await waitFor('!window.__groupSmokeReloadToken && window.electronAPI?.teams && window.__agentTeamsDevStore', 'reloaded desktop API');
    await waitFor('(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()', 'reloaded startup');
    await cdp.evaluate(`(async () => { const s = window.__agentTeamsDevStore.getState(); s.openTeamTab(${JSON.stringify(f.teamName)}, ${JSON.stringify(f.projectPath)}); await s.selectTeam(${JSON.stringify(f.teamName)}, { skipProjectAutoSelect: true }); s.setMessagesPanelMode('sidebar'); })()`);
    await waitFor(row(id), 'saved group after reload');
    await click(row(id));
    await waitFor(`document.body.innerText.includes('GROUP_HISTORY_ONLY') && document.body.innerText.includes('bob: queued, lead: unknown')`, 'persisted delivery snapshot after reload');
    await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.value === 'OFFLINE_DRAFT_PRESERVED'`, 'offline draft after reload');
    await click(button('Archive chat'));
    await waitFor(button('Restore chat'), 'archive readonly header');
    assert.equal(
      await cdp.evaluate(
        `document.querySelector('[data-testid="group-chat-composer"] textarea')?.readOnly`
      ),
      true
    );
    assert.equal(
      await cdp.evaluate(`document.body.innerText.includes('GROUP_HISTORY_ONLY')`),
      true,
      'archived history remains readable'
    );
    // Auto membership also expands while archived, without any runtime action.
    const carol = { ...f.members[1], name: 'carol', agentId: 'carol@' + f.teamName };
    // Offline member management updates metadata before the next runtime launch.
    await json(path.join(f.teamDir, 'members.meta.json'), {
      version: 1,
      members: [...f.members, carol],
    });
    await waitFor(
      `(async () => { const g = (await window.electronAPI.teamGroupChats.list({ teamName: ${JSON.stringify(f.teamName)} }))[0]; return !!g.archivedAt && g.memberNames.includes('carol'); })()`,
      'archived auto membership'
    );
    await back();
    await waitFor(`${row(id)}?.dataset.archived === 'true'`, 'archived list row');
    assert.equal(
      await cdp.evaluate(`${row(id)}.disabled`),
      false,
      'archived row must remain navigable'
    );
    await click(row(id));
    await waitFor(button('Restore chat'), 'open archived group');
    await click(button('Restore chat'));
    await waitFor(button('Archive chat'), 'restored group');
    await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.value === 'OFFLINE_DRAFT_PRESERVED'`, 'restored saved draft');
    await cdp.screenshot(path.join(f.shots, 'group-sidebar.png'));
    // All modes keep explicit group scope; floating mode only renders the composer.
    const fullScreen = `document.querySelector('[role="switch"][aria-label="Full Screen"]')`;
    await click(fullScreen);
    await waitFor(
      `${fullScreen}?.getAttribute('aria-checked') === 'true'`,
      'full-screen group'
    );
    assert.equal(
      await cdp.evaluate(`document.body.innerText.includes('GROUP_HISTORY_ONLY')`),
      true
    );
    await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.value === 'OFFLINE_DRAFT_PRESERVED'`, 'fullscreen saved draft');
    await cdp.screenshot(path.join(f.shots, 'group-fullscreen.png'));
    await click(fullScreen);
    for (const mode of ['inline', 'bottom-sheet', 'floating-composer']) {
      await cdp.evaluate(
        `window.__agentTeamsDevStore.getState().setMessagesPanelMode(${JSON.stringify(mode)})`
      );
      if (mode === 'bottom-sheet') {
        await waitFor(
          `document.querySelector('button[aria-label="Message bottom sheet actions"]')`,
          'sheet header'
        );
        await click(`document.querySelector('button[aria-label="Message bottom sheet actions"]')`);
        const expand = `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent?.includes('Expand sheet'))`;
        if (await cdp.evaluate(`Boolean(${expand})`)) await click(expand);
        else await key('Escape');
      }
      await waitFor(
        `document.querySelector('[data-testid="group-chat-composer"]')`,
        mode + ' group composer'
      );
      if (mode !== 'floating-composer')
        await waitFor(`document.body.innerText.includes('GROUP_HISTORY_ONLY')`, mode + ' group history');
      assert.equal(
        await cdp.evaluate(
          `document.querySelector('[data-testid="group-chat-composer"]')?.textContent?.includes('Architecture smoke')`
        ),
        true,
        mode + ' group identity'
      );
      await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.value === 'OFFLINE_DRAFT_PRESERVED'`, mode + ' saved draft');
      await cdp.screenshot(path.join(f.shots, 'group-' + mode + '.png'));
    }
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().setMessagesPanelMode('sidebar')`);
    await back();
    await click(
      `Array.from(document.querySelectorAll('button[aria-label]')).find(e => e.getAttribute('aria-label')?.startsWith('alice,'))`
    );
    await waitFor(`document.body.innerText.includes('PRIVATE_DM_ONLY')`, 'private history');
    assert.equal(
      await cdp.evaluate(
        `document.querySelector('[data-messages-thread-container="true"]')?.textContent?.includes('GROUP_HISTORY_ONLY') ?? false`
      ),
      false,
      'group must not enter DM history'
    );
    await back();
    await click(button('Create group chat'));
    await waitFor(dialog, 'fixed group dialog');
    await fill('[data-testid="create-group-chat-dialog"] input', 'Fixed smoke');
    await click(`${dialog}.querySelector('[role="checkbox"][id^="group-auto-"]')`);
    await click(button('Create group chat', dialog));
    await waitFor(`!${dialog} && document.querySelector('[data-testid="group-chat-composer"]')?.textContent?.includes('Fixed smoke')`, 'fixed group created');
    const fixed = await cdp.evaluate(`(async () => (await window.electronAPI.teamGroupChats.list({ teamName: ${JSON.stringify(f.teamName)} })).find(g => g.name === 'Fixed smoke'))()`);
    assert(fixed && typeof fixed === 'object' && 'id' in fixed && 'membership' in fixed);
    assert.equal((fixed as { membership: { kind: string } }).membership.kind, 'fixed');
    const dave = { ...f.members[1], name: 'dave', agentId: 'dave@' + f.teamName };
    await json(path.join(f.teamDir, 'members.meta.json'), { version: 1, members: [...f.members, carol, dave] });
    await waitFor(`(async () => { const g = await window.electronAPI.teamGroupChats.list({ teamName: ${JSON.stringify(f.teamName)} }); return g.find(g => g.id === ${JSON.stringify(id)})?.memberNames.includes('dave') && !g.find(g => g.id === ${JSON.stringify(fixed.id)})?.memberNames.includes('dave'); })()`, 'fixed versus auto membership');
    await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.disabled === false`, 'separate fixed draft');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="group-chat-composer"] textarea').value`), '', 'different groups isolate drafts');
    await back();
    await click(row(id));
    await waitFor(`document.querySelector('[data-testid="group-chat-composer"] textarea')?.value === 'OFFLINE_DRAFT_PRESERVED'`, 'original draft after fixed group');
    // Runtime wrapper proves this synthetic UI smoke never launched a provider/team.
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
      'unexpected runtime lifecycle invocation'
    );
    succeeded = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          port,
          teamName: f.teamName,
          screenshots: f.shots,
          fixtureRoot: f.root,
          coverage: [
            'picker/defaults/minimum/row/keyboard',
            'create/real-IPC',
            'archive/read/restore',
            'archived-auto-membership',
            'sidebar/fullscreen/inline/bottom-sheet/floating',
            'offline-draft/reload/all-modes/group-isolation',
            'fixed/auto-membership',
            'DM-isolation',
          ],
          limitation:
            'Synthetic offline UI fixture; live provider group delivery requires runtime integration smoke.',
        },
        null,
        2
      )
    );
  } catch (error) {
    await cdp?.screenshot(path.join(f.shots, 'failure.png')).catch(() => undefined);
    await writeFile(path.join(f.shots, 'failure-context.json'), JSON.stringify({ rendererErrors,
      body: await cdp?.evaluate('document.body.innerText').catch(() => null), logs }, null, 2));
    console.error('Fixture retained at ' + f.root + '\n' + logs.slice(-30).join(''));
    throw error;
  } finally {
    await cdp?.close().catch(() => undefined);
    if (!keep && app?.pid) {
      try {
        process.kill(process.platform === 'win32' ? app.pid : -app.pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
    // Retain evidence by default. Explicit cleanup only removes this owned fixture.
    if (succeeded && !keep && process.env.GROUP_CHATS_E2E_REMOVE_FIXTURE === '1')
      await rm(f.root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
