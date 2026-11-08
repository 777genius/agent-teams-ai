#!/usr/bin/env node
// Read-only end-to-end probe of the published runtime shipped inside the macOS app.
// TEST-owned paths only; never reads or modifies a real File Provider or user profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('macOS packaged runtime E2E requires Darwin');
const app = process.argv[2];
if (!app) throw new Error('Pass the packaged .app path');
const runtime = path.join(path.resolve(app), 'Contents', 'Resources', 'runtime', 'claude-multimodel');
assert.ok(existsSync(runtime), 'The packaged .app must ship its pinned native runtime');
const root = await mkdtemp(path.join(tmpdir(), 'TEST-cloudstorage-status-'));
try {
  const home = path.join(root, 'isolated-home');
  const project = path.join(root, 'Library', 'CloudStorage', 'TEST Drive', 'My Portfolio');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
  };
  function run(args, expected = 0) {
    const result = spawnSync(runtime, args, {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 12 * 1024 * 1024,
      shell: false,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expected,
      `Packaged native command ${args[0]} ${args[1]} returned ${result.status}: ${result.stderr?.slice(-1000)}`);
    return result;
  }
  for (const args of [
    ['runtime', 'status', '--json', '--provider', 'opencode', '--summary', '--project-path', project],
    ['runtime', 'status', '--json', '--provider', 'opencode', '--project-path', project],
    ['model', 'list', '--json', '--provider', 'opencode', '--project-path', project],
  ]) {
    const result = run(args);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload && typeof payload === 'object' && payload.providers?.opencode,
      'Native JSON must retain the selected OpenCode provider');
  }
  const missing = path.join(root, 'absent-project');
  const denied = run(['runtime', 'status', '--json', '--provider', 'opencode',
    '--project-path', missing], 1);
  assert.match(denied.stderr, /status failed/i, 'Missing project must fail closed');
  assert.equal(denied.stdout.trim(), '', 'Missing project must not return ready JSON');
  console.log('PASS: packaged pinned macOS runtime, selected TEST project (spaces), status summary/full, model list, missing path fail-closed');
} finally {
  await rm(root, { recursive: true, force: true });
