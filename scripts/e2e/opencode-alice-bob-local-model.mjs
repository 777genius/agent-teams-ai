#!/usr/bin/env node
// Real OpenCode Alice/Bob peer read E2E. Only model HTTP is synthetic.
// Scope: inbox transport, two bound runtime sessions, four committed peer reads,
// and Stop. This does not qualify coding tasks, relaunch, or authenticated inference.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getExpectedRuntimeCliVersion, matchesRuntimeCliVersion } from '../lib/runtime-cli-version.mjs';
import { CdpClient } from './comment-notification/cdp.mjs';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment.ts';
import { startGroupChatModelServer } from './group-chat-model-server.ts';
import { createPeerModelFixture } from './opencode-peer-model-fixture.ts';

assert.equal(process.platform, 'linux', 'This synthetic OpenCode peer E2E requires Linux');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeCli = path.join(repo, 'resources/runtime/claude-multimodel');
assert((await stat(runtimeCli)).isFile(), 'Verified released orchestrator must be staged');
const runtimeLock = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8'));
const version = spawnSync(runtimeCli, ['--version'], { encoding: 'utf8', timeout: 15_000 });
assert.equal(version.status, 0);
assert(matchesRuntimeCliVersion(version.stdout, getExpectedRuntimeCliVersion(runtimeLock)),
  'Staged orchestrator CLI version mismatch');

const { root, projectPath, teamName, env } = await prepareNativeDesktopEnvironment();
const output = process.env.OPENCODE_PEER_E2E_EVIDENCE ||
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'opencode-peer-e2e-' + randomUUID());
await mkdir(output, { recursive: true });
const ledgerOutput = path.join(output, 'peer-read-receipts.json');
const modelOutput = path.join(output, 'model-requests.ndjson');
const screenshot = path.join(output, 'alice-bob-desktop.png');
const candidates = new Map();
const actions = new Map();
const seedReports = new Map();
const seedReads = [];
let peerSnapshot;
let model;
let client;
let app;
let launched = false;
let stopped = false;
let stopSubmitted = false;
let phase = 'setup';
let logs = '';
let creationResponse;
let latestRuntime;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const literal = v => JSON.stringify(v);

