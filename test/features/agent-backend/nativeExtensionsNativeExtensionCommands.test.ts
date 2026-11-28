import { expect, it } from 'vitest';

import { compileNativeExtensionCommand } from '../../../packages/legacy-agent-host/src/extensions/nativeCommands';

it('preserves original plugin fields through the finite official native command', () => {
  expect(
    compileNativeExtensionCommand({
      action: 'plugin.install',
      qualifiedName: 'TEST-plugin@TEST-market',
      scope: 'project',
    })
  ).toEqual({
    panel: 'plugins',
    requestedScope: 'project',
    nativeScope: 'project',
    args: ['plugin', 'install', '-s', 'project', 'TEST-plugin@TEST-market'],
    timeoutMs: 120000,
  });
  expect(
    compileNativeExtensionCommand({
      action: 'plugin.uninstall',
      qualifiedName: 'TEST-plugin@TEST-market',
      scope: 'local',
    }).args
  ).toEqual(['plugin', 'uninstall', '-s', 'local', 'TEST-plugin@TEST-market']);
});
it('maps only MCP global to the same native user target while retaining original explicit selection', () => {
  const command = compileNativeExtensionCommand({
    action: 'mcp.install',
    serverName: 'TEST-server',
    scope: 'global',
    installSpec: { type: 'stdio', npmPackage: '@TEST/server', npmVersion: '1.2.3' },
    envValues: { TEST_TOKEN: 'TEST-private-value' },
    headers: [],
  });
  expect(command).toMatchObject({ requestedScope: 'global', nativeScope: 'user', panel: 'mcp' });
  expect(command.args).toEqual([
    'mcp',
    'add',
    '-s',
    'user',
    '-e',
    'TEST_TOKEN=TEST-private-value',
    'TEST-server',
    '--',
    'npx',
    '-y',
    '@TEST/server@1.2.3',
  ]);
  expect(
    compileNativeExtensionCommand({
      action: 'mcp.uninstall',
      serverName: 'TEST-server',
      scope: 'global',
    }).args
  ).toEqual(['mcp', 'remove', '-s', 'user', 'TEST-server']);
});
it.each(['http', 'streamable-http', 'sse'] as const)(
  'preserves original %s headers, environment and selected local scope',
  (transportType) => {
    const result = compileNativeExtensionCommand({
      action: 'mcp.install',
      serverName: 'TEST-http',
      scope: 'local',
      installSpec: { type: 'http', transportType, url: 'https://TEST.invalid/mcp' },
      envValues: { TEST_VALUE: 'TEST-a b' },
      headers: [{ key: 'Authorization', value: 'Bearer TEST-secret' }],
    });
    expect(result.args).toEqual([
      'mcp',
      'add',
      '-s',
      'local',
      '-e',
      'TEST_VALUE=TEST-a b',
      '-t',
      transportType === 'sse' ? 'sse' : 'http',
      '-H',
      'Authorization: Bearer TEST-secret',
      'TEST-http',
      'https://TEST.invalid/mcp',
    ]);
  }
);
it('refuses alternate commands, extra selectors and unsupported plugin global scope before allocation', () => {
  for (const input of [
    { action: 'exec', args: ['anything'] },
    { action: 'plugin.install', qualifiedName: '../TEST@market', scope: 'user' },
    { action: 'plugin.install', qualifiedName: 'TEST@market', scope: 'global' },
    { action: 'mcp.uninstall', serverName: 'TEST', scope: 'user', executable: '/TEST/foreign' },
  ])
    expect(() => compileNativeExtensionCommand(input)).toThrow();
});
