import {
  createHostedTaskBoardTransport,
  type HostedTaskBoardFetchPort,
} from '@features/team-task-board/renderer';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const request = Object.freeze({
  schemaVersion: 1,
  teamId,
  cursor: null,
  expectedSourceGeneration: null,
  limit: 100,
}) as never;

function errorResponse(status: number, reason: string, retryable: boolean) {
  return {
    status,
    json: async () => ({
      schemaVersion: 1,
      kind: 'error',
      error: { code: status === 404 ? 'not_found' : 'unavailable', reason },
      retryable,
    }),
  };
}

function transport(fetch: HostedTaskBoardFetchPort, pageRetryDelaysMs = [0, 0, 0]) {
  return createHostedTaskBoardTransport({
    fetch,
    getCsrfToken: () => 'f'.repeat(32),
    pageRetryDelaysMs,
  });
}

describe('hosted task-board page read retry', () => {
  it('rides out retryable unavailability and returns the first settled answer', async () => {
    const fetch = vi
      .fn<HostedTaskBoardFetchPort>()
      .mockResolvedValueOnce(errorResponse(503, 'task_board_unavailable', true))
      .mockResolvedValueOnce(errorResponse(503, 'task_board_unavailable', true))
      .mockResolvedValue(errorResponse(404, 'task_board_not_found', false));
    await expect(transport(fetch).getPage(request)).resolves.toEqual({ kind: 'not_found' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops after the bounded backoff and never retries non-retryable answers', async () => {
    const exhausted = vi
      .fn<HostedTaskBoardFetchPort>()
      .mockResolvedValue(errorResponse(503, 'task_board_unavailable', true));
    await expect(transport(exhausted).getPage(request)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    expect(exhausted).toHaveBeenCalledTimes(4);

    const final = vi
      .fn<HostedTaskBoardFetchPort>()
      .mockResolvedValue(errorResponse(503, 'task_board_unavailable', false));
    await expect(transport(final).getPage(request)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    expect(final).toHaveBeenCalledOnce();
  });

  it('cancels during backoff without another request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<HostedTaskBoardFetchPort>(async () => {
      setTimeout(() => controller.abort(), 0);
      return errorResponse(503, 'task_board_unavailable', true);
    });
    await expect(
      transport(fetch, [60_000]).getPage(request, { signal: controller.signal })
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
