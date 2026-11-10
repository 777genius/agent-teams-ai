import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentSentryTelemetryContext: vi.fn(),
  getMainSentryStatus: vi.fn(),
}));

vi.mock('@main/sentry', () => mocks);

import { registerTelemetryHandlers, removeTelemetryHandlers } from '@main/ipc/telemetry';

describe('telemetry IPC', () => {
  it('registers context and sanitized status handlers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };
    mocks.getCurrentSentryTelemetryContext.mockResolvedValue({
      userId: 'hashed-user',
      tags: { release: 'agent-teams-ai@2.10.0' },
    });
    mocks.getMainSentryStatus.mockReturnValue({
      state: 'active',
      reason: null,
      environment: 'production',
      release: 'agent-teams-ai@2.10.0',
    });

    registerTelemetryHandlers(ipcMain as never);

    await expect(handlers.get('telemetry:getSentryContext')?.()).resolves.toMatchObject({
      userId: 'hashed-user',
    });
    expect(handlers.get('telemetry:getSentryStatus')?.()).toEqual({
      state: 'active',
      reason: null,
      environment: 'production',
      release: 'agent-teams-ai@2.10.0',
    });

    removeTelemetryHandlers(ipcMain as never);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('telemetry:getSentryContext');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('telemetry:getSentryStatus');
  });
});
