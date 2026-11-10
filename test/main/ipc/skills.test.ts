import { describe, expect, it, vi } from 'vitest';

import {
  initializeSkillsHandlers,
  registerSkillsHandlers,
  removeSkillsHandlers,
} from '@main/ipc/skills';
import { SKILLS_APPLY_UPSERT, SKILLS_LIST } from '@preload/constants/ipcChannels';

describe('skills IPC handlers', () => {
  it('returns a validation error when applyUpsert has no request payload', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };

    initializeSkillsHandlers(
      { list: vi.fn(), getDetail: vi.fn() } as any,
      { previewUpsert: vi.fn(), applyUpsert: vi.fn() } as any,
      { start: vi.fn(), stop: vi.fn() } as any
    );
    registerSkillsHandlers(ipcMain as any);

    const result = (await handlers.get(SKILLS_APPLY_UPSERT)?.({})) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('request is required');

    consoleErrorSpy.mockRestore();
    removeSkillsHandlers(ipcMain as any);
  });

  it('returns successful list results from the catalog service', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };

    initializeSkillsHandlers(
      {
        list: vi.fn().mockResolvedValue([{ id: 'skill-1' }]),
        getDetail: vi.fn(),
      } as any,
      { previewUpsert: vi.fn(), applyUpsert: vi.fn() } as any,
      { start: vi.fn(), stop: vi.fn() } as any
    );
    registerSkillsHandlers(ipcMain as any);

    const result = (await handlers.get(SKILLS_LIST)?.({}, '/tmp/project')) as {
      success: boolean;
      data?: Array<{ id: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ id: 'skill-1' }]);

    removeSkillsHandlers(ipcMain as any);
  });
});
