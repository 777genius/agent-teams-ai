import { describe, expect, it, vi } from 'vitest';

import {
  type AppendDirectProcessRuntimeEventUseCasePorts,
  createAppendDirectProcessRuntimeEventUseCase,
} from '../TeamProvisioningAppendDirectProcessRuntimeEventUseCase';

describe('createAppendDirectProcessRuntimeEventUseCase', () => {
  it('appends a normalized direct process runtime event through narrow file ports', async () => {
    const mkdirRecursive = vi.fn(async () => undefined);
    const appendFileUtf8 = vi.fn<AppendDirectProcessRuntimeEventUseCasePorts['appendFileUtf8']>(
      async () => undefined
    );
    const appendDirectProcessRuntimeEvent = createAppendDirectProcessRuntimeEventUseCase({
      mkdirRecursive,
      appendFileUtf8,
      nowIso: () => '2026-01-01T00:00:00.000Z',
    });

    await appendDirectProcessRuntimeEvent({
      type: 'process_spawned',
      eventsPath: 'team-a/runtime/events.jsonl',
      pid: 123,
      teamName: 'team-a',
      agentName: 'Worker',
      agentId: 'worker@team-a',
      runId: 'lead-session',
      bootstrapRunId: 'bootstrap-run',
      source: 'TeamProvisioningService.direct_process_attach',
      detail: 'started',
    });

    expect(mkdirRecursive).toHaveBeenCalledWith('team-a/runtime');
    expect(appendFileUtf8).toHaveBeenCalledWith(
      'team-a/runtime/events.jsonl',
      `${JSON.stringify({
        version: 1,
        type: 'process_spawned',
        timestamp: '2026-01-01T00:00:00.000Z',
        pid: 123,
        teamName: 'team-a',
        agentName: 'Worker',
        agentId: 'worker@team-a',
        runId: 'lead-session',
        bootstrapRunId: 'bootstrap-run',
        source: 'TeamProvisioningService.direct_process_attach',
        detail: 'started',
      })}\n`,
      { mode: 0o600 }
    );
  });

  it('omits empty event detail to preserve the legacy event shape', async () => {
    const appendFileUtf8 = vi.fn<AppendDirectProcessRuntimeEventUseCasePorts['appendFileUtf8']>(
      async () => undefined
    );
    const appendDirectProcessRuntimeEvent = createAppendDirectProcessRuntimeEventUseCase({
      mkdirRecursive: vi.fn(async () => undefined),
      appendFileUtf8,
      nowIso: () => '2026-01-01T00:00:00.000Z',
    });

    await appendDirectProcessRuntimeEvent({
      type: 'process_failed',
      eventsPath: 'team-a/runtime/events.jsonl',
      pid: 123,
      teamName: 'team-a',
      agentName: 'Worker',
      agentId: 'worker@team-a',
      runId: 'lead-session',
      bootstrapRunId: 'bootstrap-run',
      source: 'test',
      detail: '',
    });

    const appendedLine = appendFileUtf8.mock.calls[0]?.[1];
    expect(JSON.parse(String(appendedLine))).not.toHaveProperty('detail');
  });
});
