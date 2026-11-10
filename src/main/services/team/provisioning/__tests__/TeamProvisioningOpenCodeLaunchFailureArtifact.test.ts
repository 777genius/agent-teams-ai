import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeLaunchFailureArtifactAdapter } from '../TeamProvisioningOpenCodeLaunchFailureArtifact';

import type { OpenCodeLaunchFailureArtifactInput } from '../TeamProvisioningOpenCodeLaunchFailureArtifact';

function artifactInput(): OpenCodeLaunchFailureArtifactInput {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    reason: 'opencode_runtime_adapter_error',
  };
}

describe('TeamProvisioningOpenCodeLaunchFailureArtifact', () => {
  it('delegates once to the canonical writer with retained runtime trace enrichment', async () => {
    const write = vi.fn(async () => undefined);
    const port = createOpenCodeLaunchFailureArtifactAdapter({
      writer: { write },
      getRuntimeAdapterTraceLines: (runId) => {
        expect(runId).toBe('run-1');
        return ['validating', 'failed'];
      },
      warn: vi.fn(),
    });

    await port.write(artifactInput());

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        runId: 'run-1',
        runtimeAdapterTraceLines: ['validating', 'failed'],
      })
    );
  });

  it('awaits, logs, and swallows an asynchronous canonical writer rejection', async () => {
    let rejectWriter!: (error: Error) => void;
    const writerPromise = new Promise<void>((_resolve, reject) => {
      rejectWriter = reject;
    });
    const warn = vi.fn();
    const port = createOpenCodeLaunchFailureArtifactAdapter({
      writer: { write: () => writerPromise },
      getRuntimeAdapterTraceLines: () => undefined,
      warn,
    });

    const write = port.write(artifactInput());
    let settled = false;
    void write.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    rejectWriter(new Error('disk full'));
    await expect(write).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
