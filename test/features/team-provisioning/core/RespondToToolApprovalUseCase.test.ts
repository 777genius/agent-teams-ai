import { RespondToToolApprovalUseCase } from '@features/team-provisioning/core/application/commands/RespondToToolApprovalUseCase';
import { UpdateToolApprovalSettingsUseCase } from '@features/team-provisioning/core/application/commands/UpdateToolApprovalSettingsUseCase';
import { describe, expect, it, vi } from 'vitest';

import type {
  RespondToToolApprovalCommand,
  UpdateToolApprovalSettingsCommand,
} from '@features/team-provisioning/contracts/tool-approval';
import type {
  ToolApprovalResponsePort,
  ToolApprovalSettingsPort,
} from '@features/team-provisioning/core/application/ports/ToolApprovalPort';
import type { ToolApprovalSettings } from '@shared/types';

const settings: ToolApprovalSettings = {
  autoAllowAll: false,
  autoAllowFileEdits: true,
  autoAllowSafeBash: false,
  timeoutAction: 'deny',
  timeoutSeconds: 45,
};

describe('RespondToToolApprovalUseCase', () => {
  it('forwards the exact command and returns the port promise unchanged', async () => {
    const command: RespondToToolApprovalCommand = {
      teamName: '  alpha  ',
      runId: ' run-1 ',
      requestId: ' request-1 ',
      allow: true,
      message: '',
    };
    const response = Promise.resolve();
    const respondToToolApproval = vi.fn<ToolApprovalResponsePort['respondToToolApproval']>(
      () => response
    );
    const useCase = new RespondToToolApprovalUseCase({ respondToToolApproval });

    const result = useCase.execute(command);

    expect(result).toBe(response);
    await expect(result).resolves.toBeUndefined();
    expect(respondToToolApproval).toHaveBeenCalledOnce();
    expect(respondToToolApproval).toHaveBeenCalledWith(command);
    expect(respondToToolApproval.mock.calls[0]?.[0]).toBe(command);
  });

  it('propagates the exact failure without retrying or translating it', async () => {
    const failure = new Error('legacy response failed');
    const respondToToolApproval = vi.fn<ToolApprovalResponsePort['respondToToolApproval']>(() =>
      Promise.reject(failure)
    );
    const useCase = new RespondToToolApprovalUseCase({ respondToToolApproval });

    const result = useCase.execute({
      teamName: 'alpha',
      runId: 'run-1',
      requestId: 'request-1',
      allow: false,
    });

    await expect(result).rejects.toBe(failure);
    expect(respondToToolApproval).toHaveBeenCalledOnce();
  });

  it('leaves duplicate and concurrent response admission to the port', async () => {
    const first = pendingPromise();
    const second = pendingPromise();
    const respondToToolApproval = vi
      .fn<ToolApprovalResponsePort['respondToToolApproval']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const useCase = new RespondToToolApprovalUseCase({ respondToToolApproval });
    const command: RespondToToolApprovalCommand = {
      teamName: 'alpha',
      runId: 'run-1',
      requestId: 'request-1',
      allow: true,
    };

    const firstResult = useCase.execute(command);
    const secondResult = useCase.execute(command);

    expect(firstResult).toBe(first.promise);
    expect(secondResult).toBe(second.promise);
    expect(respondToToolApproval).toHaveBeenCalledTimes(2);

    first.resolve();
    second.resolve();
    await Promise.all([firstResult, secondResult]);
  });
});

describe('UpdateToolApprovalSettingsUseCase', () => {
  it('forwards the exact command synchronously on every update', () => {
    const updateToolApprovalSettings =
      vi.fn<ToolApprovalSettingsPort['updateToolApprovalSettings']>();
    const useCase = new UpdateToolApprovalSettingsUseCase({ updateToolApprovalSettings });
    const command: UpdateToolApprovalSettingsCommand = { teamName: ' alpha ', settings };

    expect(useCase.execute(command)).toBeUndefined();
    expect(useCase.execute(command)).toBeUndefined();

    expect(updateToolApprovalSettings).toHaveBeenCalledTimes(2);
    expect(updateToolApprovalSettings.mock.calls[0]?.[0]).toBe(command);
    expect(updateToolApprovalSettings.mock.calls[0]?.[0].settings).toBe(settings);
  });

  it('propagates a synchronous settings failure unchanged', () => {
    const failure = new Error('legacy settings failed');
    const updateToolApprovalSettings = vi.fn(() => {
      throw failure;
    });
    const useCase = new UpdateToolApprovalSettingsUseCase({ updateToolApprovalSettings });

    expect(() => useCase.execute({ teamName: 'alpha', settings })).toThrow(failure);
    expect(updateToolApprovalSettings).toHaveBeenCalledOnce();
  });
});

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
