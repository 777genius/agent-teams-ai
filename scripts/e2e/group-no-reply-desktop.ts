/** Owned desktop regression: real IPC/bridge/OpenCode; only model HTTP is synthetic.
 * GROUP_NO_REPLY_RUNTIME=/absolute/cli-source pnpm exec tsx scripts/e2e/group-no-reply-desktop.ts
 * Checks: user greeting recovers from NO_REPLY, one canonical reply, no private echo,
 * exact physical relay/read commit, bounded attempts, no card error. Peer silence
 * and ambiguous/crashed handoffs are covered by the focused delivery contract tests.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment';
import { startGroupChatModelServer, type Json } from './group-chat-model-server';
// @ts-expect-error Shared owned-renderer CDP transport is JavaScript.
import { CdpClient } from './comment-notification/cdp.mjs';
import type { TeamCreateRequest, TeamAgentRuntimeSnapshot } from '../../src/shared/types/team';
import type { TeamGroupChatDTO } from '../../src/features/team-group-chats/contracts/api';

interface Client {
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params?: Json): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = await prepareNativeDesktopEnvironment();
const { root, projectPath, teamName, env } = fixture;
console.log(JSON.stringify({ root, teamName }));
const json = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n');
// CDP evaluates JavaScript source. Keep data literals safe even if that source is
// later embedded in HTML by another transport.
const literal = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
  );
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait<T>(
  label: string,
  read: () => Promise<T | false | null>,
  timeout = 180_000
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (!/execution context was destroyed|cannot find.*execution context/i.test(String(error)))
        throw error;
    }
    await delay(300);
  }
  throw new Error('Timed out: ' + label);
}
let app: ChildProcess | undefined;
let client: Client | undefined;
let created = false;
let markerCount = 0;
let repairCount = 0;
const model = await startGroupChatModelServer(path.join(root, 'model.ndjson'), (body) => {
  const messages = (body.messages ?? []) as Json[];
  const users = messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Json[])
              .filter((part) => part.type === 'text')
              .map((part) => String(part.text ?? ''))
              .join('\n')
          : ''
    )
    .filter(Boolean);
  const latest = users.at(-1) ?? '';
  const frameStart = latest.lastIndexOf('Process this queued GROUP CHAT message.');
  const current = frameStart >= 0 ? latest.slice(frameStart) : latest;
  const all = users.join('\n');
  // Do not intercept provider admission probes, session titles, or bootstrap.
  if (!all.includes('всем привет!')) return undefined;
  const id = 'test_' + randomUUID().replaceAll('-', '');
  if (String(body.model).startsWith('claude')) {
    return { id, text: current.includes('всем привет!') ? 'Привет от ведущего.' : '' };
  }
  if (/opencode_delivery_retry|opencode_delivery_redelivery/.test(current)) {
    assert(current.includes('group_chat_send'), 'Repair must name group tool');
    assert(current.includes('relayOfMessageId'), 'Repair must retain physical origin');
    assert(!current.includes('via message_send'), 'Repair must never request private echo');
    repairCount++;
    return { id, text: 'Привет! Я Alice, на связи.' };
  }
  if (!current.includes('всем привет!')) return { id, text: '' };
  markerCount++;
  return { id, text: '[[AGENT_TEAMS_NO_REPLY]]' };
});
const cli = process.env.GROUP_NO_REPLY_RUNTIME;
assert(
  cli && path.isAbsolute(cli),
  'GROUP_NO_REPLY_RUNTIME must identify the exact intended runtime'
);
const opencode = process.env.GROUP_NO_REPLY_OPENCODE;
assert(
  opencode && path.isAbsolute(opencode),
  'GROUP_NO_REPLY_OPENCODE must identify an existing binary'
);
const ownedBinary = path.join(root, 'opencode');
await copyFile(opencode, ownedBinary);
Object.assign(env, {
  CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: cli,
  CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: ownedBinary,
  OPENCODE_BIN_PATH: ownedBinary,
  NODE_BINARY: process.execPath,
  SHELL: '/bin/sh',
  AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
  pnpm_config_verify_deps_before_run: 'false',
  CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '180000',
  CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '180000',
  ANTHROPIC_BASE_URL: model.baseUrl,
  ANTHROPIC_API_KEY: 'synthetic-owned-key',
});
if (process.env.COREPACK_HOME) env.COREPACK_HOME = process.env.COREPACK_HOME;
await json(path.join(projectPath, 'opencode.json'), {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    'llama.cpp': {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: model.baseUrl + '/v1' },
      models: { 'group-e2e': {} },
    },
  },
  model: 'llama.cpp/group-e2e',
  small_model: 'llama.cpp/group-e2e',
});
await json(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'agent-teams-config.json'), {
  general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
});
await json(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), {
  env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key' },
});
await mkdir(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'projects'), { recursive: true });
let logs = '';
let logWrites = Promise.resolve();
const teamDir = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'teams', teamName);
async function api<T>(expression: string): Promise<T> {
  assert(client);
  return client.evaluate<T>('(async()=>await (' + expression + '))()');
}
async function rows(inbox: string): Promise<Json[]> {
  try {
    return JSON.parse(
      await readFile(path.join(teamDir, 'inboxes', inbox + '.json'), 'utf8')
    ) as Json[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function click(expression: string) {
  const point = await wait(
    'stable control: ' + expression,
    () =>
      client!.evaluate<{ x: number; y: number } | null>(
        `(async()=>{const e=${expression};if(!(e instanceof HTMLElement)||e.matches(':disabled'))return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();await new Promise(requestAnimationFrame);const next=e.getBoundingClientRect();if(['x','y','width','height'].some(k=>r[k]!==next[k]))return null;const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit||!e.contains(hit))return null;return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
      ),
    30_000
  );
  assert(point, 'Missing UI target: ' + expression);
  for (const type of ['mousePressed', 'mouseReleased'])
    await client!.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1,
    });
}
try {
  app = spawn('pnpm', ['dev:mcp'], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr])
    stream!.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
      logWrites = logWrites.then(() => appendFile(path.join(root, 'desktop.log'), chunk));
    });
  client = await wait('owned Electron CDP renderer', async () => {
    assert(app!.exitCode === null, 'Desktop exited: ' + logs.slice(-5000));
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(logs)?.[1];
    if (!port) return false;
    try {
      const targets = (await fetch('http://127.0.0.1:' + port + '/json/list').then((r) =>
        r.json()
      )) as Json[];
      const target = targets.find(
        (t) => t.type === 'page' && String(t.url).startsWith('http://localhost:')
      );
      return target
        ? ((await CdpClient.connect(String(target.webSocketDebuggerUrl))) as Client)
        : false;
    } catch {
      return false;
    }
  });
  await client.send('Page.enable');
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await client.send('Page.setWebLifecycleState', { state: 'active' });
  await wait('startup', () =>
    api<boolean>('window.electronAPI?.startup?.getStatus().then(s=>s.ready)').catch(() => false)
  );
  const request: TeamCreateRequest = {
    teamName,
    cwd: projectPath,
    providerId: 'anthropic',
    model: 'claude-sonnet-4-6',
    skipPermissions: true,
    syncModelsWithLead: false,
    prompt:
      'Owned model fixture. Stay idle until a user message. Never touch files or run shell tools.',
    members: [
      { name: 'alice', providerId: 'opencode', model: 'llama.cpp/group-e2e', role: 'Test worker' },
    ],
  };
  // Poll one long IPC call, never send a second createTeam on a CDP timeout.
  await client.evaluate(
    `(()=>{window.__groupNoReplyLaunch={done:false};window.electronAPI.teams.createTeam(${literal(request)}).then(value=>{window.__groupNoReplyLaunch={done:true,value}},error=>{window.__groupNoReplyLaunch={done:true,error:String(error)}});return true;})()`
  );
  const launch = await wait<Json>('team launch', () =>
    client!.evaluate(
      `(()=>{const x=window.__groupNoReplyLaunch;if(!x?.done)return null;if(x.error)throw new Error(x.error);return x.value;})()`
    )
  );
  await json(path.join(root, 'launch.json'), launch);
  created = true;
  await wait('runtime-created team config', async () => {
    try {
      await readFile(path.join(teamDir, 'config.json'), 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  });
  const group = await api<TeamGroupChatDTO>(
    `window.electronAPI.teamGroupChats.create(${literal({ teamName, id: randomUUID(), name: 'Alice regression', selectedMemberNames: ['alice', 'team-lead'], excludedMemberNames: [], autoIncludeNewMembers: false })})`
  );
  await wait('live group admission', async () => {
    try {
      const failure = JSON.parse(
        await readFile(path.join(teamDir, 'launch-failure-artifacts/latest.json'), 'utf8')
      ) as Json;
      throw new Error('Team launch failed; inspect ' + String(failure.manifestPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const groups = await api<TeamGroupChatDTO[]>(
      `window.electronAPI.teamGroupChats.list({teamName:${literal(teamName)}})`
    );
    return groups.some((g) => g.id === group.id && g.canSend);
  });
  await client.evaluate(
    `(async()=>{const s=window.__agentTeamsDevStore.getState();s.openTeamTab(${literal(teamName)},${literal(projectPath)});await s.selectTeam(${literal(teamName)},{skipProjectAutoSelect:true});s.setMessagesPanelMode('sidebar');})()`
  );
  await wait('group row', () =>
    client!.evaluate(
      `(async()=>{if(document.querySelector('[data-group-chat-id="${group.id}"]'))return true;const s=window.__agentTeamsDevStore?.getState();if(!s)return false;if(!s.activeTabId){await s.fetchTeams();s.openTeamTab(${literal(teamName)},${literal(projectPath)});await s.selectTeam(${literal(teamName)},{skipProjectAutoSelect:true});}s.setMessagesPanelMode('sidebar');return false;})()`
    )
  );
  await click(`document.querySelector('[data-group-chat-id="${group.id}"]')`);
  await wait('composer', () =>
    client!.evaluate(
      `Boolean(document.querySelector('[data-testid="group-chat-composer"] textarea:not([disabled]):not([readonly])'))`
    )
  );
  // New group composers default to the lead. This regression is a user broadcast.
  await click(
    `document.querySelector('[data-testid="group-chat-composer"] button[aria-label="Select..."]')`
  );
  await click(
    `Array.from(document.querySelector('[data-radix-popper-content-wrapper]')?.querySelectorAll('button')??[]).find(e=>e.textContent.trim()==='All')`
  );
  await client.screenshot(path.join(root, 'before.png'));
  await click(`document.querySelector('[data-testid="group-chat-composer"] textarea')`);
  await client.send('Input.insertText', { text: 'всем привет!' });
  await click(
    `Array.from(document.querySelector('[data-testid="group-chat-composer"]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Send'&&!e.disabled)`
  );
  const reply = await wait<Json>('one canonical Alice answer after correction', async () => {
    const history = await rows('user');
    const replies = history.filter(
      (row) => row.from === 'alice' && row.text === 'Привет! Я Alice, на связи.'
    );
    if (!replies.length) return false;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.groupChatId, group.id);
    assert.equal(replies[0]!.groupMessageId, replies[0]!.messageId);
    assert(!history.some((row) => String(row.text).includes('AGENT_TEAMS_NO_REPLY')));
    assert(!history.some((row) => row.from === 'alice' && !row.groupChatId));
    return replies[0]!;
  });
  const inbound = (await rows('alice')).find(
    (row) => row.from === 'user' && row.text === 'всем привет!'
  )!;
  assert(inbound);
  assert.equal(reply.relayOfMessageId, inbound.messageId);
  await wait('physical inbox read commit', async () =>
    (await rows('alice')).some((row) => row.messageId === inbound.messageId && row.read)
  );
  await wait('rendered canonical reply', () =>
    client!.evaluate(
      `document.querySelector('[data-messages-thread-container="true"]')?.textContent.includes('Привет! Я Alice, на связи.')??false`
    )
  );
  const snapshot = await api<TeamAgentRuntimeSnapshot>(
    `window.electronAPI.teams.getTeamAgentRuntime(${literal(teamName)})`
  );
  assert(
    !JSON.stringify(snapshot.members.alice).includes('group_non_response_runtime_unsupported')
  );
  assert(markerCount >= 1, 'The defect must actually occur in the real model turn');
  assert.equal(repairCount, 1, 'Exactly one corrective model request for Alice');
  assert.equal(model.errors.length, 0);
  await client.screenshot(path.join(root, 'after.png'));
  await json(path.join(root, 'result.json'), {
    ok: true,
    root,
    teamName,
    markerCount,
    repairCount,
    inbound,
    reply,
    snapshot,
  });
  console.log(JSON.stringify({ ok: true, root, markerCount, repairCount }));
} catch (error) {
  await client?.screenshot(path.join(root, 'failure.png')).catch(() => undefined);
  await json(path.join(root, 'result.json'), {
    ok: false,
    root,
    error: String(error),
    markerCount,
    repairCount,
  });
  throw error;
} finally {
  if (created && client)
    await api(`window.electronAPI.teams.stop(${literal(teamName)})`).catch(() => undefined);
  await client?.close();
  if (app?.pid && app.exitCode === null) {
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {
      /* exited */
    }
  }
  await model.close();
  await logWrites;
}