const syntheticModelTurn = createPeerModelFixture({ teamName, candidates, actions, seedReports });
async function wait(label, fn, ms = 180_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (app && (app.exitCode !== null || app.signalCode !== null))
      throw Error('Owned desktop exited during ' + label + ': ' + logs.slice(-4000));
    try {
      const found = await fn();
      if (found) return found;
    } catch (err) {
      if (!/execution context was destroyed|cannot find.*execution context/i.test(String(err)))
        throw err;
    }
    await pause(400);
  }
  throw Error('Timed out: ' + label);
}
async function getPort() {
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;
  await new Promise(res => server.close(res));
  return port;
}
async function api(expr) {
  assert(client);
  return client.evaluate('(async()=>await (' + expr + '))()');
}
async function inbox(member) {
  try {
    return JSON.parse(await readFile(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
      'teams', teamName, 'inboxes', member + '.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
async function receiptFor(message, bound, runId) {
  const dir = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'teams', teamName,
    '.opencode-runtime', 'lanes', encodeURIComponent(bound.laneId));
  const recordPath = path.join(dir, 'opencode-prompt-delivery-ledger.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(recordPath, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const records = Array.isArray(parsed?.data) ? parsed.data : [];
  return records.find(r => r.inboxMessageId === message.messageId &&
    r.teamName === teamName && r.runId === runId &&
    r.memberName === message.to && r.laneId === bound.laneId &&
    r.runtimeSessionId === bound.runtimeSessionId &&
    r.replyRecipient === message.from) ?? null;
}
async function settleSeed(nonce, snapshot) {
  const candidate = candidates.get(nonce);
  const completed = seedReports.get('seed-report:' + nonce);
  if (!candidate?.seedMessageId || !completed) return false;
  const { from, to, seedMessageId } = candidate;
  const seeds = (await inbox(from)).filter(m => m.messageId === seedMessageId &&
    m.from === 'user' && m.to === from && m.text === 'PEER_SEED:' + from + ':' + to + ':' + nonce);
  const reports = (await inbox('user')).filter(m => m.from === from &&
    m.to === 'user' && m.source === 'runtime_delivery' && m.relayOfMessageId === seedMessageId);
  if (seeds.length !== 1 || reports.length !== 1) return false;
  const report = reports[0];
  if (report.messageId !== completed.messageId || report.text !== completed.text ||
      typeof report.summary !== 'string' || !report.summary.trim()) return false;
  const receipt = await receiptFor(seeds[0], snapshot.members[from], snapshot.runId);
  const promptId = receipt?.lastRuntimePromptMessageId ?? receipt?.runtimePromptMessageId;
  const committed = receipt?.acceptanceUnknown === false && Boolean(receipt.acceptedAt) &&
    Boolean(promptId) && receipt.deliveredUserMessageId === promptId &&
    Boolean(receipt.observedAssistantMessageId) && receipt.status === 'responded' &&
    receipt.visibleReplyMessageId === report.messageId && receipt.visibleReplyInbox === 'user' &&
    receipt.visibleReplyCorrelation === 'relayOfMessageId' &&
    Boolean(receipt.inboxReadCommittedAt) && receipt.inboxReadCommitError === null && !receipt.cancelledAt;
  if (seeds[0].read !== true || !committed) return false;
  return { nonce, seedMessageId, replyMessageId: report.messageId, member: from,
    inboxRead: true, committed: true, ledgerStatus: receipt.status, responseState: receipt.responseState };
}
// Before cleanup, capture at most two original seed and four original peer
// rows, using only allowlisted delivery facts from the TEST-owned run.
async function ownedDeliveryDiagnostics(snapshot) {
  if (!snapshot?.runId || !snapshot.members?.alice || !snapshot.members?.bob) return [];
  const facts = [];
  for (const [nonce, candidate] of candidates) {
    const { from, to, seedMessageId } = candidate;
    const messages = [
      { member: from, sender: 'user', text: 'PEER_SEED:' + from + ':' + to + ':' + nonce,
        id: seedMessageId },
      { member: to, sender: from, text: 'CHALLENGE:' + nonce },
      { member: from, sender: to, text: 'ACK:' + nonce },
    ];
    for (const expected of messages) {
      const rows = (await inbox(expected.member)).filter(m => m.from === expected.sender &&
        m.to === expected.member && m.text === expected.text &&
        (expected.id === undefined || m.messageId === expected.id));
      const row = rows.length === 1 ? rows[0] : null;
      const receipt = row && await receiptFor(row, snapshot.members[expected.member], snapshot.runId);
      facts.push({ nonce, member: expected.member, sender: expected.sender,
        matches: rows.length, message: row && { messageId: row.messageId, from: row.from,
          to: row.to, read: row.read, source: row.source ?? null, relayOfMessageId: row.relayOfMessageId ?? null },
        receipt: receipt && { id: receipt.id, runId: receipt.runId, laneId: receipt.laneId,
          runtimeSessionId: receipt.runtimeSessionId, inboxMessageId: receipt.inboxMessageId,
          status: receipt.status, responseState: receipt.responseState, acceptedAt: receipt.acceptedAt,
          acceptanceUnknown: receipt.acceptanceUnknown, deliveredUserMessageId: receipt.deliveredUserMessageId,
          runtimePromptMessageId: receipt.lastRuntimePromptMessageId ?? receipt.runtimePromptMessageId,
          observedAssistantMessageId: receipt.observedAssistantMessageId,
          visibleReplyMessageId: receipt.visibleReplyMessageId, visibleReplyInbox: receipt.visibleReplyInbox,
          visibleReplyCorrelation: receipt.visibleReplyCorrelation,
          inboxReadCommittedAt: receipt.inboxReadCommittedAt,
          inboxReadCommitError: receipt.inboxReadCommitError !== null,
          cancelledAt: receipt.cancelledAt ?? null } });
    }
  }
  return facts;
}
async function settleMessages(messages, snapshot) {
  return wait('four original peer read commits', async () => {
    const checks = await Promise.all(messages.map(async m => {
      const physical = (await inbox(m.to)).filter(x => x.messageId === m.messageId &&
        x.from === m.from && x.to === m.to && x.text === m.text);
      const recipient = snapshot.members[m.to];
      const receipt = await receiptFor(m, recipient, snapshot.runId);
      const promptId = receipt?.lastRuntimePromptMessageId ?? receipt?.runtimePromptMessageId;
      const accepted = receipt?.acceptanceUnknown === false && Boolean(receipt?.acceptedAt) &&
        receipt?.deliveredUserMessageId === promptId && Boolean(promptId) &&
        Boolean(receipt?.observedAssistantMessageId);
      const observed = receipt?.status === 'responded' ||
        (m.text.startsWith('ACK:') && receipt?.status === 'unanswered' &&
          receipt?.responseState === 'empty_assistant_turn');
      return { id: m.messageId, from: m.from, to: m.to,
        inboxRead: physical.length === 1 && physical[0].read === true,
        committed: Boolean(accepted && observed && receipt?.inboxReadCommittedAt &&
          receipt?.inboxReadCommitError === null && !receipt?.cancelledAt),
        ledgerStatus: receipt?.status ?? null, responseState: receipt?.responseState ?? null };
    }));
    return checks.length === 4 && checks.every(c => c.inboxRead && c.committed) ? checks : false;
  }, 150_000);
}
async function run() {
  model = await startGroupChatModelServer(modelOutput, syntheticModelTurn);
  Object.assign(env, {
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtimeCli,
    ANTHROPIC_BASE_URL: model.baseUrl,
    ANTHROPIC_API_KEY: 'synthetic-owned-key',
    ANTHROPIC_AUTH_TOKEN: '',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    NODE_BINARY: process.execPath,
    SHELL: '/bin/sh',
    NO_SANDBOX: '1',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '180000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '180000',
  });
  for (const name of ['DISPLAY', 'XAUTHORITY', 'LANG', 'CI', 'PATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key' },
  }));
  await writeFile(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'agent-teams-config.json'),
    JSON.stringify({ general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark',
      defaultTab: 'teams' } }));
  await mkdir(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'projects'), { recursive: true });
  await writeFile(path.join(projectPath, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { 'llama.cpp': { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: model.baseUrl + '/v1' },
      models: { 'group-e2e': {} },
    } },
    model: 'llama.cpp/group-e2e', small_model: 'llama.cpp/group-e2e',
  }));
  phase = 'native-desktop-startup';
  const port = await getPort();
  app = spawn(process.execPath, [path.join(repo, 'scripts/dev-with-runtime.mjs'),
    '--remoteDebuggingPort', String(port), '--noSandbox'],
    { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', b => {
    logs = (logs + b.toString()).slice(-30_000);
  });
  const address = await wait('owned Electron CDP', async () => {
    if (!logs.includes('DevTools listening on ws://127.0.0.1:' + port + '/')) return false;
    const list = await fetch('http://127.0.0.1:' + port + '/json/list')
      .then(r => r.json()).catch(() => []);
    return list.find(x => x.type === 'page' && x.url?.startsWith('http://localhost:'))
      ?.webSocketDebuggerUrl ?? false;
  }, 180_000);
  client = await CdpClient.connect(address);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await wait('native startup', () =>
    api('window.electronAPI?.startup?.getStatus().then(x=>x.ready)').catch(() => false));
  phase = 'native-opencode-install';
  let installed = await api('window.electronAPI.openCodeRuntime.getStatus()');
  if (!installed.installed) {
    // Installation is one original IPC invocation even if it outlasts CDP's 30s command limit.
    await api("(() => { window.__peerInstall={done:false}; " +
      "window.electronAPI.openCodeRuntime.install().then(" +
      "value => window.__peerInstall={done:true,value}," +
      "error => window.__peerInstall={done:true,error:String(error)}); return true; })()");
    const result = await wait('owned native OpenCode installation',
      () => client.evaluate('window.__peerInstall?.done ? window.__peerInstall : null'), 240_000);
    if (result.error) throw Error('OpenCode installation failed: ' + result.error);
    installed = result.value;
  }
  assert(installed.installed && installed.binaryPath?.startsWith(root),
    'Native OpenCode must be installed in the disposable profile');
  phase = 'product-team-create';
  const request = {
    teamName, cwd: projectPath, providerId: 'opencode', model: 'llama.cpp/group-e2e',
    // This protocol proof observes the fixed test-owned team root directly.
    projectContextMode: 'shared',
    skipPermissions: true, syncModelsWithLead: false,
    prompt: 'Synthetic model HTTP boundary. Work only in the disposable project. Do not create tasks or edit files. Process explicit PEER_SEED, CHALLENGE and ACK messages through message_send.',
    members: ['alice', 'bob'].map(name => ({
      name, providerId: 'opencode', model: 'llama.cpp/group-e2e', role: 'Test peer',
    })),
  };
  await api(`(() => {
    window.__peerLaunch = {done:false};
    window.electronAPI.teams.createTeam(${literal(request)}).then(
      value => window.__peerLaunch={done:true,value},
      error => window.__peerLaunch={done:true,error:String(error)}
    ); return true;
  })()`);
  const launch = await wait('real createTeam IPC', () =>
    client.evaluate('window.__peerLaunch?.done ? window.__peerLaunch : null'), 240_000);
  if (launch.error) throw Error('OpenCode team create failed: ' + launch.error);
  creationResponse = launch.value;
  assert(typeof creationResponse?.runId === 'string' && creationResponse.runId,
    'Real createTeam IPC did not return a runId');
  launched = true;
  const snapshot = await wait('two distinct original OpenCode runtime sessions', async () => {
    const value = await api(`window.electronAPI.teams.getTeamAgentRuntime(${literal(teamName)})`);
    latestRuntime = value;
    // A failed native custody/readiness gate is terminal, not a 240s
    // two-session timeout. Keep the original failure reason for diagnosis.
    const status = await api(`window.electronAPI.teams.getProvisioningStatus(${literal(creationResponse.runId)})`);
    if (status?.state === 'failed')
      throw Error('Original OpenCode provisioning failed: ' + String(status.error ?? status.message ?? 'unknown'));
    const a = value?.members?.alice, b = value?.members?.bob;
    // A homogeneous all-OpenCode team uses ONE primary lane by design;
    // its two distinct model sessions must still be independently committed.
    return a?.alive && b?.alive && a.historicalBootstrapConfirmed && b.historicalBootstrapConfirmed &&
      a.laneId && b.laneId && a.runtimeSessionId && b.runtimeSessionId &&
      a.runtimeSessionId !== b.runtimeSessionId
      ? value : false;
  }, 240_000);
  peerSnapshot = snapshot;
  await client.screenshot(screenshot);
  phase = 'peer-challenge-and-ack';
  const originalMessages = [];
  for (const [from, to] of [['alice', 'bob'], ['bob', 'alice']]) {
    const nonce = randomUUID();
    candidates.set(nonce, { from, to });
    await api(`window.electronAPI.teams.sendMessage(${literal(teamName)}, ${literal({
      member: from, from: 'user', text: 'PEER_SEED:' + from + ':' + to + ':' + nonce,
    })})`);
    const pair = await wait('physical peer challenge and ack ' + nonce, async () => {
      const challenge = (await inbox(to)).filter(m =>
        m.from === from && m.to === to && m.text === 'CHALLENGE:' + nonce);
      const ack = (await inbox(from)).filter(m =>
        m.from === to && m.to === from && m.text === 'ACK:' + nonce);
      if (challenge.length !== 1 || ack.length !== 1) return false;
      const seedRead = await settleSeed(nonce, snapshot);
      if (!seedRead) return false;
      seedReads.push(seedRead);
      return [challenge[0], ack[0]];
    }, 180_000);
    originalMessages.push(...pair);
  }
  assert.equal(new Set(originalMessages.map(m => m.messageId)).size, 4);
  const settlement = await settleMessages(originalMessages, snapshot);
  assert.equal(actions.size, 4, 'Four independent model-directed real message_send results required');
  assert.equal(seedReports.size, 2, 'Two independent correlated human reports required');
  assert.equal(seedReads.length, 2, 'Both original human inputs must have durable read commits');
  assert.equal(new Set(seedReads.map(row => row.replyMessageId)).size, 2);
  assert.equal(model.errors.length, 0, 'Local model protocol rejected an OpenCode request');
  phase = 'normal-original-stop';
  stopSubmitted = true;
  await api(`(() => {
    window.__peerStop={done:false};
    window.electronAPI.teams.stop(${literal(teamName)}).then(
      value => window.__peerStop={done:true,value},
      error => window.__peerStop={done:true,error:String(error)}
    ); return true;
  })()`);
  const stopResult = await wait('original team Stop IPC',
    () => client.evaluate('window.__peerStop?.done ? window.__peerStop : null'), 120_000);
  if (stopResult.error) throw Error('Original Stop failed: ' + stopResult.error);
  stopped = true;
  await wait('actual both OpenCode lanes stopped', async () => {
    const after = await api(`window.electronAPI.teams.getTeamAgentRuntime(${literal(teamName)})`);
    return after?.members?.alice?.alive !== true && after?.members?.bob?.alive !== true;
  }, 40_000);
  await writeFile(ledgerOutput, JSON.stringify({
    schemaVersion: 1, success: true, mode: 'real OpenCode with synthetic HTTP model',
    genuineOpenCodeProcessAndSessions: true,
    selectedModel: 'llama.cpp/group-e2e',
    runId: snapshot.runId,
    lanes: Object.fromEntries(['alice', 'bob'].map(name => [
      name, { laneId: snapshot.members[name].laneId,
        runtimeSessionId: snapshot.members[name].runtimeSessionId },
    ])),
    peerReads: settlement, actions: [...actions.values()],
    seedReads, seedReports: [...seedReports.values()],
    originalStopSubmitted: true, codingTaskAndRelaunchQualified: false,
    screenshot: path.basename(screenshot),
  }, null, 2) + '\n');
  console.log('Alice/Bob native peer proof:', ledgerOutput);
}
try { await run(); }
catch (error) {
  // Capture owned product launch and bootstrap state before cleanup. A timeout
  // without these original artifacts cannot distinguish a bad model route from
  // a genuine teammate launch failure; never infer success from a healthy probe.
  const teamRoot = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
    'teams', teamName);
  const persisted = {};
  for (const name of ['launch-state.json', 'bootstrap-state.json',
    'launch-failure-artifacts/latest.json']) {
    try { persisted[name] = JSON.parse(await readFile(path.join(teamRoot, name), 'utf8')); }
    catch (readError) { persisted[name] = { unavailable: String(readError) }; }
  }
  const progress = creationResponse?.runId && client
    ? await api(`window.electronAPI.teams.getProvisioningStatus(${literal(creationResponse.runId)})`)
      .catch(readError => ({ unavailable: String(readError) }))
    : null;
  // This product IPC already redacts launch logs, native bridge traces and
  // the artifact manifest. Preserve bounded tails BEFORE disposable teardown.
  const diagnosticBundle = creationResponse?.runId && client
    ? await api(`window.electronAPI.teams.getLaunchFailureDiagnostics(${literal(teamName)}, ${literal(creationResponse.runId)})`)
      .then(bundle => ({
        classification: bundle?.classification ?? null,
        bootstrapTransportBreadcrumb: bundle?.bootstrapTransportBreadcrumb ?? null,
        fileCount: Array.isArray(bundle?.files) ? bundle.files.length : 0,
        files: Array.isArray(bundle?.files) ? bundle.files.slice(0, 16).map(file => ({
          label: file.label, issue: file.issue ?? null,
          contentTail: typeof file.content === 'string' ? file.content.slice(-8000) : null,
        })) : [],
      }))
      .catch(readError => ({ unavailable: String(readError) }))
    : null;
  const ownedDeliveries = await ownedDeliveryDiagnostics(peerSnapshot)
    .catch(readError => ({ unavailable: String(readError) }));
  await writeFile(ledgerOutput, JSON.stringify({
    schemaVersion: 1, success: false, phase, error: String(error),
    seedReads, seedReports: [...seedReports.values()], ownedDeliveries,
    diagnosticBundle,
    creationResponse, latestRuntime, progress, persisted,
    modelErrors: model?.errors ?? [], actions: [...actions.values()],
    logTail: logs.slice(-4000),
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (launched && !stopSubmitted && client)
    await api(`window.electronAPI.teams.stop(${literal(teamName)})`).catch(() => undefined);
  await client?.close().catch(() => undefined);
  let processGroupRetired = true;
  if (app?.pid) {
    // detached:true creates this test's own process group. The launcher may exit
    // before Electron/Vite descendants, so inspect the GROUP, not app.signalCode.
    const groupId = app.pid;
    const groupAlive = () => {
      try { process.kill(-groupId, 0); return true; }
      catch (error) {
        if (error?.code === 'ESRCH') return false;
        throw error; // EPERM and other failures are not proof of retirement.
      }
    };
    const settleGroup = async (checks) => {
      for (let attempt = 0; attempt < checks && groupAlive(); attempt++) await pause(200);
    };
    try {
      if (groupAlive()) process.kill(-groupId, 'SIGTERM');
      await settleGroup(10);
      if (groupAlive()) process.kill(-groupId, 'SIGKILL');
      await settleGroup(30);
      if (groupAlive()) throw new Error('Test-owned Electron process group did not retire');
    } catch (error) {
      processGroupRetired = false;
      process.stderr.write('Owned E2E process cleanup failed: ' + String(error) + '\n');
      process.exitCode = 1;
    }
  }
  await model?.close().catch(() => { process.exitCode = 1; });
  // Never delete the disposable profile while an owned descendant may use it.
  if (processGroupRetired && process.env.OPENCODE_PEER_E2E_KEEP !== '1')
    await rm(root, { recursive: true, force: true }).catch(() => { process.exitCode = 1; });
}
