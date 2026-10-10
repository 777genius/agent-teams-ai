/** Linux desktop native lead/native worker/real OpenCode vertical proof.
 * node --import tsx scripts/e2e/group-chats-runtime-desktop.ts --prepare
 * node --import tsx scripts/e2e/group-chats-runtime-desktop.ts --wait-ready
 * node --import tsx scripts/e2e/group-chats-runtime-desktop.ts --run
 * Add --source-only for the source extended flow or --compiled-only for an exact compiled artifact.
 * Only model HTTP is synthetic. A missing boundary fails; no fixture history/readiness.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { TeamCreateRequest, TeamAgentRuntimeSnapshot } from '../../src/shared/types/team.ts';
import type { TeamGroupChatDTO } from '../../src/features/team-group-chats/contracts/api.ts';
// Existing owned-renderer CDP transport, reused from the offline UI smoke.
// @ts-expect-error Existing JS CDP transport has no declaration.
import { CdpClient } from './comment-notification/cdp.mjs';
// @ts-expect-error Existing JS smoke path resolver has no declaration.
import { resolveLiveSmokeOrchestratorCliPath, resolveReleaseSmokeOrchestratorCliPath } from '../lib/live-smoke-runtime.mjs';
import { directive, startGroupChatModelServer, type Json, type ModelReceipt } from './group-chat-model-server.ts';

interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Json): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}
interface ReadyInput {
  revision: 'r3';
  appSha: string;
  runtimeSha: string;
  compiledCliSha256?: string;
  /** Workspace-relative exact reviewed source/build hashes, supplied by coordinator. */
  files: Record<string, string>;
}
interface Row extends Json { messageId: string; from: string; text: string; groupChatId?: string; groupMessageId?: string }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = path.join(repo, '.group-chat-e2e-scratch');
const runtimeRoot = path.dirname(resolveLiveSmokeOrchestratorCliPath({
  repoRoot: repo, env: { CLAUDE_DEV_RUNTIME_ROOT: process.env.CLAUDE_DEV_RUNTIME_ROOT },
}) as string);
const compiledCli = path.resolve(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || path.join(runtimeRoot,'dist/cli'));
const markerPath = path.resolve(process.env.GROUP_CHAT_E2E_REVIEWED_INPUTS?.trim() || path.join(repo,'docs/group-chat-runtime-ready.json'));
function reviewedPath(relative: string) {
  const prefix = '.group-chat-runtime/';
  return relative.startsWith(prefix) ? path.join(runtimeRoot,relative.slice(prefix.length)) : path.join(repo,relative);
}
const mode = process.argv[2] ?? '--prepare';
const compiledOnly = process.argv.includes('--compiled-only');
const sourceOnly = process.argv.includes('--source-only');
assert(!(compiledOnly && sourceOnly), 'Select only one explicit runtime proof scope');
const runtimeModes: readonly ('source' | 'built' | 'compiled')[] = compiledOnly ? ['compiled'] : sourceOnly ? ['source'] : ['source', 'built'];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const children = new Set<ChildProcess>();
let activeTeam: string | undefined;
let cdp: Cdp | undefined;
let phase = 'initialization';
const milestones: Json[] = [];
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
async function bounded<T>(label: string, read: () => Promise<T | null | false | undefined>, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function ready(): Promise<ReadyInput> {
  const input = JSON.parse(await readFile(markerPath, 'utf8')) as ReadyInput;
  assert.equal(input.revision, 'r3', 'Coordinator must attest reviewed r3 inputs');
  for (const key of ['appSha', 'runtimeSha'] as const) assert(/^[a-f0-9]{40}$/.test(input[key]), `Missing exact ${key}`);
  assert(input.files && Object.keys(input.files).length > 0, 'Marker needs exact file hashes');
  for (const required of ['runtime.lock.json', '.group-chat-runtime/cli-source', '.group-chat-runtime/cli', '.group-chat-runtime/dist/local-cli/cli.js'])
    assert(input.files[required], `Marker does not cover ${required}`);
  if (compiledOnly) {
    const expected = input.compiledCliSha256 ?? input.files['.group-chat-runtime/dist/cli'];
    assert(expected && /^[a-f0-9]{64}$/.test(expected), 'Compiled proof needs the exact reviewed artifact hash');
    assert.equal(await digest(compiledCli),expected,'Public compiled artifact changed');
  }
  assert(Object.keys(input.files).some(file => file.startsWith('src/')), 'Marker needs app source hashes');
  assert(Object.keys(input.files).some(file => file.startsWith('.group-chat-runtime/src/')), 'Marker needs runtime source hashes');
  for (const [relative, expected] of Object.entries(input.files)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Unsafe marker path');
    assert(/^[a-f0-9]{64}$/.test(expected), `Invalid hash: ${relative}`);
    assert.equal(await digest(reviewedPath(relative)), expected, `Frozen input changed: ${relative}`);
  }
  return input;
}
function spawnOwned(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = repo) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); return child;
}
async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  await delay(500);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
  }
}
async function evaluate<T>(expression: string): Promise<T> {
  assert(cdp); return await cdp.evaluate(expression) as T;
}
const literal = (value: unknown) => JSON.stringify(value);
const api = <T>(expression: string) => evaluate<T>(`(async () => { return await (${expression}); })()`);
async function click(expression: string) {
  const point = await evaluate<Json | null>(`(() => { const e=${expression}; if (!(e instanceof HTMLElement)) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert(point, `Missing UI target: ${expression}`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp!.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function fill(selector: string, text: string) {
  await click(`document.querySelector(${literal(selector)})`);
  await cdp!.send('Input.insertText', { text });
}
async function groups(team: string) {
  return api<TeamGroupChatDTO[]>(`window.electronAPI.teamGroupChats.list({teamName:${literal(team)}})`);
}
async function rows(teamDir: string, member = 'user'): Promise<Row[]> {
  try { return JSON.parse(await readFile(path.join(teamDir, 'inboxes', member + '.json'), 'utf8')) as Row[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function receiptsFor(token: string, teamDir: string, names: string[], groupId: string) {
  return bounded(`canonical replies ${token}`, async () => {
    const history = await rows(teamDir);
    const replies = history.filter(row => row.text === `E2E_REPLY:${token}:${row.from}`);
    if (!names.every(name => replies.some(row => row.from === name))) return null;
    for (const name of names) {
      const found = replies.filter(row => row.from === name);
      assert.equal(found.length, 1, 'Exactly one canonical reply per actor');
      assert.equal(found[0]!.groupChatId, groupId);
      assert.equal(found[0]!.groupMessageId, found[0]!.messageId);
    }
    assert(!history.some(row => row.text.includes(token) && !row.groupChatId), 'Private echo leaked from group turn');
    return replies;
  }, 180_000);
}
async function physicalCopies(teamDir: string, post: Row, names: string[]) {
  const copies = await Promise.all(names.map(async name => {
    const matching = (await rows(teamDir, name)).filter(row => row.groupMessageId === post.messageId);
    assert.equal(matching.length, 1, `One physical delivery for ${name}`);
    const copy = matching[0]!; assert.notEqual(copy.messageId, post.messageId);
    assert.equal(copy.groupChatId, post.groupChatId); assert.equal(copy.groupChatProtocolVersion, 1);
    return { name, ...copy };
  }));
  assert.equal(new Set(copies.map(copy => copy.messageId)).size, names.length);
  return copies;
}
async function groupUiSend(group: TeamGroupChatDTO, text: string) {
  if (!await evaluate<boolean>(`!!document.querySelector('[data-group-chat-id="${group.id}"]')`)) {
    const back = `document.querySelector('button[aria-label="Back to chats"]')`;
    if (await evaluate<boolean>(`!!(${back})`)) await click(back);
  }
  const row = `document.querySelector('[data-group-chat-id="${group.id}"]')`;
  if (await evaluate<boolean>(`!!(${row})`)) await click(row);
  await bounded('group composer ready', async () => {
    if (await evaluate<boolean>(`!!document.querySelector('[data-testid="group-chat-composer"] textarea:not([readonly]):not([disabled])')`)) return true;
    // Vite can reload after a newly visited messages surface is optimized.
    // Reopen the same actual team and group through normal navigation.
    if (activeTeam && !await evaluate<boolean>(`!!window.__agentTeamsDevStore?.getState().activeTabId`)) {
      await evaluate(`(async()=>{const s=window.__agentTeamsDevStore.getState();s.openTeamTab(${literal(activeTeam)});await s.selectTeam(${literal(activeTeam)},{skipProjectAutoSelect:true});s.setMessagesPanelMode('sidebar');})()`);
    }
    if (await evaluate<boolean>(`!!(${row})`)) await click(row);
    return false;
  });
  await fill('[data-testid="group-chat-composer"] textarea', text);
  await click(`Array.from(document.querySelector('[data-testid="group-chat-composer"]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Send')`);
}
async function genuineReady(team: string, names: string[], group: TeamGroupChatDTO, output: string, teamDir: string) {
  const result = await bounded('current protocol1 admission and live runtime identities', async () => {
    const snapshot = await api<TeamAgentRuntimeSnapshot>(`window.electronAPI.teams.getTeamAgentRuntime(${literal(team)})`);
    const processCommands = await Promise.all(names.map(async name=>{
      const member=snapshot.members[name];const pid=member?.runtimePid??member?.pid;
      if(!pid)return {name,error:'No runtime PID'};
      try{
        const cwd=await realpath(`/proc/${pid}/cwd`);
        assert(cwd.startsWith(path.dirname(path.dirname(output))+path.sep),'Refuse unowned process inspection');
        return {name,pid,cwd,argv:(await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').filter(Boolean)};
      }catch(error){return {name,pid,error:String(error)};}
    }));
    const nativeProofObservations = await Promise.all(names.filter(name=>snapshot.members[name]?.providerId!=='opencode').map(async name=>{
      const proofPath=path.join(teamDir,'members',encodeURIComponent(name.toLowerCase()),'.member-work-sync','runtime-admission','capability.json');
      try{return {name,path:proofPath,proof:JSON.parse(await readFile(proofPath,'utf8')) as Json};}
      catch(error){return {name,path:proofPath,error:String(error)};}
    }));
    await json(output,{status:'waiting',snapshot,nativeProofObservations,processCommands});
    const current = (await groups(team)).find(g => g.id === group.id);
    await json(output,{status:'waiting',catalog:current,snapshot,nativeProofObservations,processCommands});
    if (!current?.canSend || !names.every(name => snapshot.members[name]?.alive)) return null;
    assert(snapshot.runId, 'Current app run identity is required');
    for (const name of names) {
      const member = snapshot.members[name]!;
      const pid = member.runtimePid ?? member.pid;
      assert(pid && pid > 0, 'Readiness must have actual runtime PID'); process.kill(pid, 0);
      if (member.providerId === 'opencode') assert(member.runtimeSessionId, 'Real OpenCode session missing');
    }
    // canSend invokes main's actual native capability and live OpenCode handshake ports.
    return { catalog: current, snapshot };
  }, 240_000);
  // Capture the native proof emitted by the real REPL, never synthesize it.
  const nativeProofs: Json[] = [];
  for (const name of names) {
    const member = result.snapshot.members[name]!;
    if (member.providerId === 'opencode') continue;
    const proofPath = path.join(teamDir,'members',encodeURIComponent(name.toLowerCase()),'.member-work-sync','runtime-admission','capability.json');
    const proof = JSON.parse(await readFile(proofPath,'utf8')) as Json;
    assert.equal(proof.processorReady,true); assert.equal(proof.groupChatProtocolVersion,1);
    assert.equal(proof.pid,member.runtimePid ?? member.pid);
    assert.equal(proof.groupRunKey,`${String(proof.bootstrapRunId)}:${String(proof.pid)}`);
    nativeProofs.push(proof);
  }
  await json(output, {...result,nativeProofs}); return result;
}
async function main() {
  assert.equal(process.platform, 'linux', 'This headless desktop harness requires Linux and Xvfb');
  assert(['--prepare', '--wait-ready', '--run'].includes(mode));
  await mkdir(scratch, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(scratch, 'run-')));
  const evidence = path.join(root, 'evidence'); await mkdir(evidence);
  const model = await startGroupChatModelServer(path.join(evidence, 'model-requests.ndjson'));
  let outcome = 'incomplete';
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [path.dirname(process.execPath),process.env.PATH ?? '/usr/bin:/bin'].join(':');
  if (process.env.BUN_INSTALL) env.BUN_INSTALL=process.env.BUN_INSTALL;
  const ownedDirectories = { HOME: 'home', TMPDIR: 'tmp',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: 'claude', CLAUDE_CONFIG_DIR: 'claude',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: 'user-data', CLAUDE_MULTIMODEL_DATA_HOME: 'multimodel-data',
    CLAUDE_MULTIMODEL_CACHE_HOME: 'multimodel-cache', XDG_CONFIG_HOME: 'xdg-config', XDG_DATA_HOME: 'xdg-data',
    XDG_CACHE_HOME: 'xdg-cache', XDG_STATE_HOME: 'xdg-state', XDG_RUNTIME_DIR: 'xdg-runtime' };
  for (const [key, directory] of Object.entries(ownedDirectories)) {
    env[key] = path.join(root, directory); await mkdir(env[key]!, { recursive: true });
  }
  await chmod(env.XDG_RUNTIME_DIR!, 0o700);
  // Linux resolves this to the same owned scratch directory while keeping
  // tsx CLI and other Unix socket addresses below sockaddr_un's 108 bytes.
  env.TMPDIR=`/proc/${process.pid}/cwd/${path.relative(repo,env.TMPDIR!)}`;
  Object.assign(env, { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key',
    ANTHROPIC_AUTH_TOKEN: '', CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    NODE_BINARY: process.execPath, NO_SANDBOX: '1', SHELL: '/bin/sh',
    TAR_OPTIONS:'--no-same-owner',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1', pnpm_config_verify_deps_before_run: 'false',
    npm_config_cache: path.join(root, 'npm-cache'), ELECTRON_CACHE: path.join(scratch, 'cache/electron'),
    BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache'), GH_CONFIG_DIR: path.join(root, 'gh-config'),
    GIT_CONFIG_GLOBAL: path.join(root, 'home/.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: path.join(root, 'runtime-cache'),
    CLAUDE_TERMINAL_PLATFORM_STAGE_DIR: path.join(root, 'terminal-platform'),
    CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT: path.join(root, 'terminal-download'),
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '180000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '180000',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
  const bin = path.join(root, 'bin'); await mkdir(bin);
  env.PATH = bin + ':' + env.PATH;
  await json(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), { env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key' } });
  await json(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  try {
    if (mode === '--prepare') {
      phase = 'model HTTP fixture validation';
      const body = { model: 'synthetic', stream: true, messages: [{ role: 'user', content: 'Readiness execution probe' }] };
      for (const route of ['/v1/messages', '/v1/chat/completions']) {
        const response = await fetch(model.baseUrl + route, { method: 'POST', body: JSON.stringify(body) });
        assert.equal(response.status, 200); const stream = await response.text();
        assert(stream.includes('READY. No action requested.'));
        assert(stream.includes(route.includes('messages') ? 'message_stop' : '[DONE]'));
      }
      for (const [route, variant] of [['/v1/messages','native'],['/v1/messages','lead'],['/v1/chat/completions','opencode']] as const) {
        const anthropic = route === '/v1/messages';
        const groupChatId = randomUUID(), physical = randomUUID();
        const from = anthropic ? 'team-lead' : 'opencode';
        const prefix = anthropic ? 'mcp__agent-teams__' : 'agent-teams_';
        const context = {teamName:'TEST-fixture',from,groupChatId,messageId:'<new UUID, reused only for retry of this exact post>',relayOfMessageId:physical,text:'<reply>'};
        const prompt = variant === 'native'
          ? 'If a reply is needed, call group_chat_send with ' + JSON.stringify(context)
          : variant === 'lead'
            ? `You have new inbox messages addressed to you (team lead "${from}").\nGroup chat ${groupChatId}: physical message ${physical}, sender user.`
            : 'This message comes from a group chat. Its immutable origin is:\n' + JSON.stringify({teamName:'TEST-fixture',groupChatId,from,relayOfMessageId:physical});
        const messages: Json[] = [{role:'user',content: directive({kind:'reply',teamName:'TEST-fixture',token:route+variant}) + '\n' + prompt}];
        const tools = ['group_chat_list','group_chat_send'].map(name => anthropic
          ? {name:prefix+name,input_schema:{type:'object',properties:{}}}
          : {type:'function',function:{name:prefix+name,parameters:{type:'object',properties:{}}}});
        for (const expected of ['group_chat_list','group_chat_send']) {
          const response = await fetch(model.baseUrl+route,{method:'POST',body:JSON.stringify({model:'synthetic',stream:false,messages,tools})});
          assert.equal(response.status,200); const value = await response.json() as Json;
          const call = anthropic ? (value.content as Json[])[0]! : (((value.choices as Json[])[0]!.message as Json).tool_calls as Json[])[0]!;
          const fn = call.function as Json | undefined;
          assert.equal(fn?.name ?? call.name,prefix+expected);
          const input = fn ? JSON.parse(fn.arguments as string) as Json : call.input as Json;
          if(expected==='group_chat_send') { assert.equal(input.groupChatId,groupChatId);assert.equal(input.relayOfMessageId,physical);assert(/^[a-f0-9-]{36}$/.test(String(input.messageId))); }
          const id = call.id;
          if(anthropic) { messages.push({role:'assistant',content:[call]},{role:'user',content:[{type:'tool_result',tool_use_id:id,content:'[]'}]}); }
          else { messages.push({role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:id,content:'[]'}); }
        }
      }
      // Earlier user text may remain in the real native query. A fresh peer
      // frame must not replay that old directive or borrow its physical ID.
      for (const route of ['/v1/messages', '/v1/chat/completions']) {
        const content = 'Your task is to create a detailed summary of old context. Output only the single word PONG.\n' + directive({kind:'reply',teamName:'TEST-fixture',token:'stale'})
          + '\nProcess this queued GROUP CHAT message.\n'
          + '<queued_mailbox_message>\nE2E_REPLY:peer-current:worker\n</queued_mailbox_message>';
        const response = await fetch(model.baseUrl+route,{method:'POST',body:JSON.stringify({
          model:'synthetic',stream:false,messages:[{role:'user',content}],tools:[]})});
        assert.equal(response.status,200);
        const value = await response.json() as Json;
        const text = route.includes('messages') ? (value.content as Json[])[0]!.text
          : ((value.choices as Json[])[0]!.message as Json).content;
        assert.equal(text,'','A fresh peer frame cannot replay a historical directive');
      }

      // Tool-result-only continuations and skill reminders retain the latest
      // real prompt; a fresh peer frame must still supersede that directive.
      for (const route of ['/v1/messages', '/v1/chat/completions']) {
        const anthropic = route === '/v1/messages', prefix = anthropic ? 'mcp__agent-teams__' : 'agent-teams_';
        const groupChatId = randomUUID(), messageId = randomUUID(), actor = 'worker';
        const current = directive({kind:'proactive',teamName:'TEST-fixture',actor,groupChatId,messageId,token:'continuation-'+route});
        const misleading = directive({kind:'reply',teamName:'STALE-fixture',token:'must-not-follow'});
        const messages: Json[] = [{role:'user',content:'Process this queued mailbox message now.\n<queued_mailbox_message>\n'+current+'</queued_mailbox_message>'}];
        const tools = ['group_chat_list','group_chat_send'].map(name => anthropic
          ? {name:prefix+name,input_schema:{type:'object',properties:{}}}
          : {type:'function',function:{name:prefix+name,parameters:{type:'object',properties:{}}}});
        for (const expected of ['group_chat_list','group_chat_send','group_chat_send']) {
          const response = await fetch(model.baseUrl+route,{method:'POST',body:JSON.stringify({model:'synthetic',stream:false,messages,tools})});
          assert.equal(response.status,200); const value = await response.json() as Json;
          const call = anthropic ? (value.content as Json[])[0]! : (((value.choices as Json[])[0]!.message as Json).tool_calls as Json[])[0]!;
          const fn = call.function as Json | undefined, input = fn ? JSON.parse(fn.arguments as string) as Json : call.input as Json;
          assert.equal(fn?.name ?? call.name,prefix+expected); assert.equal(input.from,actor); assert.equal(input.teamName,'TEST-fixture');
          if (expected==='group_chat_send') { assert.equal(input.groupChatId,groupChatId);assert.equal(input.messageId,messageId);assert.equal(input.relayOfMessageId,undefined); }
          const reminder={type:'text',text:'<system-reminder>'+misleading+'</system-reminder>'};
          if (anthropic) messages.push({role:'assistant',content:[call]},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:misleading},reminder]});
          else messages.push({role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:misleading},{role:'user',content:[reminder]});
        }
        messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'old',content:misleading},
          {type:'text',text:'Process this queued GROUP CHAT message.\n<queued_mailbox_message>\nE2E_REPLY:peer-current:worker\n</queued_mailbox_message>'}]});
        const response = await fetch(model.baseUrl+route,{method:'POST',body:JSON.stringify({model:'synthetic',stream:false,messages,tools})});
        assert.equal(response.status,200); const value = await response.json() as Json;
        const text = anthropic ? (value.content as Json[])[0]!.text : ((value.choices as Json[])[0]!.message as Json).content;
        assert.equal(text,'','Merged fresh peer text must supersede the prior proactive directive');
      }
      assert.equal(model.errors.length, 0);
      await json(path.join(evidence, 'prepare.json'), { ok: true, boundary: 'Model SSE only; no runtime launch or vertical evidence',
        toolingHashes: { harness: await digest(fileURLToPath(import.meta.url)), model: await digest(path.join(repo, 'scripts/e2e/group-chat-model-server.ts')) } });
      outcome = 'prepared'; return;
    }
    phase = 'coordinator reviewed r3 marker';
    if (mode === '--wait-ready') {
      await bounded('coordinator marker (60 second observation)', async () => {
        try { await readFile(markerPath); return true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;
        }
      }, 60_000);
    }
    const input = await ready(); await json(path.join(evidence, 'inputs.json'), input);
    if (mode === '--wait-ready') { outcome = 'ready'; return; }
    assert(await readFile(path.join(runtimeRoot, 'cli-source')));
    phase = 'owned Xvfb startup';
    const xvfb = spawnOwned('Xvfb', ['-displayfd', '1', '-screen', '0', '1440x1000x24',
      '-nolisten', 'tcp'], env);
    let display = '', displayErrors = '';
    xvfb.stdout!.on('data', (chunk: Buffer) => { display += chunk.toString(); });
    xvfb.stderr!.on('data', (chunk: Buffer) => { displayErrors += chunk.toString(); });
    try {
      env.DISPLAY = ':' + await bounded('owned Xvfb display', async () => {
        assert(xvfb.exitCode===null && xvfb.signalCode===null,`Xvfb exited: ${displayErrors}`);
        return /^\d+\s*$/.test(display) ? display.trim() : null;
      }, 10_000);
    } finally { await writeFile(path.join(evidence,'xvfb.log'),displayErrors); }
    for (const runtimeMode of runtimeModes) {
      phase = runtimeMode + ' desktop startup';
      // Each wrapper proof owns fresh app/host state. Reusing a prior stopped
      // app's profile introduces lock/authority history unrelated to this test.
      for(const [key,directory] of Object.entries(ownedDirectories)) {
        if(key==='TMPDIR')continue;
        env[key]=path.join(root,runtimeMode+'-state',directory);await mkdir(env[key]!,{recursive:true});
      }
      await chmod(env.XDG_RUNTIME_DIR!,0o700);
      await mkdir(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'projects'), {recursive:true});
      await json(path.join(env.CLAUDE_CONFIG_DIR!,'settings.json'),{env:{ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_API_KEY:'synthetic-owned-key'}});
      await json(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!,'agent-teams-config.json'),{general:{appLocale:'en',agentLanguage:'en',theme:'dark',defaultTab:'teams'}});
      const cli = runtimeMode === 'compiled' ? compiledCli : runtimeMode === 'source'
        ? resolveLiveSmokeOrchestratorCliPath({ repoRoot: repo, env: { CLAUDE_DEV_RUNTIME_ROOT: runtimeRoot } }) as string
        : resolveReleaseSmokeOrchestratorCliPath({ repoRoot: repo, env: { CLAUDE_DEV_RUNTIME_ROOT: runtimeRoot } }) as string;
      // Normal app runtime configuration points directly at the real launcher.
      // Source mode uses the repository's existing trust/bootstrap checks.
      env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = cli;
      const project = path.join(root, runtimeMode + '-TEST-project'); await mkdir(project);
      await writeFile(path.join(project, 'README.md'), '# Owned synthetic group chat E2E\n');
      await json(path.join(project, 'opencode.json'), {
        $schema:'https://opencode.ai/config.json',
        provider: { 'llama.cpp': { npm: '@ai-sdk/openai-compatible', options: { baseURL: model.baseUrl + '/v1' }, models: { 'group-e2e': {} } } },
        model: 'llama.cpp/group-e2e', small_model: 'llama.cpp/group-e2e',
      });
      const log: string[] = [];
      const logPath = path.join(evidence, runtimeMode + '-desktop.log');
      let logWrites = Promise.resolve();
      const reservation=createServer();await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
      const address=reservation.address();assert(address && typeof address!=='string');
      const preferredPort=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
      // electron-vite accepts the last explicit option; this avoids racing the
      // coordinator for the launcher's low default port after compilation.
      const app = spawnOwned(process.execPath, ['./scripts/dev-with-runtime.mjs','--remoteDebuggingPort',String(preferredPort)], env);
      for (const stream of [app.stdout, app.stderr]) stream?.on('data', (chunk: Buffer) => {
        const text=chunk.toString(); log.push(text);
        logWrites=logWrites.then(()=>appendFile(logPath,text));
      });
      try {
        const port = await bounded('owned dev:mcp renderer', async () => {
          assert(app.exitCode === null && app.signalCode === null, `Desktop exited: ${app.exitCode}\n${log.slice(-15).join('')}`);
          assert(!log.join('').includes('Cannot start http server for devtools.'),'Owned CDP port bind failed');
          const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(log.join(''));
          if (!match) return null;
          try {
            const targets = await fetch(`http://127.0.0.1:${match[1]}/json/list`).then(r => r.json()) as {type:string;url:string;webSocketDebuggerUrl:string}[];
            const renderer = targets.find(target => target.type === 'page' && target.url.startsWith('http://localhost:'));
            if (!renderer) return null;
            cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl) as Cdp; return Number(match[1]);
          } catch { return null; }
        }, 180_000);
        await cdp!.send('Runtime.enable'); await cdp!.send('Page.enable');
        await bounded('app startup', () => api<boolean>('window.electronAPI?.startup?.getStatus().then(s=>s.ready)').catch(() => false));
        phase = runtimeMode + ' real OpenCode installer';
        let installed = await api<{installed:boolean;binaryPath?:string}>('window.electronAPI.openCodeRuntime.getStatus()');
        if (!installed.installed) installed = await api('window.electronAPI.openCodeRuntime.install()');
        assert(installed.installed && installed.binaryPath?.startsWith(root), 'OpenCode must be real and owned');
        await json(path.join(evidence, runtimeMode + '-opencode-install.json'), installed);
        const team = `group-vertical-${runtimeMode}-${randomUUID()}`; activeTeam = team;
        const teamDir = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'teams', team);
        const members = ['team-lead', 'worker', 'opencode'];
        const request: TeamCreateRequest = {
          teamName: team, cwd: project, providerId: 'anthropic', model: 'claude-sonnet-4-6',
          skipPermissions: false, syncModelsWithLead: false,
          prompt: 'Synthetic owned E2E. Stay idle unless an E2E_DIRECTIVE is delivered. No filesystem tools, tasks or private acknowledgements of group peer FYI.',
          members: [ { name: 'worker', providerId: 'anthropic', model: 'claude-sonnet-4-6', role: 'Synthetic native worker' },
            { name: 'opencode', providerId: 'opencode', model: 'llama.cpp/group-e2e', role: 'Synthetic OpenCode worker' } ],
        };
        phase = runtimeMode + ' normal team creation';
        // Team creation can outlast the shared CDP transport's 30s command
        // limit. Poll completion of the same real IPC promise in the renderer.
        await json(path.join(evidence,runtimeMode+'-launch-request.json'),{request,port,cli});
        await evaluate(`(()=>{window.__groupVerticalLaunch={done:false};window.electronAPI.teams.createTeam(${literal(request)}).then(value=>{window.__groupVerticalLaunch={done:true,value};},error=>{window.__groupVerticalLaunch={done:true,error:String(error)};});return true;})()`);
        const launch = await bounded<Json>('actual createTeam IPC completion',()=>evaluate<Json | null>(`(()=>{const result=window.__groupVerticalLaunch;if(!result?.done)return null;if(result.error)throw new Error(result.error);return result.value;})()`),180_000);
        await json(path.join(evidence, runtimeMode + '-launch.json'), { request, launch, port, cli });
        await bounded('created team', async () => {
          try {
            const failure=JSON.parse(await readFile(path.join(teamDir,'launch-failure-artifacts/latest.json'),'utf8')) as Json;
            const manifest=JSON.parse(await readFile(String(failure.manifestPath),'utf8')) as Json;
            throw new Error('Actual team launch failed: '+JSON.stringify(manifest.progress));
          } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
          return evaluate<boolean>(`(async()=>{const s=window.__agentTeamsDevStore?.getState();if(!s)return false;await s.fetchTeams();return window.__agentTeamsDevStore.getState().teams.some(t=>t.teamName===${literal(team)});})()`);
        });
        const g1 = await api<TeamGroupChatDTO>(`window.electronAPI.teamGroupChats.create(${literal({teamName:team,id:randomUUID(),name:'G1 all agents', selectedMemberNames:members,excludedMemberNames:[],autoIncludeNewMembers:true})})`);
        phase = runtimeMode + ' real current readiness';
        await genuineReady(team, members, g1, path.join(evidence, runtimeMode + '-ready.json'),teamDir);
        const g2=runtimeMode==='source' ? await api<TeamGroupChatDTO>(`window.electronAPI.teamGroupChats.create(${literal({teamName:team,id:randomUUID(),name:'G2 workers',selectedMemberNames:['worker','opencode'],excludedMemberNames:['team-lead'],autoIncludeNewMembers:false})})`) : undefined;
        await evaluate(`(async()=>{const s=window.__agentTeamsDevStore.getState();s.openTeamTab(${literal(team)},${literal(project)});await s.selectTeam(${literal(team)},{skipProjectAutoSelect:true});s.setMessagesPanelMode('sidebar');})()`);
        const token = `${runtimeMode}-initial`;
        phase = runtimeMode + ' UI user group send';
        await groupUiSend(g1, directive({kind:'reply',teamName:team,token}));
        const replies = await receiptsFor(token, teamDir, members, g1.id);
        const post = (await rows(teamDir)).find(row => row.from === 'user' && row.text.includes(token) && row.groupChatId === g1.id)!;
        assert(post); const copies = await physicalCopies(teamDir, post, members);
        for (const actor of ['team-lead', 'opencode']) {
          const calls = model.receipts.filter(receipt => receipt.decision.name?.endsWith('group_chat_send') && receipt.decision.input?.from === actor && receipt.decision.input?.teamName === team && String(receipt.decision.input?.text).includes(token));
          assert(calls.length > 0, `Real model group tool call missing for ${actor}`);
          assert.equal(calls[0]!.decision.input!.relayOfMessageId, copies.find(copy => copy.name === actor)!.messageId);
        }
        await bounded('rendered canonical group replies', async () => {
          const thread = await evaluate<string>(`document.querySelector('[data-messages-thread-container="true"]')?.textContent ?? ''`);
          if (!members.every(actor => thread.includes(`E2E_REPLY:${token}:${actor}`))) return false;
          for (const actor of members) assert.equal(thread.split(`E2E_REPLY:${token}:${actor}`).length - 1, 1, 'UI must show each canonical reply once');
          return true;
        });
        assert(model.receipts.some(receipt => receipt.decision.text === `E2E_REPLY:${token}:worker` && JSON.stringify(receipt.request).includes(copies.find(copy=>copy.name==='worker')!.messageId)), 'Native text fallback must originate from its actual physical handoff');
        await cdp!.screenshot(path.join(evidence, runtimeMode + '-group-replies.png'));
        await json(path.join(evidence, runtimeMode + '-delivery.json'), { post, replies, copies });
        if (runtimeMode === 'source') {
          assert(g2);await extendedSequence(team, teamDir, g1, g2, members, evidence, model);
        }
        await ready(); // End fence: exact source/build files did not change during proof.
        milestones.push({ runtimeMode, ok: true, team, cli, runtimePin: JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8')),
          builtCliSha256: await digest(path.join(runtimeRoot, 'dist/local-cli/cli.js')), actualCliSha256: await digest(cli) });
      } catch (error) {
        await cdp?.screenshot(path.join(evidence,runtimeMode+'-failure.png')).catch(()=>undefined);
        const persisted: Json = {};
        if (activeTeam) {
          for (const file of ['launch-state.json','bootstrap-state.json']) {
            try { persisted[file]=JSON.parse(await readFile(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!,'teams',activeTeam,file),'utf8')); }
            catch (readError) { persisted[file]={unavailable:String(readError)}; }
          }
        }
        await json(path.join(evidence,runtimeMode+'-failure.json'),{phase,error:String(error),persisted,
          body:await cdp?.evaluate('document.body.innerText').catch(()=>null),modelErrors:model.errors});
        milestones.push({runtimeMode,ok:false,phase,error:String(error),cli,
          runtimePin:JSON.parse(await readFile(path.join(repo,'runtime.lock.json'),'utf8')),
          builtCliSha256:await digest(path.join(runtimeRoot,'dist/local-cli/cli.js')),actualCliSha256:await digest(cli)});
      } finally {
        if (activeTeam && cdp) await api(`window.electronAPI.teams.stop(${literal(activeTeam)})`).catch(() => undefined);
        if (activeTeam) {
          const finalRows = await rows(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!, 'teams', activeTeam));
          const counts = new Map<string, number>();
          for (const row of finalRows.filter(row => row.text.startsWith('E2E_REPLY:'))) {
            const key = JSON.stringify([row.from,row.text,row.groupChatId]);
            counts.set(key,(counts.get(key) ?? 0)+1);
          }
          const duplicates = [...counts].filter(([,count])=>count!==1);
          const privateLeaks = finalRows.filter(row=>row.text.startsWith('E2E_REPLY:') && !row.groupChatId);
          await json(path.join(evidence,runtimeMode+'-post-stop-canonical.json'),{rows:finalRows,duplicates,privateLeaks});
          if (duplicates.length || privateLeaks.length) {
            const milestone = milestones.find(value=>value.runtimeMode===runtimeMode);
            if (milestone) Object.assign(milestone,{ok:false,error:'Post-stop canonical history has duplicate replies or private group echo',duplicates,privateLeaks});
          }
        }
        activeTeam = undefined; await cdp?.close().catch(() => undefined); cdp = undefined;
        await stopChild(app); await logWrites; await writeFile(logPath, log.join(''));
      }
    }
    assert(milestones.length===runtimeModes.length && milestones.every(milestone=>milestone.ok===true),
      'Every selected real runtime proof is required: '+JSON.stringify({runtimeModes,milestones}));
    assert.equal(model.errors.length, 0, model.errors.join('\n'));
    outcome = 'complete';
  } catch (error) {
    await cdp?.screenshot(path.join(evidence, 'failure.png')).catch(() => undefined);
    await json(path.join(evidence, 'failure.json'), { phase, error: String(error),
      body: await cdp?.evaluate('document.body.innerText').catch(() => null), modelErrors: model.errors });
    process.exitCode = mode === '--wait-ready' && phase === 'coordinator reviewed r3 marker' ? 75 : 1;
  } finally {
    await model.close(); for (const child of children) await stopChild(child);
    await json(path.join(evidence, 'result.json'), { outcome, phase, exitCode: process.exitCode ?? 0, runtimeModes, milestones,
      evidence, modelRequestCount: model.receipts.length, scope: 'Complete qualifies only selected runtimeModes: source includes the extended flow; built and compiled prove initial delivery. Prepare is model transport evidence only' });
    console.log(JSON.stringify({ outcome, phase, evidence, runtimeModes, exitCode: process.exitCode ?? 0 }));
  }
}

