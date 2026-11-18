/** Finite legacy bootstrap protocol peer. Only config/transcript are runtime-owned writes. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

const root = process.env.TEST_LEGACY_BOOTSTRAP_ROOT;
assert.equal(process.env.TEST_LEGACY_BOOTSTRAP, 'current-solo-v1');
assert.ok(root && isAbsolute(root) && basename(root).startsWith('TEST-desktop-backend-'));
assert.equal(realpathSync(root), root);
assert.notEqual(process.platform, 'win32');
const claude = join(root, 'claude'), workspace = join(root, 'workspace'), tmp = join(root, 'tmp');
for (const path of [claude, workspace, tmp, join(root, 'home')]) assert.equal(realpathSync(path), path);
assert.equal(process.env.HOME, join(root, 'home'));
assert.equal(process.env.CLAUDE_CONFIG_DIR, claude);
assert.equal(process.env.CLAUDE_ROOT, claude);
assert.equal(process.env.TMPDIR, tmp);
assert.equal(process.env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH, undefined);
assert.equal(process.env.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256, undefined);
const journal = join(root, 'finite-legacy-peer.ndjson');
if (existsSync(journal)) assert.ok(lstatSync(journal).isFile() && !lstatSync(journal).isSymbolicLink());
let effects = 0;
const effect = value => {
  assert.ok(++effects <= 32);
  appendFileSync(journal, JSON.stringify({ kind: 'finite-legacy-bootstrap', pid: process.pid, ...value }) + '\n', { mode: 0o600 });
};
const privateFile = (path, base, maxBytes = 64 * 1024, strictPrivate = true) => {
  assert.ok(typeof path === 'string' && isAbsolute(path));
  const part = relative(base, path);
  assert.ok(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes);
  assert.ok((strictPrivate ? [0o600] : [0o600, 0o644]).includes(stat.mode & 0o777));
  assert.equal(stat.uid, process.getuid());
  return readFileSync(path, 'utf8');
};
const settingsObject = value => {
  const bytes = isAbsolute(value) ? privateFile(value, root) : value;
  assert.ok(Buffer.byteLength(bytes) <= 64 * 1024);
  const settings = JSON.parse(bytes);
  assert.ok(settings && typeof settings === 'object' && !Array.isArray(settings));
  return settings;
};
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  const version = process.env.TEST_LEGACY_BOOTSTRAP_VERSION;
  assert.match(version ?? '', /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  effect({ event: 'metadata-version' });
  process.stdout.write(version + ' (TEST finite legacy bootstrap peer)\n');
  process.exit(0);
}
// Original control-plane checks may prepend one private API-helper settings file.
const control = [...argv];
if (control[0] === '--settings') { settingsObject(control[1]); control.splice(0, 2); }
if (['model', 'runtime', 'auth'].includes(control[0])) {
  const kind = control.shift(); assert.equal(control.shift(), kind === 'model' ? 'list' : 'status');
  const remaining = [...control];
  assert.equal(remaining.shift(), '--json');
  const summary = remaining[0] === '--summary';
  if (summary) { assert.equal(kind, 'runtime'); remaining.shift(); }
  if (remaining[0] === '--provider') { assert.equal(remaining[1], 'anthropic'); remaining.splice(0, 2); }
  if (kind === 'runtime' && !summary && remaining[0] === '--summary') remaining.shift();
  assert.deepEqual(remaining, []);
  assert.ok([workspace, process.env.TEST_LEGACY_BOOTSTRAP_REPO].includes(process.cwd()));
  const model = 'claude-sonnet-4-6';
  const provider = { providerId: 'anthropic', displayName: 'Claude', supported: true,
    authenticated: true, authMethod: 'api_key', verificationState: 'verified', statusCheckOutcome: 'authoritative',
    statusMessage: 'Finite TEST protocol readiness', models: [model], defaultModel: model, effectiveDefaultModel: model,
    canLoginFromUi: false, capabilities: { teamLaunch: true, oneShot: true,
      extensions: { plugins: false, mcp: false, skills: false } },
    runtimeCapabilities: { modelCatalog: { dynamic: false, source: 'runtime' },
      reasoningEffort: { supported: false, values: [], configPassthrough: false } } };
  const response = kind === 'auth' ? { schemaVersion: 1, provider: 'anthropic', status: provider }
    : { schemaVersion: 1, providers: { anthropic: kind === 'model'
      ? { defaultModel: model, models: [{ id: model, label: 'Sonnet 4.6', description: 'Finite legacy protocol TEST model' }] }
      : provider } };
  effect({ event: 'metadata-control', operation: kind, args: control });
  process.stdout.write(JSON.stringify(response) + '\n'); process.exit(0);
}
if (control[0] === '-p') {
  assert.equal(process.cwd(), workspace);
  const model = control[5];
  assert.ok(['haiku', 'claude-sonnet-4-6'].includes(model));
  assert.deepEqual(control, ['-p', 'Output only the single word PONG.', '--output-format', 'text',
    '--model', model, '--max-turns', '1', '--no-session-persistence']);
  effect({ event: 'model-probe', model, prompt: control[1], reply: 'PONG' });
  process.stdout.write('PONG\n'); process.exit(0);
}
assert.equal(process.cwd(), workspace);
const options = {}, flags = new Set(['print', 'verbose']);
const values = new Set(['input-format', 'output-format', 'setting-sources', 'mcp-config', 'team-bootstrap-spec',
  'team-bootstrap-user-prompt-file', 'disallowedTools', 'permission-prompt-tool', 'permission-mode',
  'model', 'effort', 'settings', 'teammate-mode']);
assert.ok(argv.length <= 48 && Buffer.byteLength(JSON.stringify(argv)) <= 128 * 1024);
for (let index = 0; index < argv.length; index++) {
  const match = /^--([a-zA-Z-]+)$/u.exec(argv[index]);
  assert.ok(match && !Object.hasOwn(options, match[1]), 'closed legacy bootstrap argv');
  if (flags.has(match[1])) options[match[1]] = true;
  else {
    assert.ok(values.has(match[1]), 'closed legacy bootstrap argv');
    const value = argv[++index];
    assert.ok(typeof value === 'string' && !value.includes('\0'));
    options[match[1]] = value;
  }
}
for (const [key, value] of Object.entries({ print: true, verbose: true, 'input-format': 'stream-json',
  'output-format': 'stream-json', 'setting-sources': 'user,project,local', 'permission-mode': 'default',
  'permission-prompt-tool': 'stdio', model: 'claude-sonnet-4-6' })) assert.equal(options[key], value, key);
assert.ok(options.effort === undefined || options.effort === 'low');
assert.ok(options['teammate-mode'] === undefined || options['teammate-mode'] === 'in-process');
assert.equal(typeof options.disallowedTools, 'string');
assert.ok(options.disallowedTools.split(',').every(value => /^[A-Za-z0-9_:*.-]+$/u.test(value)));
if (options.settings) settingsObject(options.settings);
// The peer never executes hooks, tools, settings commands or MCP servers.
const mcp = JSON.parse(privateFile(options['mcp-config'], root, 64 * 1024, false));
assert.ok(mcp && typeof mcp.mcpServers === 'object' && !Array.isArray(mcp.mcpServers));
const specPath = options['team-bootstrap-spec'];
assert.equal(basename(specPath), 'bootstrap.json');
assert.equal(dirname(dirname(specPath)), tmp);
const profilePrefix = 'agent-teams-bootstrap-' + createHash('sha256').update(join(root, 'userData')).digest('hex').slice(0, 16) + '-';
assert.ok(basename(dirname(specPath)).startsWith(profilePrefix));
assert.match(basename(dirname(specPath)).slice(profilePrefix.length), /^[A-Za-z0-9]+$/u);
const markerPath = join(dirname(specPath), '.agent-teams-bootstrap-owner.json');
const marker = JSON.parse(privateFile(markerPath, tmp, 1024));
assert.equal(marker.version, 1); assert.equal(marker.kind, 'agent-teams-bootstrap');
assert.equal(marker.specFile, 'bootstrap.json'); assert.equal(marker.consumerPid, undefined);
assert.ok(Number.isSafeInteger(marker.ownerPid) && marker.ownerPid > 1);
process.kill(marker.ownerPid, 0);
// The runtime leases Main's one-shot file before reading it; it never acquires Main's release authority.
writeFileSync(markerPath, JSON.stringify({ ...marker, consumerPid: process.pid }), { mode: 0o600 });
const spec = JSON.parse(privateFile(specPath, tmp));
assert.equal(spec.version, 1); assert.equal(spec.mode, 'create');
assert.deepEqual(spec.initiator, { kind: 'app', source: 'claude_team_agent_teams_orchestrator' });
assert.match(spec.runId, /^[A-Za-z0-9_-]{8,128}$/u);
assert.equal(spec.team.name, 'test-stopped-legacy');
assert.equal(spec.team.cwd, workspace); assert.deepEqual(spec.members, []);
assert.equal(spec.ui.emitStructuredEvents, true);
const promptPath = options['team-bootstrap-user-prompt-file'];
assert.equal(dirname(dirname(promptPath)), tmp);
assert.match(basename(dirname(promptPath)), /^agent-teams-bootstrap-prompt-[A-Za-z0-9]+$/u);
const deferredPrompt = privateFile(promptPath, tmp), prompt = 'TEST_CURRENT_LEGACY_SOLO_ONE';
assert.ok(deferredPrompt.endsWith('\nUser instructions:\n' + prompt));
assert.equal(deferredPrompt.split(prompt).length, 2);
assert.ok(deferredPrompt.includes('You are "team-lead", the team lead.'));
assert.ok(deferredPrompt.includes(spec.team.name));
// The original Main must have materialized user intent before the runtime is admitted.
const team = join(claude, 'teams', spec.team.name), configPath = join(team, 'config.json');
assert.equal(realpathSync(team), team);
assert.equal(existsSync(configPath), false, 'source config is created only by this admitted runtime');
const meta = JSON.parse(privateFile(join(team, 'team.meta.json'), team, 64 * 1024, false));
assert.equal(meta.cwd, workspace); assert.equal(meta.model, 'claude-sonnet-4-6');
assert.equal(meta.providerId, 'anthropic'); assert.equal(meta.skipPermissions, false);
assert.equal(meta.prompt, prompt);
const members = JSON.parse(privateFile(join(team, 'members.meta.json'), team, 64 * 1024, false));
assert.deepEqual(members.members, []);
assert.equal(existsSync(join(team, 'launch-stopped.json')), false);
// Consume the original private bootstrap artifacts before publishing runtime output.
unlinkSync(specPath); unlinkSync(promptPath);
const session = randomUUID(), lead = 'team-lead@' + spec.team.name, now = Date.now();
const config = { name: spec.team.name, description: spec.team.description ?? '', createdAt: now,
  _backupIdentityId: randomUUID(), leadAgentId: lead, leadSessionId: session,
  members: [{ agentId: lead, name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic',
    model: 'claude-sonnet-4-6', joinedAt: now, cwd: workspace }] };
writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
const project = join(claude, 'projects', workspace.replace(/[\\/]/gu, '-'));
mkdirSync(project, { recursive: true, mode: 0o700 }); assert.equal(realpathSync(project), project);
const transcriptPath = join(project, session + '.jsonl');
const userId = randomUUID(), assistantId = randomUUID(), reply = 'REPLY_TEST_CURRENT_LEGACY_SOLO_ONE';
const transcript = [
  { type: 'user', uuid: userId, parentUuid: null, sessionId: session, cwd: workspace,
    timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'user', content: deferredPrompt } },
  { type: 'assistant', uuid: assistantId, parentUuid: userId, sessionId: session, cwd: workspace,
    timestamp: new Date().toISOString(), isSidechain: false,
    message: { id: assistantId, role: 'assistant', type: 'message', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: reply }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } } },
];
writeFileSync(transcriptPath, transcript.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
effect({ event: 'bootstrap', runId: spec.runId, sessionId: session, teamName: spec.team.name,
  configPath, transcriptPath, prompt, deferredPromptSha256: createHash('sha256').update(deferredPrompt).digest('hex'),
  parentPid: process.ppid, mainOwnerPid: marker.ownerPid, specPath });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const envelope = () => ({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null });
send({ type: 'system', subtype: 'init', ...envelope(), cwd: workspace, model: 'claude-sonnet-4-6',
  tools: [], mcp_servers: [], permissionMode: 'default', apiKeySource: 'none',
  claude_code_version: 'TEST-finite-legacy-bootstrap' });
for (const [index, event] of ['started', 'team_created', 'completed'].entries())
  send({ type: 'system', subtype: 'team_bootstrap', ...envelope(), event,
    run_id: spec.runId, team_name: spec.team.name, seq: index + 1, failed_members: [] });
send({ type: 'user', ...envelope(), message: { role: 'user', content: deferredPrompt } });
send({ type: 'assistant', ...envelope(), message: transcript[1].message });
send({ type: 'result', subtype: 'success', ...envelope(), is_error: false, duration_ms: 1,
  duration_api_ms: 0, num_turns: 1, result: reply, total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
effect({ event: 'turn-completed', runId: spec.runId, sessionId: session, prompt, reply });
// This process remains alive until the original Main Stop owns its actual exit.
process.stdin.resume();
process.stdin.on('data', () => { effect({ event: 'refused-unexpected-input' }); process.exit(78); });
const alive = setInterval(() => {}, 1000);
process.once('SIGTERM', () => { effect({ event: 'sigterm' }); clearInterval(alive); process.exit(0); });
process.once('SIGINT', () => { effect({ event: 'sigint' }); clearInterval(alive); process.exit(0); });
