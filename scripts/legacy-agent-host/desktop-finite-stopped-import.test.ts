import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = join(import.meta.dirname, '../../tools/owned-process-broker/fixtures/legacyBootstrapPeer.mjs');
const prompt = 'TEST_CURRENT_LEGACY_SOLO_ONE';
const deferredPrompt = 'You are "team-lead", the team lead.\nYour team is "test-stopped-legacy".\nUser instructions:\n' + prompt;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Synthetic protocol inputs only; these unit fixtures never claim an original Main release. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'tmp', 'workspace', 'userData', 'claude', 'claude/teams/test-stopped-legacy', 'claude/tasks/test-stopped-legacy'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const prefix = 'agent-teams-bootstrap-' + sha(join(root, 'userData')).slice(0, 16) + '-';
  const specDirectory = await mkdtemp(join(root, 'tmp', prefix)); await chmod(specDirectory, 0o700);
  const promptDirectory = await mkdtemp(join(root, 'tmp/agent-teams-bootstrap-prompt-')); await chmod(promptDirectory, 0o700);
  const team = join(root, 'claude/teams/test-stopped-legacy'), specPath = join(specDirectory, 'bootstrap.json');
  const markerPath = join(specDirectory, '.agent-teams-bootstrap-owner.json'), promptPath = join(promptDirectory, randomUUID() + '.txt');
  const runId = randomUUID();
  const spec = { version: 1, runId, mode: 'create', initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: 'test-stopped-legacy', cwd: join(root, 'workspace') }, lead: {}, members: [], ui: { emitStructuredEvents: true } };
  const meta = { version: 1, cwd: join(root, 'workspace'), model: 'claude-sonnet-4-6', providerId: 'anthropic', skipPermissions: false, prompt };
  for (const [path, value, mode] of [
    [specPath, spec, 0o600],
    [markerPath, { version: 1, kind: 'agent-teams-bootstrap', ownerPid: process.pid, specFile: 'bootstrap.json' }, 0o600],
    [join(team, 'team.meta.json'), meta, 0o644], [join(team, 'members.meta.json'), { version: 1, members: [] }, 0o644],
    [join(root, 'userData/mcp.json'), { mcpServers: {} }, 0o644],
  ] as const) await writeFile(path, JSON.stringify(value), { mode, flag: 'wx' });
  await writeFile(promptPath, deferredPrompt, { mode: 0o600, flag: 'wx' });
  const env = { HOME: join(root, 'home'), CLAUDE_ROOT: join(root, 'claude'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
    TEST_LEGACY_BOOTSTRAP: 'current-solo-v1', TEST_LEGACY_BOOTSTRAP_ROOT: root, TEST_LEGACY_BOOTSTRAP_VERSION: '0.0.158',
    TEST_LEGACY_BOOTSTRAP_REPO: root };
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user,project,local', '--mcp-config', join(root, 'userData/mcp.json'), '--team-bootstrap-spec', specPath,
    '--team-bootstrap-user-prompt-file', promptPath, '--disallowedTools', 'Agent', '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio', '--model', 'claude-sonnet-4-6'];
  const run = (selectedArgs = args, selectedEnv: NodeJS.ProcessEnv = env, cwd = join(root, 'workspace')) =>
    spawnSync(process.execPath, [source, ...selectedArgs], { env: selectedEnv, cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024 });
  return { root, team, specPath, markerPath, promptPath, runId, spec, meta, env, args, run };
}

