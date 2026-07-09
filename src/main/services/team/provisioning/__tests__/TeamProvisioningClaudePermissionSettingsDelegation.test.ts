import { describe, expect, it, vi } from 'vitest';

import { type ClaudePermissionSettingsFilePorts } from '../TeamProvisioningClaudePermissionSettings';
import { createTeamProvisioningClaudePermissionSettingsDelegation } from '../TeamProvisioningClaudePermissionSettingsDelegation';

function createPorts(raw: string = '{}'): ClaudePermissionSettingsFilePorts {
  return {
    mkdirRecursive: vi.fn().mockResolvedValue(undefined),
    readFileUtf8: vi.fn().mockResolvedValue(raw),
    writeFileUtf8: vi.fn().mockResolvedValue(undefined),
  };
}

function lastWrite(ports: ClaudePermissionSettingsFilePorts): [string, string] {
  const writeFileUtf8 = vi.mocked(ports.writeFileUtf8);
  expect(writeFileUtf8).toHaveBeenCalledTimes(1);
  return writeFileUtf8.mock.calls[0];
}

describe('TeamProvisioningClaudePermissionSettingsDelegation', () => {
  it('delegates teammate permission setting writes through injected file ports', async () => {
    const ports = createPorts();
    const delegation = createTeamProvisioningClaudePermissionSettingsDelegation({
      bootstrapToolNames: ['mcp__agent-teams__team_launch'],
      filePorts: ports,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const added = await delegation.addPermissionRulesToSettings(
      '/repo/.claude/settings.local.json',
      ['Bash'],
      'allow'
    );

    expect(added).toBe(1);
    expect(ports.mkdirRecursive).toHaveBeenCalledWith('/repo/.claude');
    expect(JSON.parse(lastWrite(ports)[1])).toEqual({
      permissions: { allow: ['Bash'] },
    });
  });

  it('delegates lead bootstrap seeding with configured bootstrap tools and logger', async () => {
    const ports = createPorts(JSON.stringify({ permissions: { allow: ['Edit'] } }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const delegation = createTeamProvisioningClaudePermissionSettingsDelegation({
      bootstrapToolNames: ['mcp__agent-teams__team_launch'],
      filePorts: ports,
      logger,
    });

    await delegation.seedLeadBootstrapPermissionRules('alpha', '/repo');

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
});
