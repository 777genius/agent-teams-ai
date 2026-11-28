import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  readNativeMcp,
  readNativePlugins,
} from '../../../packages/legacy-agent-host/src/extensions/readNativeExtensionState';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-extension-state-')));
  roots.push(root);
  const home = join(root, 'home'),
    config = join(root, 'custom-claude'),
    project = join(root, 'project');
  for (const path of [home, config, project]) mkdirSync(path);
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-captured',
    configRevision: 'TEST-revision',
    accountBinding: 'TEST-account',
    sdkRevision: '0.3.305',
    configNamespace: 'custom-directory',
    environment: { HOME: home, PATH: '/TEST/no-native', CLAUDE_CONFIG_DIR: config },
    cwd: project,
    executable: { path: '/TEST/never-executed', sha256: 'a'.repeat(64) },
    timeoutMs: 1000,
  };
  const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  return { root, home, config, project, profile, json };
}
it('reads exact custom native MCP config, includes project/local only for selected project, and returns no secrets', () => {
  const f = fixture();
  f.json(join(f.home, '.claude.json'), { mcpServers: { wrongAmbient: { command: 'TEST-wrong' } } });
  f.json(join(f.config, '.claude.json'), {
    mcpServers: {
      user: {
        url: 'https://TEST-user:TEST-secret@TEST.invalid/mcp?token=TEST-secret',
        headers: { Authorization: 'TEST-secret' },
      },
    },
    projects: {
      [f.project]: {
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'TEST-server@1'], env: { SECRET: 'TEST-secret' } },
        },
      },
    },
  });
  f.json(join(f.project, '.mcp.json'), {
    mcpServers: { project: { command: 'TEST-custom-command', args: ['TEST-secret'] } },
  });
  expect(readNativeMcp(f.profile, false, () => {})).toEqual([
    {
      name: 'user',
      scope: 'user',
      transport: 'http',
      targetKey: 'http:https://test.invalid/mcp?token',
    },
  ]);
  const full = readNativeMcp(f.profile, true, () => {});
  expect(full.map((row) => [row.name, row.scope])).toEqual([
    ['user', 'user'],
    ['local', 'local'],
    ['project', 'project'],
  ]);
  expect(full[1]?.targetKey).toBe('npm:TEST-server@1');
  expect(JSON.stringify(full)).not.toContain('TEST-secret');
  expect(JSON.stringify(full)).not.toContain('wrongAmbient');
});
it('preserves native enabled plugin scope and newest matching metadata, not every cached installation', () => {
  const f = fixture();
  mkdirSync(join(f.config, 'plugins'));
  mkdirSync(join(f.project, '.claude'));
  f.json(join(f.config, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'test@market': [
        { scope: 'user', version: 'old', installedAt: '2025-01-01' },
        { scope: 'user', version: 'new', installedAt: '2026-01-01' },
        { scope: 'project', version: 'project' },
      ],
      'disabled@market': [{ scope: 'user' }],
    },
  });
  f.json(join(f.config, 'settings.json'), {
    enabledPlugins: { 'test@market': true, 'disabled@market': false },
  });
  f.json(join(f.project, '.claude', 'settings.json'), { enabledPlugins: { 'test@market': true } });
  f.json(join(f.project, '.claude', 'settings.local.json'), {
    enabledPlugins: { 'local@market': true },
  });
  f.json(join(f.config, 'plugins', 'install-counts-cache.json'), {
    counts: [{ plugin: 'test@market', unique_installs: 22 }],
  });
  expect(readNativePlugins(f.profile, false, () => {})).toEqual({
    entries: [
      { pluginId: 'test@market', scope: 'user', version: 'new', installedAt: '2026-01-01' },
    ],
    installCounts: [['test@market', 22]],
  });
  expect(readNativePlugins(f.profile, true, () => {}).entries).toEqual([
    { pluginId: 'test@market', scope: 'user', version: 'new', installedAt: '2026-01-01' },
    { pluginId: 'test@market', scope: 'project', version: 'project' },
    { pluginId: 'local@market', scope: 'local' },
  ]);
});
it('treats optional absent native inventory as empty but unreadable or malformed existing state as held', () => {
  const f = fixture();
  expect(readNativePlugins(f.profile, false, () => {})).toEqual({ entries: [], installCounts: [] });
  expect(readNativeMcp(f.profile, true, () => {})).toEqual([]);
  writeFileSync(join(f.config, 'settings.json'), '{TEST-malformed');
  expect(() => readNativePlugins(f.profile, false, () => {})).toThrow();
  writeFileSync(join(f.config, '.claude.json'), '{TEST-malformed');
  expect(() => readNativeMcp(f.profile, false, () => {})).toThrow();
});
it('refuses symlinked native files and project config rather than reading same-path substitutes', () => {
  const f = fixture();
  const outside = join(f.root, 'outside.json');
  f.json(outside, { mcpServers: { TEST: { command: 'TEST' } } });
  symlinkSync(outside, join(f.project, '.mcp.json'));
  expect(() => readNativeMcp(f.profile, true, () => {})).toThrow();
  symlinkSync(outside, join(f.config, '.claude.json'));
  expect(() => readNativeMcp(f.profile, false, () => {})).toThrow();
});
it('rechecks the original owner and root identity throughout a read', () => {
  const f = fixture();
  let checks = 0;
  expect(() =>
    readNativePlugins(f.profile, false, () => {
      if (++checks > 2) throw new Error('TEST revoked');
    })
  ).toThrow('TEST revoked');
  expect(checks).toBeGreaterThan(2);
});