function freshPostCompactCatalog(receipts: ModelReceipt[], team: string, g1Id: string, g2Id: string) {
  const summaryIndex = receipts.findIndex(receipt =>
    JSON.stringify(receipt.request).includes('Your task is to create a detailed summary of') &&
    typeof receipt.decision.text === 'string' && receipt.decision.text.trim().length > 0);
  assert(summaryIndex >= 0, 'Missing actual nonempty compaction summary');
  const continuationIndex = receipts.findIndex((receipt, index) => index > summaryIndex &&
    receipt.decision.name?.endsWith('group_chat_list') &&
    receipt.decision.input?.teamName === team && receipt.decision.input?.from === 'team-lead' &&
    JSON.stringify(receipt.request).includes('source-postcompact'));
  assert(continuationIndex >= 0, 'Missing actual post-compact lead model request');
  const continuation = receipts[continuationIndex]!;
  const metaContents = (continuation.request.messages as Json[]).filter(message => message.role === 'user').flatMap(message =>
    typeof message.content === 'string' ? [message.content] :
      (message.content as Json[]).filter(block => block.type === 'text').map(block => String(block.text)));
  assert(metaContents.some(content => content.includes('After compaction, call group_chat_list with')),
    'Missing actual compact-created discovery content in continuation');
  const catalogResult = receipts.slice(continuationIndex + 1).flatMap(receipt =>
    (receipt.request.messages as Json[]).filter(message => message.role === 'user').flatMap(message =>
      Array.isArray(message.content) ? (message.content as Json[]).filter(block =>
        block.type === 'tool_result' && block.tool_use_id === continuation.decision.id) : []))[0];
  assert(catalogResult && catalogResult.is_error !== true, 'Missing successful exact post-compact catalog tool result');
  const text = typeof catalogResult.content === 'string' ? catalogResult.content :
    (catalogResult.content as Json[]).filter(block => block.type === 'text').map(block => String(block.text)).join('\n');
  const catalog: unknown = JSON.parse(text);
  assert(Array.isArray(catalog), 'Post-compact catalog result must be an array');
  const currentCatalog = catalog as TeamGroupChatDTO[];
  const g1 = currentCatalog.find(group => group.id === g1Id);
  const g2 = currentCatalog.find(group => group.id === g2Id);
  assert(g2?.archivedAt && g2.canSend === false, 'Continuation did not observe archived G2');
  assert(g1?.archivedAt === null && g1.canSend === true &&
    ['team-lead', 'worker', 'opencode', 'added'].every(name => g1.memberNames.includes(name)),
  'Continuation did not observe expanded G1 destinations');
  return { continuation, catalogResult, currentCatalog, compactSummary: receipts[summaryIndex] };
}

