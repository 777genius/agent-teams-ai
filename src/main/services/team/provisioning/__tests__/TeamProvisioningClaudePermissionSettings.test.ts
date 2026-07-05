import { describe, expect, it, vi } from 'vitest';

import {
  addPermissionRulesToSettings,
  type ClaudePermissionSettingsFilePorts,
  seedLeadBootstrapPermissionRules,
} from '../TeamProvisioningClaudePermissionSettings';

interface FakePortsOptions {
  raw?: string;
  readError?: Error;
  writeError?: Error;
}

function createPorts(options: FakePortsOptions = {}): ClaudePermissionSettingsFilePorts {
  return {
    mkdirRecursive: vi.fn().mockResolvedValue(undefined),
    readFileUtf8: vi.fn(async () => {
      if ('raw' in options) return options.raw ?? '';
      throw options.readError ?? new Error('missing');
    }),
    writeFileUtf8: vi.fn(async () => {
      if (options.writeError) throw options.writeError;
    }),
  };
}

function lastWrite(ports: ClaudePermissionSettingsFilePorts): [string, string] {
  const writeFileUtf8 = vi.mocked(ports.writeFileUtf8);
  expect(writeFileUtf8).toHaveBeenCalledTimes(1);
  return writeFileUtf8.mock.calls[0];
}

describe('Claude permission settings helpers', () => {
  it('creates parent directories and writes fresh allow settings when the file is missing', async () => {
    const ports = createPorts();

    const added = await addPermissionRulesToSettings(
      {
        settingsPath: '/repo/.claude/settings.local.json',
        toolNames: ['Edit'],
        behavior: 'allow',
      },
      ports
    );

    expect(added).toBe(1);
    expect(ports.mkdirRecursive).toHaveBeenCalledWith('/repo/.claude');
    expect(lastWrite(ports)).toEqual([
      '/repo/.claude/settings.local.json',
      '{\n  "permissions": {\n    "allow": [\n      "Edit"\n    ]\n  }\n}\n',
    ]);
  });

  it('merges with existing tool names and returns only the added count', async () => {
    const ports = createPorts({
      raw: JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Read'], deny: ['Bash'] },
      }),
    });

    const added = await addPermissionRulesToSettings(
      {
        settingsPath: '/repo/.claude/settings.local.json',
        toolNames: ['Read', 'Write', 'NotebookEdit'],
        behavior: 'allow',
      },
      ports
    );

    expect(added).toBe(2);
    expect(JSON.parse(lastWrite(ports)[1])).toEqual({
      theme: 'dark',
      permissions: {
        allow: ['Read', 'Write', 'NotebookEdit'],
        deny: ['Bash'],
      },
    });
  });

  it('writes deny only for deny behavior and otherwise writes allow', async () => {
    const denyPorts = createPorts({ raw: '{}' });
    const allowPorts = createPorts({ raw: '{}' });

    await addPermissionRulesToSettings(
      {
        settingsPath: '/repo/.claude/settings.local.json',
        toolNames: ['Bash'],
        behavior: 'deny',
      },
      denyPorts
    );
    await addPermissionRulesToSettings(
      {
        settingsPath: '/repo/.claude/settings.local.json',
        toolNames: ['Glob'],
        behavior: 'prompt',
      },
      allowPorts
    );

    expect(JSON.parse(lastWrite(denyPorts)[1])).toEqual({
      permissions: { deny: ['Bash'] },
    });
    expect(JSON.parse(lastWrite(allowPorts)[1])).toEqual({
      permissions: { allow: ['Glob'] },
    });
  });

  it('recovers from invalid and non-object JSON by starting fresh', async () => {
    for (const raw of ['not json', '[]']) {
      const ports = createPorts({ raw });

      const added = await addPermissionRulesToSettings(
        {
          settingsPath: '/repo/.claude/settings.local.json',
          toolNames: ['Grep'],
          behavior: 'allow',
        },
        ports
      );

      expect(added).toBe(1);
      expect(JSON.parse(lastWrite(ports)[1])).toEqual({
        permissions: { allow: ['Grep'] },
      });
    }
  });

  it('does not write when no new tool names are added', async () => {
    const ports = createPorts({
      raw: JSON.stringify({ permissions: { allow: ['Edit'] } }),
    });

    const added = await addPermissionRulesToSettings(
      {
        settingsPath: '/repo/.claude/settings.local.json',
        toolNames: ['Edit'],
        behavior: 'allow',
      },
      ports
    );

    expect(added).toBe(0);
    expect(ports.writeFileUtf8).not.toHaveBeenCalled();
  });

  it('seeds lead bootstrap tools and logs the unchanged success message', async () => {
    const ports = createPorts({ raw: JSON.stringify({ permissions: { allow: ['Edit'] } }) });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await seedLeadBootstrapPermissionRules(
      {
        teamName: 'alpha',
        projectCwd: '/repo',
        bootstrapToolNames: ['mcp__agent-teams__team_launch'],
      },
      { ...ports, logger }
    );

    expect(JSON.parse(lastWrite(ports)[1])).toEqual({
      permissions: {
        allow: ['Edit', 'mcp__agent-teams__team_launch', 'Write', 'NotebookEdit'],
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[alpha] Seeded lead bootstrap MCP rules in /repo/.claude/settings.local.json (3 added)'
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs the unchanged seed warning message when persistence fails', async () => {
    const ports = createPorts({ raw: '{}', writeError: new Error('boom') });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(
      seedLeadBootstrapPermissionRules(
        {
          teamName: 'alpha',
          projectCwd: '/repo',
          bootstrapToolNames: ['mcp__agent-teams__team_launch'],
        },
        { ...ports, logger }
      )
    ).resolves.toBeUndefined();

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[alpha] Failed to seed lead bootstrap MCP rules: boom'
    );
  });
});
