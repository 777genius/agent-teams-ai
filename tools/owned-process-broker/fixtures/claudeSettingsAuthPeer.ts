/** Finite auth-status metadata for the isolated Settings peers; never contacts a provider. */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1');
assert.equal(process.env.TEST_PEER_PROVIDER, 'claude');
assert.equal(process.env.TEST_PEER_ROLE, 'management');
assert.ok(['extensions', 'saved-import'].includes(process.env.TEST_DESKTOP_SETTINGS ?? ''));
assert.deepEqual(process.argv.slice(2), ['auth', 'status', '--json']);
assert.equal(process.env.ANTHROPIC_API_KEY, 'TEST-LOCALHOST-ONLY');
assert.equal(process.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root && basename(dirname(root)).startsWith('TEST-desktop-backend-'));
assert.equal(root, join(dirname(root), 'TEST-peer-claude-scope'));
const cwd = join(dirname(root), 'workspace'), config = join(root, 'config'), home = join(root, 'home');
for (const path of [root, cwd, config, home]) assert.equal(realpathSync(path), path);
assert.equal(process.cwd(), cwd);
assert.equal(process.env.TEST_DESKTOP_PEER_WORKSPACE, cwd);
assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
assert.equal(process.env.HOME, home);
const effects = join(root, 'effects.ndjson');
assert.equal(process.env.TEST_PEER_EFFECTS, effects);
if (existsSync(effects)) {
  const info = lstatSync(effects);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
}
for (const event of ['launch', 'auth-status']) appendFileSync(effects,
  JSON.stringify({ provider: 'claude', role: 'management', pid: process.pid,
    parentPid: process.ppid, event, command: ['auth', 'status', '--json'] }) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty',
  configDirectory: config }) + '\n');
