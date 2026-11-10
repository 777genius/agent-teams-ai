import { describe, expect, it } from 'vitest';

import { projectRuntimeLiveness } from '../runtime-projection';
import { resolveTeamMemberRuntimeLiveness } from '../TeamRuntimeLivenessResolver';

function commonLivenessFields(value: {
  alive: boolean;
  livenessKind: string;
  pidSource?: string;
  pid?: number;
  processCommand?: string;
  runtimeDiagnosticSeverity: string;
}) {
  return {
    alive: value.alive,
    livenessKind: value.livenessKind,
    pidSource: value.pidSource,
    pid: value.pid,
    processCommand: value.processCommand,
    runtimeDiagnosticSeverity: value.runtimeDiagnosticSeverity,
  };
}

describe('TeamRuntimeLivenessResolver', () => {
  it('keeps stale persisted pid liveness aligned with runtime projection', () => {
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo-team',
      memberName: 'worker',
      agentId: 'worker@demo-team',
      providerId: 'codex',
      backendType: 'process',
      persistedRuntimePid: 37749,
      processRows: [],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });
    const projected = projectRuntimeLiveness({
      process: {
        pid: 37749,
        running: false,
        pidSource: 'persisted_metadata',
        processTableAvailable: true,
      },
      registration: {
        runtimePid: 37749,
      },
    });

    expect(commonLivenessFields(resolved)).toEqual(commonLivenessFields(projected));
    expect(resolved.runtimeDiagnostic).toBe('persisted runtime pid is not alive');
    expect(resolved.diagnostics).toEqual(['persisted runtime pid was not found in process table']);
  });

  it('keeps verified process fields aligned while preserving resolver diagnostics', () => {
    const command =
      'node runtime.js --token fixture-token --team-name demo-team --agent-id worker@demo-team';
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo-team',
      memberName: 'worker',
      agentId: 'worker@demo-team',
      providerId: 'codex',
      backendType: 'process',
      runtimeSessionId: 'session-1',
      processRows: [{ pid: 5151, ppid: 1, command }],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });
    const projected = projectRuntimeLiveness({
      process: {
        pid: 5151,
        command,
        running: true,
        identityVerified: true,
        pidSource: 'agent_process_table',
      },
      heartbeat: {
        runtimeSessionId: 'session-1',
      },
    });

    expect(commonLivenessFields(resolved)).toEqual(commonLivenessFields(projected));
    expect(resolved.runtimeDiagnostic).toBe('verified runtime process detected');
    expect(resolved.diagnostics).toEqual(['matched process table by team-name and agent-id']);
  });
});
