/** Closed TEST extension CLI protocol. It never downloads or executes vendor/plugin code. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1');
assert.equal(process.env.TEST_PEER_PROVIDER, 'claude');
assert.equal(process.env.TEST_PEER_ROLE, 'management');
assert.equal(process.env.TEST_DESKTOP_SETTINGS, 'extensions');
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root && basename(dirname(root)).startsWith('TEST-desktop-backend-'));
assert.equal(root, join(dirname(root), 'TEST-peer-claude-scope'));
assert.equal(realpathSync(root), root);
const config = join(root, 'config'), home = join(root, 'home'), cwd = join(dirname(root), 'workspace');
for (const path of [config, home, cwd]) assert.equal(realpathSync(path), path);
assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
assert.equal(process.env.TEST_DESKTOP_PEER_WORKSPACE, cwd);
const effects = join(root, 'effects.ndjson');
assert.equal(process.env.TEST_PEER_EFFECTS, effects);
if (existsSync(effects)) assert.ok(lstatSync(effects).isFile() && !lstatSync(effects).isSymbolicLink());
const effect = value => appendFileSync(effects, JSON.stringify({ provider: 'claude', role: 'management',
  pid: process.pid, ...value }) + '\n', { mode: 0o600 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plugin = 'frontend-design@claude-plugins-official';
const name = 'test-native-extension-config-only';
const url = 'http://127.0.0.1:9/TEST-native-extension-config-only';
const settings = join(config, 'settings.json'), installed = join(config, 'plugins', 'installed_plugins.json');
const nativeConfig = join(config, '.claude.json');
const commands = [
  ['auth', 'status', '--json'],
  ['plugin', 'install', '-s', 'user', plugin], ['plugin', 'uninstall', '-s', 'user', plugin],
  ['plugin', 'list'], ['mcp', 'add', '-s', 'user', '-t', 'http', name, url],
  ['mcp', 'remove', '-s', 'user', name], ['mcp', 'list'],
];
const args = process.argv.slice(2);
const object = value => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
};
const read = path => {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65536);
  assert.equal(realpathSync(path), path);
  return object(JSON.parse(readFileSync(path, 'utf8')));
};
const write = (path, value) => {
  assert.ok([settings, installed, nativeConfig].includes(path));
  assert.equal(realpathSync(dirname(path)), dirname(path));
  if (existsSync(path)) read(path);
  const bytes = JSON.stringify(value); assert.ok(Buffer.byteLength(bytes) <= 65536);
  writeFileSync(path, bytes, { mode: 0o600 });
  return sha(bytes);
};
try {
  assert.ok(commands.some(command => JSON.stringify(command) === JSON.stringify(args)), 'closed extension argv');
  effect({ event: 'launch', parentPid: process.ppid, command: args });
  if (args[0] === 'auth') {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'api_key',
      apiProvider: 'firstParty', configDirectory: config }) + '\n');
    effect({ event: 'auth-status', command: args, loggedIn: true, authMethod: 'api_key' });
  } else if (args[0] === 'plugin' && args[1] !== 'list') {
    const current = read(settings), metadata = read(installed);
    if (Object.keys(metadata).length) assert.equal(metadata.version, 2);
    const enabled = object(current.enabledPlugins ?? {}), plugins = object(metadata.plugins ?? {});
    const installing = args[1] === 'install';
    assert.equal(enabled[plugin] === true, !installing, 'one original plugin mutation, no replay');
    if (installing) {
      enabled[plugin] = true;
      plugins[plugin] = [{ scope: 'user', version: '1.0.0-TEST', installedAt: new Date().toISOString() }];
    } else { delete enabled[plugin]; delete plugins[plugin]; }
    const directory = dirname(installed);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    assert.equal(realpathSync(directory), directory);
    const installedSha256 = write(installed, { ...metadata, version: 2, plugins });
    const settingsSha256 = write(settings, { ...current, enabledPlugins: enabled });
    effect({ event: 'extension-command', command: args, installedSha256, settingsSha256 });
    process.stdout.write(`TEST plugin ${installing ? 'installed' : 'uninstalled'}\n`);
  } else if (args[0] === 'plugin') {
    const enabled = object(read(settings).enabledPlugins ?? {});
    process.stdout.write(enabled[plugin] === true ? `Installed plugins:\n  ${plugin} (user)\n` : 'No plugins installed\n');
    effect({ event: 'extension-read', command: args });
  } else if (args[1] === 'list') {
    const servers = object(read(nativeConfig).mcpServers ?? {});
    const selected = servers[name];
    if (selected !== undefined) assert.deepEqual(selected, { type: 'http', url });
    process.stdout.write(selected ? `${name}: ${url} - ✗ Failed to connect\n` : 'No MCP servers configured\n');
    effect({ event: 'extension-read', command: args, status: selected ? 'failed' : 'absent' });
  } else {
    const current = read(nativeConfig), servers = object(current.mcpServers ?? {});
    const installing = args[1] === 'add';
    assert.equal(Object.hasOwn(servers, name), !installing, 'one original MCP mutation, no replay');
    if (installing) servers[name] = { type: 'http', url };
    else { assert.deepEqual(servers[name], { type: 'http', url }); delete servers[name]; }
    const configSha256 = write(nativeConfig, { ...current, mcpServers: servers });
    effect({ event: 'extension-command', command: args, configSha256 });
    process.stdout.write(`TEST MCP ${installing ? 'added' : 'removed'}\n`);
  }
} catch {
  effect({ event: 'failure', code: 'closed-extension-protocol' });
  process.stderr.write('TEST extension peer refused\n'); process.exitCode = 78;
}
