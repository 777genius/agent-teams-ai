import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  BudgetConflictError,
  TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
  TOKEN_USAGE_BUDGET_STATUS_CHANGED,
  TOKEN_USAGE_BUDGET_STATUS_ROUTE,
  TOKEN_USAGE_GET_BUDGET_STATUS,
} from '../../../../../contracts';
import { createTokenUsageBridge } from '../../../../../preload/createTokenUsageBridge';
import { registerTokenUsageHttp } from '../registerTokenUsageHttp';

import type { TokenUsageFeatureFacade } from '../../../../composition/createTokenUsageFeature';
import type { IpcRenderer } from 'electron';

// Catches former PUT false-success and transport event/unsubscribe drift.
const config = {
  global: { monthlyTokenLimit: 100, thresholds: [50, 100], notificationsEnabled: true },
};
function facade(update: TokenUsageFeatureFacade['updateBudgetSettings']): TokenUsageFeatureFacade {
  return {
    updateBudgetSettings: update,
    getBudgetSettings: async () => ({}),
    getBudgetStatus: async () => {
      throw new Error('ledger unavailable');
    },
    getSnapshot: vi.fn(),
    refreshSnapshot: vi.fn(),
    recordRuns: vi.fn(),
    ingestEvents: vi.fn(),
    dispose: vi.fn(),
  };
}
describe('Budget HTTP and preload boundary', () => {
  it.each([
    [new BudgetConflictError('changed'), 409],
    [new Error('disk unavailable'), 503],
  ] as const)('rejects failed PUT rather than returning input body: %s', async (error, code) => {
    const app = Fastify();
    registerTokenUsageHttp(
      app,
      facade(async () => {
        throw error;
      })
    );
    const response = await app.inject({
      method: 'PUT',
      url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
      payload: { settings: config, teamIdentityVersion: 1, expectedUpdatedAt: null },
    });
    expect(response.statusCode).toBe(code);
    expect(response.json()).toEqual({ error: error.message });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      '[Feature:TokenUsage:HTTP]',
      'Failed to save budget settings',
      error
    );
    vi.mocked(console.error).mockClear();
    await app.close();
  });
  it('validation returns 400 before persistence and status error cannot become healthy zeros', async () => {
    const update = vi.fn(async () => ({}));
    const app = Fastify();
    registerTokenUsageHttp(app, facade(update));
    const response = await app.inject({
      method: 'PUT',
      url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
      payload: {
        settings: { global: { ...config.global, thresholds: [1, 1] } },
        teamIdentityVersion: 1,
        expectedUpdatedAt: null,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
    const status = await app.inject(TOKEN_USAGE_BUDGET_STATUS_ROUTE);
    expect(status.statusCode).toBe(503);
    expect(status.json()).not.toHaveProperty('targets');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      '[Feature:TokenUsage:HTTP]',
      'Failed to load budget status',
      expect.objectContaining({ message: 'ledger unavailable' })
    );
    vi.mocked(console.error).mockClear();
    await app.close();
  });
  it('returns server saved revision, never client timestamp', async () => {
    const app = Fastify();
    registerTokenUsageHttp(
      app,
      facade(async (request) => ({ ...request.settings, updatedAt: '2026-10-03T12:00:00.001Z' }))
    );
    const response = await app.inject({
      method: 'PUT',
      url: TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
      payload: {
        settings: { ...config, updatedAt: '2099-01-01T00:00:00.000Z' },
        teamIdentityVersion: 1,
        expectedUpdatedAt: null,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().updatedAt).toBe('2026-10-03T12:00:00.001Z');
    await app.close();
  });
  it('preload invokes status channel and removes exactly its event listener', async () => {
    const invoke = vi.fn(async () => ({}));
    const on = vi.fn();
    const removeListener = vi.fn();
    const bridge = createTokenUsageBridge({ invoke, on, removeListener } as unknown as IpcRenderer);
    await bridge.getBudgetStatus();
    const canonicalRequest = { teamIds: ['anonymous', 'team:unassigned'] };
    await bridge.getSnapshot(canonicalRequest);
    expect(invoke).toHaveBeenLastCalledWith('token-usage:get-snapshot', canonicalRequest);
    const canonicalSave = {
      teamIdentityVersion: 1 as const,
      settings: config,
      expectedUpdatedAt: null,
    };
    await bridge.updateBudgetSettings(canonicalSave);
    expect(invoke).toHaveBeenLastCalledWith('token-usage:update-budget-settings', canonicalSave);
    expect(invoke).toHaveBeenCalledWith(TOKEN_USAGE_GET_BUDGET_STATUS);
    const callback = vi.fn();
    const unsubscribe = bridge.onBudgetStatusChanged(callback);
    const listener = on.mock.calls[0][1] as (event: unknown, value: unknown) => void;
    const payload = { stale: true, value: null };
    listener({}, payload);
    expect(callback).toHaveBeenCalledWith(payload);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(TOKEN_USAGE_BUDGET_STATUS_CHANGED, listener);
  });
});
