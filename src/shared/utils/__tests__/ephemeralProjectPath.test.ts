import { describe, expect, it } from 'vitest';

import { isEphemeralProjectPath } from '../ephemeralProjectPath';

function absolutePath(...segments: string[]): string {
  return `/${segments.join('/')}`;
}

describe('isEphemeralProjectPath', () => {
  it('detects generated MCP project paths', () => {
    expect(isEphemeralProjectPath(absolutePath('tmp', 'rendered_mcp_config', 'project'))).toBe(
      true
    );
    expect(isEphemeralProjectPath('/Users/test/rendered_mcp_123/project')).toBe(true);
    expect(isEphemeralProjectPath(absolutePath('tmp', 'portable-mcp-live', 'project'))).toBe(true);
  });

  it('detects Codex appstyle temp workspaces only under temp roots', () => {
    expect(
      isEphemeralProjectPath(
        '/private/var/folders/7b/ydmc_b0n251bc4hss4tz8y880000gn/T/codex-agent-teams-appstyle-zudek6i9'
      )
    ).toBe(true);
    expect(isEphemeralProjectPath(absolutePath('tmp', 'codex-agent-teams-appstyle-zudek6i9'))).toBe(
      true
    );
    expect(
      isEphemeralProjectPath(
        'C:\\Users\\test\\AppData\\Local\\Temp\\codex-agent-teams-appstyle-zudek6i9'
      )
    ).toBe(true);
    expect(isEphemeralProjectPath('/Users/test/projects/codex-agent-teams-appstyle-real')).toBe(
      false
    );
  });

  it('keeps normal project paths selectable', () => {
    expect(isEphemeralProjectPath('/Users/test/projects/claude_team')).toBe(false);
    expect(isEphemeralProjectPath('')).toBe(false);
    expect(isEphemeralProjectPath(null)).toBe(false);
  });
});
