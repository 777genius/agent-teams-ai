import { describe, expect, it, vi } from 'vitest';

import {
  clearMemberSpawnToolTracking,
  resetRuntimeToolActivity,
} from '../TeamProvisioningRuntimeToolActivity';

import type { ActiveToolCall, ToolActivityEventPayload } from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function active(memberName: string, toolUseId: string): ActiveToolCall {
  return {
    memberName,
    toolUseId,
    toolName: 'Agent',
    startedAt: ISO,
    state: 'running',
    source: 'runtime',
  };
}

describe('runtime tool activity helpers', () => {
  it('clears all active tool calls and emits a reset event', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([
        ['tool-api', active('api', 'tool-api')],
        ['tool-web', active('web', 'tool-web')],
      ]),
    };

    resetRuntimeToolActivity(run, undefined, { emitToolActivity });

    expect(run.activeToolCalls.size).toBe(0);
    expect(emitToolActivity).toHaveBeenCalledWith({ action: 'reset' });
  });

  it('clears only the requested member active tool calls', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([
        ['tool-api-1', active('api', 'tool-api-1')],
        ['tool-api-2', active('api', 'tool-api-2')],
        ['tool-web', active('web', 'tool-web')],
      ]),
    };

    resetRuntimeToolActivity(run, 'api', { emitToolActivity });

    expect([...run.activeToolCalls.keys()]).toEqual(['tool-web']);
    expect(emitToolActivity).toHaveBeenCalledWith({ action: 'reset', memberName: 'api' });
  });

  it('does not emit when no matching member tool calls are removed', () => {
    const emitToolActivity = vi.fn<(payload: ToolActivityEventPayload) => void>();
    const run = {
      activeToolCalls: new Map([['tool-web', active('web', 'tool-web')]]),
    };

    resetRuntimeToolActivity(run, 'api', { emitToolActivity });

    expect([...run.activeToolCalls.keys()]).toEqual(['tool-web']);
    expect(emitToolActivity).not.toHaveBeenCalled();
  });

  it('clears member spawn tool tracking and emits a diagnostic only when entries are removed', () => {
    const appendMemberBootstrapDiagnostic = vi.fn<(memberName: string, text: string) => void>();
    const run = {
      memberSpawnToolUseIds: new Map([
        ['tool-api-1', 'api'],
        ['tool-api-2', 'api'],
        ['tool-web', 'web'],
      ]),
    };

    clearMemberSpawnToolTracking(run, 'api', { appendMemberBootstrapDiagnostic });

    expect([...run.memberSpawnToolUseIds.entries()]).toEqual([['tool-web', 'web']]);
    expect(appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      'api',
      'cleared stale spawn tool tracking before manual restart'
    );

    appendMemberBootstrapDiagnostic.mockClear();
    clearMemberSpawnToolTracking(run, 'api', { appendMemberBootstrapDiagnostic });
    expect(appendMemberBootstrapDiagnostic).not.toHaveBeenCalled();
  });
});
