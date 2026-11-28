import { expect, it } from 'vitest';
import { qualifyNativeMcpDiagnostics } from '../../../packages/legacy-agent-host/src/extensions/qualifyNativeMcpDiagnostics';
it('projects only captured configured servers and finite statuses, never raw native credentials or arguments', () => {
  const output =
    'TEST: https://user:TEST-secret@TEST.invalid/mcp?token=TEST-secret - ✓ Connected\nforeign: TEST-private - ✓ Connected\nplugin:injected: TEST-private - ✓ Connected\n';
  const rows = qualifyNativeMcpDiagnostics(output, [
    { name: 'TEST', scope: 'user', targetKey: 'http:https://test.invalid/mcp?token' },
    { name: 'TEST', scope: 'local', targetKey: 'npm:TEST-local' },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: 'TEST',
    scope: 'local',
    target: 'npm:TEST-local',
    status: 'connected',
    statusLabel: 'Connected',
  });
  expect(JSON.stringify(rows)).not.toContain('TEST-secret');
  expect(JSON.stringify(rows)).not.toContain('TEST-private');
});
