import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deferredPrompt, fixture, source } from './desktop-retained-original-test-fixture.ts';


test('real retained archive factory prepares a fresh private tree without launching peers or writing lifecycle authority',
  { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-retained-preparation-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['home', 'tmp', 'corepack/dist/lib'])
      await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    // Only package metadata is read. Any attempted package-manager execution fails.
    await writeFile(join(root, 'corepack/package.json'), JSON.stringify({ name: 'corepack', version: 'TEST' }), { mode: 0o600 });
    for (const name of ['dist/pnpm.js', 'dist/lib/corepack.cjs'])
      await writeFile(join(root, 'corepack', name), 'throw new Error("TEST must never execute Corepack");\n', { mode: 0o600 });
    const repo = await realpath(join(import.meta.dirname, '../..'));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, pnpmEntry, temporary] = process.argv.slice(1);
const { prepareDesktopRetainedOriginalFixture, closeDesktopRetainedOriginalCatalog,
  RETAINED_ORIGINAL_TEAM, RETAINED_ORIGINAL_KIND, readRetainedOriginalEffects } =
  await import(pathToFileURL(join(repo, 'scripts/legacy-agent-host/desktop-retained-original-fixture.ts')).href);
assert.deepEqual(await readdir(temporary), [], 'fresh factory input contains no precreated team directories');
try {
  const fixture = await prepareDesktopRetainedOriginalFixture(repo, pnpmEntry);
  assert.equal(dirname(fixture.root), temporary);
  assert.equal(await realpath(fixture.root), fixture.root);
  const team = join(fixture.root, 'claude/teams', RETAINED_ORIGINAL_TEAM);
  for (const directory of [dirname(team), team, join(fixture.root, 'claude/tasks', RETAINED_ORIGINAL_TEAM)]) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o700);
  }
  assert.deepEqual((await readdir(team)).sort(), ['config.json', 'members.meta.json', 'team.meta.json']);
  for (const name of ['launch-state.json', 'launch-stopped.json', 'launch-freshness.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(team, name)), { code: 'ENOENT' });
  assert.equal(fixture.retainedOriginal.seed.sourceKind, RETAINED_ORIGINAL_KIND);
  assert.deepEqual(JSON.parse(await readFile(join(team, 'config.json'), 'utf8')), fixture.retainedOriginal.seed.config);
  assert.equal(fixture.appEnvironment.CLAUDE_CLI_PATH, fixture.retainedOriginal.executable.path);
  assert.equal(fixture.appEnvironment.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH, fixture.retainedOriginal.executable.path);
  assert.equal(fixture.appEnvironment.CODEX_CLI_PATH, join(fixture.root, 'bin/codex'));
  assert.deepEqual(await readRetainedOriginalEffects(fixture.root), []);
  await assert.rejects(lstat(fixture.sentinelLog), { code: 'ENOENT' });
  for (const peer of fixture.emulatedRuntime.peers)
    await assert.rejects(lstat(join(peer.root, 'effects.ndjson')), { code: 'ENOENT' });
  assert.equal(fixture.retainedOriginal.catalog.requests, 0);
  assert.deepEqual(fixture.retainedOriginal.catalog.failures, []);
  process.stdout.write(JSON.stringify({ sourceKind: RETAINED_ORIGINAL_KIND, team: RETAINED_ORIGINAL_TEAM }));
} finally {
  await closeDesktopRetainedOriginalCatalog();
}
`, repo, join(root, 'corepack/dist/pnpm.js'), join(root, 'tmp')], {
      cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
      env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LEGACY_DESKTOP_EMULATED_ONLY: '1',
        LEGACY_DESKTOP_PROOF_MODE: 'emulated-retained-original-ui' },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, 'preparation and original catalogue close must finish normally');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceKind: 'TEST-legacy-archive-without-native-release', team: 'test-retained-original',
    });
  });

test('finite archive Launch changes only the runtime session and never writes Main lifecycle authority', { timeout: 10000 }, async t => {
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
  assert.equal(frames.at(-1).result, 'REPLY_TEST_RETAINED_ORIGINAL_SOLO_ONE');
  const bootstrap = frames.filter(frame => frame.subtype === 'team_bootstrap');
  assert.deepEqual(bootstrap.map(frame => frame.event), ['started', 'completed']);
  assert.ok(bootstrap.every(frame => frame.run_id === f.runId && frame.team_name === 'test-retained-original'));
  const config = JSON.parse(await readFile(join(f.team, 'config.json'), 'utf8'));
  assert.equal(config.leadSessionId, frames.at(-1).session_id);
  assert.notEqual(config.leadSessionId, f.config.leadSessionId);
  assert.deepEqual({ ...config, leadSessionId: f.config.leadSessionId }, f.config);
  assert.equal(await readFile(join(f.team, 'team.meta.json'), 'utf8'), metaBefore);
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, child.pid);
  await assert.rejects(lstat(f.specPath), { code: 'ENOENT' }); await assert.rejects(lstat(f.promptPath), { code: 'ENOENT' });
  for (const name of ['launch-state.json', 'launch-freshness.json', 'launch-stopped.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(f.team, name)), { code: 'ENOENT' });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('close', (code, signal) => done({ code, signal })));
  child.kill('SIGTERM'); assert.deepEqual(await exit, { code: 0, signal: null });
});

test('finite version, private account/model status and PONG checks preserve the archive', async t => {
  const f = await fixture(t);
  for (const args of [['--version'], ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic'],
    ['model', 'list', '--json', '--provider', 'anthropic'], ['auth', 'status', '--json', '--provider', 'anthropic'],
    ['-p', 'Output only the single word PONG.', '--output-format', 'text', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence']]) {
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.team, 'config.json'), 'utf8')), f.config);
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, undefined);
});

for (const scenario of ['extra-cli', 'wrong-provider', 'wrong-host', 'outside-cwd', 'mixed-roster', 'wrong-prompt',
  'wrong-profile-prefix', 'symlink-meta', 'source-config-missing', 'world-writable-meta', 'wrong-main-owner',
  'source-config-drift', 'wrong-mode', 'seed-drift', 'existing-release'] as const) {
  test('finite retained archive refuses ' + scenario + ' before runtime publication', async t => {
    const f = await fixture(t); let args = f.args, env: NodeJS.ProcessEnv = f.env, cwd = join(f.root, 'workspace');
    const configPath = join(f.team, 'config.json');
    if (scenario === 'extra-cli') args = [...args, '--dangerously-skip-permissions'];
    if (scenario === 'wrong-provider') args = ['runtime', 'status', '--json', '--provider', 'codex'];
    if (scenario === 'wrong-host') env = { ...env, AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: join(f.root, 'foreign.json') };
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
    if (scenario === 'source-config-missing') await rm(configPath);
    if (scenario === 'source-config-drift') await writeFile(configPath, JSON.stringify({ ...f.config, description: 'unrelated edit' }));
    if (scenario === 'world-writable-meta') await chmod(join(f.team, 'team.meta.json'), 0o666);
    if (scenario === 'wrong-main-owner') await writeFile(f.markerPath, JSON.stringify({ version: 1, kind: 'agent-teams-bootstrap', ownerPid: process.ppid, specFile: 'bootstrap.json' }));
    if (scenario === 'wrong-mode') await writeFile(f.specPath, JSON.stringify({ ...f.spec, mode: 'create' }));
    if (scenario === 'seed-drift') await writeFile(f.seedPath, '{}');
    if (scenario === 'existing-release') await writeFile(join(f.team, 'launch-stopped.json'), 'TEST existing bytes', { mode: 0o600, flag: 'wx' });
    const before = await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const result = f.run(args, env, cwd); assert.notEqual(result.status, 0); assert.notEqual(result.signal, 'SIGTERM', 'refusal cannot be a timeout');
    assert.equal(await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }), before);
    if (scenario === 'existing-release') assert.equal(await readFile(join(f.team, 'launch-stopped.json'), 'utf8'), 'TEST existing bytes');
    else await assert.rejects(lstat(join(f.team, 'launch-stopped.json')), { code: 'ENOENT' });
  });
}
