import { boundLaunchDiagnostics } from '@main/services/team/progressPayload';
import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';
import { expect, it } from 'vitest';

it('redacts a bearer key inside the managed MCP JSON environment value', () => {
  const key = 'sandbox-key-0123456789abcdef0123456789abcdef';
  const dump = `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON={"Authorization":"Bearer ${key}"}`;
  expect(boundedDiagnosticString(dump)).not.toContain(key);
  const item = boundLaunchDiagnostics([
    {
      id: 'fixture:mcp',
      severity: 'warning',
      code: 'tmux_shell_only',
      observedAt: '2026-10-28T00:00:00.000Z',
      label: dump,
      detail: dump,
    },
  ])?.[0];
  expect(item?.label).not.toContain(key);
  expect(item?.detail).not.toContain(key);
});