test('finite legacy bootstrap consumes original-format private input and never writes Main lifecycle authority', { timeout: 10000 }, async t => {
  const f = await fixture(t), metaBefore = await readFile(join(f.team, 'team.meta.json'), 'utf8');
  const child = spawn(process.execPath, [source, ...f.args], { cwd: join(f.root, 'workspace'), env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
  const until = Date.now() + 3000;
  while (!output.includes('"subtype":"success"') && child.exitCode === null && Date.now() < until)
    await new Promise<void>(done => setTimeout(done, 20));
  assert.ok(output.includes('"subtype":"success"'), stderr); assert.equal(child.exitCode, null, 'runtime is alive until owner Stop');
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.filter(frame => frame.type === 'result').length, 1);
  assert.equal(frames.at(-1).result, 'REPLY_TEST_CURRENT_LEGACY_SOLO_ONE');
  const bootstrap = frames.filter(frame => frame.subtype === 'team_bootstrap');
  assert.deepEqual(bootstrap.map(frame => frame.event), ['started', 'team_created', 'completed']);
  assert.ok(bootstrap.every(frame => frame.run_id === f.runId && frame.team_name === 'test-stopped-legacy'));
  const config = JSON.parse(await readFile(join(f.team, 'config.json'), 'utf8'));
  assert.equal(config.leadSessionId, frames.at(-1).session_id); assert.equal(config.members.length, 1);
  assert.equal(await readFile(join(f.team, 'team.meta.json'), 'utf8'), metaBefore);
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, child.pid);
  await assert.rejects(lstat(f.specPath), { code: 'ENOENT' }); await assert.rejects(lstat(f.promptPath), { code: 'ENOENT' });
  for (const name of ['launch-state.json', 'launch-freshness.json', 'launch-stopped.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(f.team, name)), { code: 'ENOENT' });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  child.kill('SIGTERM'); assert.deepEqual(await exit, { code: 0, signal: null });
});

test('closed finite version, runtime/model metadata and exact PONG checks never create a source config', async t => {
  const f = await fixture(t);
  for (const args of [['--version'], ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic'],
    ['model', 'list', '--json', '--provider', 'anthropic'], ['auth', 'status', '--json', '--provider', 'anthropic'],
    ['-p', 'Output only the single word PONG.', '--output-format', 'text', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence']]) {
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    if (args[0] === 'runtime') assert.equal(JSON.parse(result.stdout).providers.anthropic.statusCheckOutcome, 'authoritative');
  }
  const journal = join(f.root, 'finite-legacy-peer.ndjson'), before = await readFile(journal, 'utf8');
  assert.deepEqual(before.trim().split('\n').map(line => JSON.parse(line)).filter(value => value.operation === 'runtime')
    .map(value => value.args), [['--json', '--summary', '--provider', 'anthropic'],
      ['--json', '--provider', 'anthropic', '--summary'], ['--json', '--provider', 'anthropic']]);
  for (const args of [
    ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--summary', '--summary', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', '--unexpected'],
    ['runtime', 'status', '--json', '--provider', 'codex', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ['runtime', 'status', '--json', '--provider', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', 'anthropic'],
    ['runtime', 'status', '--summary', '--json', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary=true'],
    ...(['model', 'auth'] as const).flatMap(kind => [
      [kind, kind === 'model' ? 'list' : 'status', '--json', '--summary', '--provider', 'anthropic'],
      [kind, kind === 'model' ? 'list' : 'status', '--json', '--provider', 'anthropic', '--summary'],
    ]),
  ]) {
    const result = f.run(args); assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /AssertionError/);
  }
  assert.equal(await readFile(journal, 'utf8'), before, 'rejected metadata flags emit no peer effects');
  await assert.rejects(lstat(join(f.team, 'config.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, undefined);
});

test('original Main provider-scoped summary argv is admitted without finite bootstrap authority', async t => {
  const f = await fixture(t);
  const main = await readFile(new URL('../../src/main/services/runtime/ClaudeMultimodelBridgeService.ts', import.meta.url), 'utf8');
  const begin = "    const args = ['runtime', 'status', '--json', '--provider', providerId];";
  const end = '    const timeout = this.getProviderStatusRuntimeTimeout';
  assert.equal(main.split(begin).length, 2); assert.equal(main.split(end).length, 2);
  const block = main.slice(main.indexOf(begin), main.indexOf(end));
  const expectedArgs: string[][] = [];
  for (const summary of [true, false]) {
    // Execute only the actual Main argument builder, with no service/process/IO methods available.
    const args = Array.from(runInNewContext('(() => {' + block + 'return args;})()', {
      providerId: 'anthropic', options: { summary }, context: { projectArgs: [] },
    }) as string[]);
    assert.deepEqual(args, ['runtime', 'status', '--json', '--provider', 'anthropic', ...(summary ? ['--summary'] : [])]);
    expectedArgs.push(args.slice(2));
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response.providers), ['anthropic']);
    assert.equal(response.providers.anthropic.supported, true);
    assert.equal(response.providers.anthropic.statusCheckOutcome, 'authoritative');
  }
  const effects = (await readFile(join(f.root, 'finite-legacy-peer.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(effects.map(row => [row.event, row.operation, row.args]),
    expectedArgs.map(args => ['metadata-control', 'runtime', args]));
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, undefined);
  assert.equal(await readFile(f.promptPath, 'utf8'), deferredPrompt);
  assert.deepEqual(JSON.parse(await readFile(f.specPath, 'utf8')), f.spec);
  for (const name of ['config.json', 'launch-state.json', 'launch-freshness.json', 'launch-stopped.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(f.team, name)), { code: 'ENOENT' });
});

for (const scenario of ['extra-cli', 'wrong-provider', 'host-descriptor', 'outside-cwd', 'mixed-roster', 'wrong-prompt', 'wrong-profile-prefix', 'symlink-meta', 'source-config-present', 'world-writable-meta'] as const) {
  test('finite legacy source refuses ' + scenario + ' before runtime publication', async t => {
    const f = await fixture(t); let args = f.args, env: NodeJS.ProcessEnv = f.env, cwd = join(f.root, 'workspace');
    if (scenario === 'extra-cli') args = [...args, '--dangerously-skip-permissions'];
    if (scenario === 'wrong-provider') args = ['runtime', 'status', '--json', '--provider', 'codex'];
    if (scenario === 'host-descriptor') env = { ...env, AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: join(f.root, 'host.json') };
    if (scenario === 'outside-cwd') cwd = f.root;
    if (scenario === 'mixed-roster') await writeFile(f.specPath, JSON.stringify({ ...f.spec, members: [{ name: 'alice', provider: 'codex' }] }));
    if (scenario === 'wrong-prompt') await writeFile(f.promptPath, deferredPrompt + '\nexecute something else');
    if (scenario === 'wrong-profile-prefix') {
      const bad = join(f.root, 'tmp/agent-teams-bootstrap-0000000000000000-bad'); await mkdir(bad, { mode: 0o700 });
      args = args.map(value => value === f.specPath ? join(bad, 'bootstrap.json') : value);
    }
    if (scenario === 'symlink-meta') {
      const path = join(f.team, 'team.meta.json'), target = join(f.root, 'meta.json');
      await writeFile(target, JSON.stringify(f.meta), { mode: 0o600 }); await rm(path); await symlink(target, path);
    }
    if (scenario === 'source-config-present') await writeFile(join(f.team, 'config.json'), 'TEST existing source bytes', { mode: 0o600 });
    if (scenario === 'world-writable-meta') await chmod(join(f.team, 'team.meta.json'), 0o666);
    const result = f.run(args, env, cwd); assert.notEqual(result.status, 0); assert.notEqual(result.signal, 'SIGTERM', 'refusal cannot be a timeout');
    if (scenario === 'source-config-present') assert.equal(await readFile(join(f.team, 'config.json'), 'utf8'), 'TEST existing source bytes');
    else await assert.rejects(lstat(join(f.team, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.team, 'launch-stopped.json')), { code: 'ENOENT' });
  });
}
