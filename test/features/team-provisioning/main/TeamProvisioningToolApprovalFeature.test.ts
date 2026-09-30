import { LegacyToolApprovalAdapter } from '@features/team-provisioning/main/adapters/output/LegacyToolApprovalAdapter';
import { createTeamProvisioningToolApprovalFeature } from '@features/team-provisioning/main/composition/createTeamProvisioningToolApprovalFeature';
import { describe, expect, it, vi } from 'vitest';

import type { LegacyToolApprovalSource } from '@features/team-provisioning/main/adapters/output/LegacyToolApprovalAdapter';
import type { ToolApprovalSettings } from '@shared/types';

const settings: ToolApprovalSettings = {
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: true,
  timeoutAction: 'wait',
  timeoutSeconds: 30,
};

describe('LegacyToolApprovalAdapter', () => {
  it('translates response commands to the exact legacy call and preserves its receiver', async () => {
    const source = createSource();
    const adapter = new LegacyToolApprovalAdapter(source);

    await adapter.respondToToolApproval({
      teamName: '  alpha  ',
      runId: ' run-1 ',
      requestId: ' request-1 ',
      allow: false,
      message: '',
    });

    expect(source.responses).toEqual([
      {
        teamName: '  alpha  ',
        runId: ' run-1 ',
        requestId: ' request-1 ',
        allow: false,
        message: '',
      },
    ]);
  });

  it('passes an omitted response message to the legacy method as undefined', async () => {
    const respondToToolApproval = vi.fn(() => Promise.resolve());
    const source: LegacyToolApprovalSource = {
      respondToToolApproval,
      updateToolApprovalSettings: vi.fn(),
    };
    const adapter = new LegacyToolApprovalAdapter(source);

    await adapter.respondToToolApproval({
      teamName: 'alpha',
      runId: 'run-1',
      requestId: 'request-1',
      allow: true,
    });

    expect(respondToToolApproval).toHaveBeenCalledWith(
      'alpha',
      'run-1',
      'request-1',
      true,
      undefined
    );
  });

  it('passes the exact settings object to the legacy source and preserves its receiver', () => {
    const source = createSource();
    const adapter = new LegacyToolApprovalAdapter(source);

    adapter.updateToolApprovalSettings({ teamName: ' alpha ', settings });

    expect(source.settingsUpdates).toEqual([{ teamName: ' alpha ', settings }]);
    expect(source.settingsUpdates[0]?.settings).toBe(settings);
  });
});

describe('createTeamProvisioningToolApprovalFeature', () => {
  it('preserves the legacy positional API and return behavior', async () => {
    const response = Promise.resolve();
    const respondToToolApproval = vi.fn(() => response);
    const updateToolApprovalSettings = vi.fn();
    const feature = createTeamProvisioningToolApprovalFeature({
      toolApprovalSource: { respondToToolApproval, updateToolApprovalSettings },
    });

    const result = feature.respondToToolApproval('alpha', 'run-1', 'request-1', true, 'approved');

    expect(result).toBe(response);
    await expect(result).resolves.toBeUndefined();
    expect(respondToToolApproval).toHaveBeenCalledWith(
      'alpha',
      'run-1',
      'request-1',
      true,
      'approved'
    );
    expect(feature.updateToolApprovalSettings('alpha', settings)).toBeUndefined();
    expect(updateToolApprovalSettings).toHaveBeenCalledWith('alpha', settings);
  });

  it('does not add retries, deduplication, cancellation, or error translation', async () => {
    const failure = new Error('response failed');
    const first = pendingPromise();
    const respondToToolApproval = vi
      .fn<LegacyToolApprovalSource['respondToToolApproval']>()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(failure);
    const settingsFailure = new Error('settings failed');
    const updateToolApprovalSettings = vi.fn(() => {
      throw settingsFailure;
    });
    const feature = createTeamProvisioningToolApprovalFeature({
      toolApprovalSource: { respondToToolApproval, updateToolApprovalSettings },
    });

    const inFlight = feature.respondToToolApproval('alpha', 'run-1', 'request-1', true);
    const duplicate = feature.respondToToolApproval('alpha', 'run-1', 'request-1', false);

    expect(inFlight).toBe(first.promise);
    await expect(duplicate).rejects.toBe(failure);
    expect(respondToToolApproval).toHaveBeenCalledTimes(2);
    expect(() => feature.updateToolApprovalSettings('alpha', settings)).toThrow(settingsFailure);
    expect(updateToolApprovalSettings).toHaveBeenCalledOnce();

    first.resolve();
    await inFlight;
  });
});

interface ToolApprovalSourceHarness extends LegacyToolApprovalSource {
  responses: Array<{
    teamName: string;
    runId: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }>;
  settingsUpdates: Array<{ teamName: string; settings: ToolApprovalSettings }>;
}

function createSource(): ToolApprovalSourceHarness {
  return {
    responses: [],
    settingsUpdates: [],
    respondToToolApproval(teamName, runId, requestId, allow, message) {
      this.responses.push({ teamName, runId, requestId, allow, message });
      return Promise.resolve();
    },
    updateToolApprovalSettings(teamName, nextSettings) {
      this.settingsUpdates.push({ teamName, settings: nextSettings });
    },
  };
}

function pendingPromise(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
