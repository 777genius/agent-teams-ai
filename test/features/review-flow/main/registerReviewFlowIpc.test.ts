import {
  REVIEW_FLOW_GET_OVERVIEW,
  REVIEW_FLOW_SET_DEFAULTS,
  REVIEW_FLOW_SET_TEAM_OVERRIDE,
} from '@features/review-flow/contracts';
import { ReviewFlowService } from '@features/review-flow/core/application';
import { registerReviewFlowIpc, removeReviewFlowIpc } from '@features/review-flow/main';
import { describe, expect, it, vi } from 'vitest';

import type { IpcMain } from 'electron';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  } as unknown as IpcMain;
  const writeOverride = vi.fn(async () => undefined);
  const service = new ReviewFlowService({
    defaults: {
      read: async () => ({ reviewFlow: 'agent_approval', reviewFlowPrompt: '' }),
      write: async (settings) => settings,
    },
    teams: {
      writeOverride,
      listOverrides: async () => ({ overrides: {}, unreadable: [], projectTeams: {} }),
    },
  });
  registerReviewFlowIpc(ipcMain, service);
  return { handlers, ipcMain, writeOverride };
}

describe('review flow IPC', () => {
  it('answers with data envelopes instead of rejecting, so the UI gets readable errors', async () => {
    const { handlers, writeOverride } = setup();
    expect(await handlers.get(REVIEW_FLOW_GET_OVERVIEW)!({})).toMatchObject({ ok: true });
    expect(
      await handlers.get(REVIEW_FLOW_SET_DEFAULTS)!({}, { reviewFlow: 'human_approval' })
    ).toEqual({ ok: true, value: { reviewFlow: 'human_approval', reviewFlowPrompt: '' } });

    expect(await handlers.get(REVIEW_FLOW_SET_DEFAULTS)!({}, { reviewFlow: 'everyone' })).toEqual({
      ok: false,
      error: 'reviewFlow is not supported',
    });
    // A missing payload is rejected; only an explicit null removes an override.
    expect(await handlers.get(REVIEW_FLOW_SET_TEAM_OVERRIDE)!({}, 'alpha', undefined)).toMatchObject({
      ok: false,
    });
    expect(writeOverride).not.toHaveBeenCalled();
    expect(await handlers.get(REVIEW_FLOW_SET_TEAM_OVERRIDE)!({}, 'alpha', null)).toEqual({
      ok: true,
      value: null,
    });
    expect(writeOverride).toHaveBeenCalledWith('alpha', null);
  });

  it('removes exactly the channels it registered', () => {
    const { ipcMain } = setup();
    removeReviewFlowIpc(ipcMain);
    expect(vi.mocked(ipcMain.removeHandler).mock.calls.map(([channel]) => channel).sort()).toEqual(
      [REVIEW_FLOW_GET_OVERVIEW, REVIEW_FLOW_SET_DEFAULTS, REVIEW_FLOW_SET_TEAM_OVERRIDE].sort()
    );
  });
});
