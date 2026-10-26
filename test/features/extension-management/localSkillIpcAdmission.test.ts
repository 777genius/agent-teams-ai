import { describe, expect, it, vi } from 'vitest';

import {
  initializeSkillsHandlers,
  registerSkillsHandlers,
  removeSkillsHandlers,
  setSkillsMutationAdmission,
} from '../../../src/main/ipc/skills';
import { SKILLS_DELETE, SKILLS_DISCARD_REVIEW } from '../../../src/preload/constants/ipcChannels';

import type { SkillsMutationService } from '../../../src/main/services/extensions/skills/SkillsMutationService';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

describe('local Skill IPC admission', () => {
  it('admits abandonment only from the owned window and validates its opaque review ID', async () => {
    const expectedError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<{ success: boolean; error?: string }>
    >();
    const ipc = {
      handle: (channel: string, handler: never) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const discardReview = vi.fn(async () => {});
    initializeSkillsHandlers(undefined, { discardReview } as unknown as SkillsMutationService);
    registerSkillsHandlers(ipc);
    const trusted = {} as IpcMainInvokeEvent;
    const revoke = setSkillsMutationAdmission((event) => event === trusted);
    try {
      const handler = handlers.get(SKILLS_DISCARD_REVIEW)!;
      expect(await handler({} as IpcMainInvokeEvent, 'review-a')).toMatchObject({
        success: false,
        error: expect.stringContaining('untrusted window'),
      });
      for (const invalid of [undefined, {}, '', 'a'.repeat(201)]) {
        expect(await handler(trusted, invalid)).toMatchObject({ success: false });
      }
      expect(discardReview).not.toHaveBeenCalled();
      expect(await handler(trusted, 'review-a')).toEqual({ success: true, data: undefined });
      expect(discardReview).toHaveBeenCalledExactlyOnceWith('review-a');
    } finally {
      revoke();
      removeSkillsHandlers(ipc);
      expectedError.mockRestore();
    }
    expect(handlers.has(SKILLS_DISCARD_REVIEW)).toBe(false);
  });

  it('shares the owned-window boundary and revokes it on close', async () => {
    const expectedError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlerMap = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<{ success: boolean; error?: string }>
    >();
    const ipc = {
      handle: (channel: string, handler: never) => handlerMap.set(channel, handler),
      removeHandler: (channel: string) => handlerMap.delete(channel),
    } as unknown as IpcMain;
    const deleteSkill = vi.fn(async () => {});
    initializeSkillsHandlers(undefined, { deleteSkill } as unknown as SkillsMutationService);
    registerSkillsHandlers(ipc);
    const trusted = {} as IpcMainInvokeEvent;
    const revoke = setSkillsMutationAdmission((event) => event === trusted);
    const handler = handlerMap.get(SKILLS_DELETE)!;
    expect(await handler({} as IpcMainInvokeEvent, { skillId: '/untrusted' })).toMatchObject({
      success: false,
      error: expect.stringContaining('untrusted window'),
    });
    expect(deleteSkill).not.toHaveBeenCalled();
    expect(await handler(trusted, { skillId: '/captured' })).toMatchObject({ success: true });
    revoke();
    expect(await handler(trusted, { skillId: '/captured' })).toMatchObject({ success: false });
    expect(deleteSkill).toHaveBeenCalledTimes(1);
    removeSkillsHandlers(ipc);
    expect(expectedError).toHaveBeenCalledTimes(2);
    expectedError.mockRestore();
  });
});