async function extendedSequence(team: string, teamDir: string, g1: TeamGroupChatDTO, g2: TeamGroupChatDTO, members: string[], evidence: string,
  model: Awaited<ReturnType<typeof startGroupChatModelServer>>) {
  phase = 'private DM still works';
  const dm = randomUUID();
  await api(`window.electronAPI.teams.sendMessage(${literal(team)},${literal({member:'worker',text:directive({kind:'private',teamName:team,token:dm})})})`);
  await bounded('ordinary native private reply', async () => (await rows(teamDir)).find(row => row.text === `E2E_PRIVATE_REPLY:${dm}` && !row.groupChatId));
  phase = 'proactive discovery and stable UUID replay over actual MCP';
  const proactive = randomUUID(); const token = 'source-proactive';
  // Worker receives a normal private turn and uses actual MCP for proactive G2 delivery.
  await api(`window.electronAPI.teams.sendMessage(${literal(team)},${literal({member:'worker',text:directive({kind:'proactive',teamName:team,actor:'worker',groupChatId:g2.id,messageId:proactive,token})})})`);
  await receiptsFor(token, teamDir, ['worker'], g2.id);
  const replayProof = await bounded('two acknowledged real MCP calls with stable UUID', async () => {
    const attempts = model.receipts.filter(receipt => receipt.decision.name?.endsWith('group_chat_send') && receipt.decision.input?.messageId === proactive);
    const distinct = [...new Map(attempts.map(receipt=>[receipt.decision.id,receipt])).values()];
    if (distinct.length < 2) return null;
    const results = distinct.slice(0,2).map(call => model.receipts.flatMap(receipt => {
      const messages = receipt.request.messages as Json[];
      return messages.flatMap(message=>Array.isArray(message.content) ? message.content as Json[] : []);
    }).find(block=>block.type==='tool_result' && block.tool_use_id===call.decision.id));
    if (results.some(result=>!result)) return null;
    for (const result of results) {
      assert(!result!.is_error,'Real MCP replay returned an execution error');
      assert(JSON.stringify(result).includes(proactive),'Real MCP result did not preserve canonical UUID');
    }
    return {calls:distinct.slice(0,2),results};
  });
  const saved = (await rows(teamDir)).filter(row => row.messageId === proactive); assert.equal(saved.length, 1);
  await physicalCopies(teamDir, saved[0]!, ['opencode']);
  const calls = replayProof.calls;
  assert.deepEqual(calls[0]!.decision.input, calls[1]!.decision.input);
  phase = 'archive and normal added member lifecycle';
  await api(`window.electronAPI.teamGroupChats.setArchived(${literal({teamName:team,groupChatId:g1.id,archived:true})})`);
  await api(`window.electronAPI.teams.addMember(${literal(team)},${literal({name:'added',providerId:'anthropic',model:'claude-sonnet-4-6',role:'Added synthetic member'})})`);
  const expanded = await bounded('archived auto membership', async () => {
    const current = (await groups(team)).find(group => group.id === g1.id);
    return current?.archivedAt && current.memberNames.includes('added') ? current : null;
  });
  const rejectedToken = randomUUID();
  let rejection: unknown;
  try { await api(`window.electronAPI.teamGroupChats.send(${literal({teamName:team,groupChatId:g1.id,messageId:randomUUID(),text:rejectedToken})})`); }
  catch (error) { rejection = String(error); }
  assert(rejection && /archiv/i.test(String(rejection)), 'Archived send must reject explicitly');
  for (const name of ['user',...members,'added'])
    assert(!(await rows(teamDir,name)).some(row => row.text.includes(rejectedToken)), 'Archive rejection leaked a saved message');
  await api(`window.electronAPI.teamGroupChats.setArchived(${literal({teamName:team,groupChatId:g1.id,archived:false})})`);
  await genuineReady(team, [...members,'added'], g1, path.join(evidence,'source-added-ready.json'),teamDir);
  await groupUiSend(g1, directive({kind:'reply',teamName:team,token:'source-restored'}));
  await receiptsFor('source-restored',teamDir,[...members,'added'],g1.id);
  phase = 'actual native compact and fresh catalog continuation';
  const before = model.receipts.length;
  await api(`window.electronAPI.teams.processSend(${literal(team)},'/compact')`);
  // Mutate catalog while the lead is compacting; continuation must discover it.
  await api(`window.electronAPI.teamGroupChats.setArchived(${literal({teamName:team,groupChatId:g2.id,archived:true})})`);
  await bounded('actual compaction model request', async () => model.receipts.slice(before).some(receipt => JSON.stringify(receipt.request).includes('Your task is to create a detailed summary of')));
  await groupUiSend(g1,directive({kind:'reply',teamName:team,token:'source-postcompact'}));
  await receiptsFor('source-postcompact',teamDir,[...members,'added'],g1.id);
  const catalogProof = freshPostCompactCatalog(model.receipts.slice(before),team,g1.id,g2.id);
  await json(path.join(evidence,'source-extended.json'),{g2,proactive,calls,replayProof,expanded,rejection,...catalogProof});
  // Rendered DM projection must exclude group content, not just physical history.
  const back = `document.querySelector('button[aria-label="Back to chats"]')`;
  if (await evaluate<boolean>(`!!(${back})`)) await click(back);
  await click(`Array.from(document.querySelectorAll('button[aria-label]')).find(e=>e.getAttribute('aria-label')?.startsWith('worker,'))`);
  await bounded('rendered ordinary DM',()=>evaluate<boolean>(`document.body.innerText.includes(${literal('E2E_PRIVATE_REPLY:'+dm)})`));
  assert(!await evaluate<boolean>(`document.querySelector('[data-messages-thread-container="true"]')?.textContent?.includes('E2E_REPLY:source-initial')`),'Group content leaked into DM UI');
  await cdp!.screenshot(path.join(evidence,'source-private-dm.png'));
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
