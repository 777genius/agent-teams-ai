// Drives one pure OpenCode team run through the app's preload API over CDP.
// TEST-only CI driver. Usage: node e2e.mjs <teamName> <projectDir> <model> <claudeRoot> <outDir> [port]
// Never prints secrets: this script does not read or send any credential.
import fs from 'node:fs';
import path from 'node:path';

const [, , teamName, projectDir, model, claudeRoot, outDir, portArg] = process.argv;
const port = portArg || '9222';
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, 'e2e-log.jsonl');
const log = (step, data) => {
  const line = JSON.stringify({ at: new Date().toISOString(), step, data });
  fs.appendFileSync(logPath, line + '\n');
  console.log(line.length > 1500 ? line.slice(0, 1500) + '...' : line);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /localhost:\d+|index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function call(expr) {
  const res = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})))()`, awaitPromise: true, returnByValue: true, timeout: 900000 });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 800));
  const v = res.result?.result?.value;
  return v === undefined ? undefined : JSON.parse(v);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v) => JSON.stringify(v);
const api = 'window.electronAPI.teams';
const teammate = 'alice';

function readInboxes() {
  const dir = path.join(claudeRoot, 'teams', teamName, 'inboxes');
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      try { out[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { out[f] = 'unreadable'; }
    }
  } catch { /* none yet */ }
  return out;
}
function summarizeInboxes(inboxes) {
  return Object.fromEntries(Object.entries(inboxes).map(([f, msgs]) => [f, Array.isArray(msgs)
    ? msgs.map((m) => ({ from: m.from, to: m.to, at: m.timestamp, read: m.read, text: String(m.text ?? '').slice(0, 300) }))
    : msgs]));
}
async function spawnStatuses() {
  const s = await call(`${api}.getMemberSpawnStatuses(${q(teamName)})`);
  return {
    teamLaunchState: s?.teamLaunchState, launchPhase: s?.launchPhase, runId: s?.runId,
    members: Object.fromEntries(Object.entries(s?.statuses ?? {}).map(([n, m]) => [n, {
      launchState: m.launchState, bootstrapConfirmed: m.bootstrapConfirmed, runtimeAlive: m.runtimeAlive,
      hardFailure: m.hardFailure, hardFailureReason: m.hardFailureReason, model: m.model,
    }])),
  };
}

log('status', await call('window.electronAPI.openCodeRuntime.getStatus()'));
log('prepare', await call(`${api}.prepareProvisioning(${q(projectDir)}, 'opencode', ['opencode'], [${q(model)}])`));
const created = await call(`${api}.createTeam(${q({ teamName, displayName: teamName, cwd: projectDir, providerId: 'opencode', model, skipPermissions: true, members: [{ name: teammate, role: 'developer', providerId: 'opencode', model }] })})`);
log('createTeam', created);

// Launch: poll provisioning until it settles, then member statuses until both settle.
let prov;
for (let i = 0; i < 80; i += 1) {
  prov = await call(`${api}.getProvisioningStatus(${q(created.runId)})`);
  if (['ready', 'failed', 'cancelled', 'disconnected'].includes(prov?.state)) break;
  await sleep(5000);
}
log('provisioning', { state: prov?.state, message: prov?.message, error: prov?.error, updatedAt: prov?.updatedAt });
let statuses;
for (let i = 0; i < 60; i += 1) {
  statuses = await spawnStatuses();
  const ms = Object.values(statuses.members);
  if (ms.length >= 2 && ms.every((m) => m.bootstrapConfirmed || m.hardFailure)) break;
  await sleep(5000);
}
log('memberStatuses', statuses);
if (prov?.state !== 'ready' || !Object.values(statuses.members).every((m) => m.bootstrapConfirmed)) {
  log('stop', 'launch did not settle with both members confirmed');
  ws.close();
  process.exit(2);
}

// Teammate task: create a file.
const fileName = 'v2-teammate.txt';
const task = await call(`${api}.createTask(${q(teamName)}, ${q({ subject: `Create ${fileName}`, description: `Create the file ${fileName} in the project root containing exactly one line: hello from ${teammate}. Then mark this task completed.`, owner: teammate, startImmediately: true })})`);
log('createTask', { id: task?.id, status: task?.status, owner: task?.owner });
let taskNow;
for (let i = 0; i < 60; i += 1) {
  taskNow = await call(`${api}.getTask(${q(teamName)}, ${q(task.id)})`);
  if (taskNow?.status === 'completed') break;
  await sleep(10000);
}
const filePath = path.join(projectDir, fileName);
log('taskResult', { status: taskNow?.status, owner: taskNow?.owner, fileExists: fs.existsSync(filePath), fileContent: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null });

// Lead to teammate: the lead must ask the teammate and confirm.
const sendStartMs = Date.now();
const leadMessage = await call(`${api}.sendMessage(${q(teamName)}, ${q({ member: 'team-lead', text: `Ask ${teammate} to append the line "second line from ${teammate}" to ${fileName}, wait for ${teammate}'s reply, then reply to me confirming what ${teammate} said.` })})`);
log('sendToLead', leadMessage);
// Strict wait (Linux run): the final relay is a lead -> user message newer than the
// teammate's reply to the lead, which itself must be newer than the user's request.
const ts = (m) => Date.parse(m?.timestamp ?? '') || 0;
const sentAtMs = sendStartMs;
let inboxes;
let milestones = {};
const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline) {
  inboxes = readInboxes();
  const asList = (f) => (Array.isArray(inboxes[f]) ? inboxes[f] : []);
  const leadToTeammate = asList(`${teammate}.json`).find((m) => m.from === 'team-lead' && ts(m) >= sentAtMs);
  const teammateReply = asList('team-lead.json').find((m) => m.from === teammate && ts(m) > (leadToTeammate ? ts(leadToTeammate) : sentAtMs));
  const leadFinal = teammateReply && asList('user.json').find((m) => m.from === 'team-lead' && ts(m) > ts(teammateReply));
  const fileNow = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  milestones = {
    leadToTeammateAt: leadToTeammate?.timestamp ?? null,
    teammateReplyAt: teammateReply?.timestamp ?? null,
    leadFinalAt: leadFinal?.timestamp ?? null,
    fileHasSecondLine: /second line from/.test(fileNow),
  };
  if (leadFinal && milestones.fileHasSecondLine) break;
  await sleep(10000);
}
log('relayMilestones', { ...milestones, waitedSeconds: Math.round((Date.now() - sentAtMs) / 1000) });
fs.writeFileSync(path.join(outDir, 'inboxes-full.json'), JSON.stringify(inboxes, null, 2));
log('inboxes', summarizeInboxes(inboxes));
log('fileAfterMessage', fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
const endStatuses = await spawnStatuses();
log('memberStatusesEnd', endStatuses);
const finalFile = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
const verdict = {
  taskCompleted: taskNow?.status === 'completed',
  teammateFile: /hello from alice/.test(finalFile),
  leadToTeammate: Boolean(milestones.leadToTeammateAt),
  teammateReply: Boolean(milestones.teammateReplyAt),
  leadFinalRelay: Boolean(milestones.leadFinalAt),
  secondLine: Boolean(milestones.fileHasSecondLine),
  membersAliveAtEnd: Object.values(endStatuses.members).every((m) => m.runtimeAlive && !m.hardFailure),
};
verdict.pass = Object.values(verdict).every(Boolean);
log('verdict', verdict);
try { log('stop', await call(`${api}.stop(${q(teamName)})`)); } catch (error) { log('stopError', String(error).slice(0, 500)); }
ws.close();
process.exit(verdict.pass ? 0 : 1);
