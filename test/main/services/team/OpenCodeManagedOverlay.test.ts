import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertManagedOverlayDoesNotShadowUserConfig,
  buildManagedOverlayConfig,
  OpenCodeBehaviorSourceScanner,
  OpenCodeManagedOverlayBuilder,
  pickAppOwnedMcpServerName,
} from '../../../../src/main/services/team/opencode/config/OpenCodeManagedOverlay';

describe('OpenCodeManagedOverlay', () => {
  let tempDir: string;
  let homePath: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-managed-overlay-'));
    homePath = path.join(tempDir, 'home');
    projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('builds a minimal inline MCP overlay without user behavior keys or pure mode', async () => {
    await writeJson(path.join(projectPath, 'opencode.json'), {
      plugin: ['user-plugin'],
      mcp: { user_server: { type: 'local', command: 'custom', enabled: true } },
    });
    const builder = new OpenCodeManagedOverlayBuilder(
      new OpenCodeBehaviorSourceScanner({ homePath }),
      () => new Date('2026-04-21T12:00:00.000Z')
    );

    const overlay = await builder.build({
      projectPath,
      preferredMcpName: 'agent-teams',
      appMcpCommand: 'node',
      appMcpArgs: ['server.js'],
      appMcpEnv: { TEAM_RUNTIME: '1' },
    });
    const config = JSON.parse(overlay.env.OPENCODE_CONFIG_CONTENT);

    expect(config).toEqual({
      mcp: {
        'agent-teams': {
          type: 'local',
          command: 'node',
          args: ['server.js'],
          enabled: true,
          environment: { TEAM_RUNTIME: '1' },
          timeout: 10_000,
        },
      },
    });
    expect(overlay.env).not.toHaveProperty('OPENCODE_PURE');
    expect(overlay.env).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG');
    expect(overlay.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(config).not.toHaveProperty('plugin');
    expect(config).not.toHaveProperty('model');
    expect(overlay.diagnostics).toContain(
      'OpenCode managed overlay checked at 2026-04-21T12:00:00.000Z'
    );
  });

  it('allows app-managed OpenCode auto-update only behind an explicit override', async () => {
    const builder = new OpenCodeManagedOverlayBuilder(
      new OpenCodeBehaviorSourceScanner({ homePath })
    );

    const overlay = await builder.build({
      projectPath,
      preferredMcpName: 'agent-teams',
      appMcpCommand: 'node',
      appMcpArgs: ['server.js'],
      appMcpEnv: {},
      env: {
        CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    });

    expect(overlay.env.OPENCODE_CONFIG_CONTENT).toBeTruthy();
    expect(overlay.env.OPENCODE_DISABLE_AUTOUPDATE).toBeUndefined();
  });

  it('renames the app-owned MCP server when user config already declares the preferred name', async () => {
    await writeJson(path.join(projectPath, 'opencode.json'), {
      mcp: {
        'agent-teams': { type: 'local', command: 'custom', enabled: true },
        'agent-teams-runtime-1': { type: 'local', command: 'custom-2', enabled: true },
      },
    });
    const builder = new OpenCodeManagedOverlayBuilder(
      new OpenCodeBehaviorSourceScanner({ homePath })
    );

    const overlay = await builder.build({
      projectPath,
      preferredMcpName: 'agent-teams',
      appMcpCommand: 'node',
      appMcpArgs: ['server.js'],
      appMcpEnv: {},
    });

    expect(overlay.appMcpServerName).toBe('agent-teams-runtime-2');
    expect(overlay.diagnostics.join('\n')).toContain('already declares MCP server "agent-teams"');
  });

  it('reads JSONC project config and fingerprints plugin behavior sources', async () => {
    await fs.mkdir(path.join(projectPath, '.opencode/plugins'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'opencode.jsonc'),
      `{
        // user-owned MCP must be observed, not overwritten
        "mcp": {
          "agent-teams": { "type": "local", "command": "custom", "enabled": true }
        }
      }`,
      'utf8'
    );
    await fs.writeFile(
      path.join(projectPath, '.opencode/plugins/example.ts'),
      'export default {}',
      'utf8'
    );
    const scanner = new OpenCodeBehaviorSourceScanner({ homePath });

    await expect(scanner.readDeclaredMcpNames(projectPath)).resolves.toEqual(
      new Set(['agent-teams'])
    );
    const sources = await scanner.scan(projectPath);

    expect(sources).toContainEqual(
      expect.objectContaining({
        kind: 'project_plugin_dir',
        exists: true,
        fileCount: 1,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(sources).toContainEqual(
      expect.objectContaining({
        kind: 'project_opencode_dir',
        exists: true,
        fileCount: 1,
      })
    );
  });

  it('rejects managed overlays that would shadow user behavior keys', () => {
    expect(() =>
      assertManagedOverlayDoesNotShadowUserConfig({
        ...buildManagedOverlayConfig({
          serverName: 'agent-teams',
          command: 'node',
          args: [],
          environment: {},
          timeout: 10_000,
        }),
        plugin: ['managed-plugin'],
        model: 'managed-model',
      })
    ).toThrow('Managed OpenCode overlay must not set user behavior keys: plugin, model');
  });

  it('picks deterministic collision-safe app MCP names', () => {
    expect(pickAppOwnedMcpServerName('agent-teams', new Set())).toBe('agent-teams');
    expect(pickAppOwnedMcpServerName('agent-teams', new Set(['agent-teams']))).toBe(
      'agent-teams-runtime-1'
    );
    expect(
      pickAppOwnedMcpServerName(
        'agent-teams',
        new Set(['agent-teams', 'agent-teams-runtime-1', 'agent-teams-runtime-2'])
      )
    ).toBe('agent-teams-runtime-3');
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
