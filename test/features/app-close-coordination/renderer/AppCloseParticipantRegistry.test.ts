import {
  initializeAppCloseCoordination,
  registerAppCloseParticipant,
  runAppCloseParticipants,
} from '@features/app-close-coordination/renderer';
import { describe, expect, it } from 'vitest';

import type {
  AppCloseCoordinationElectronApi,
  AppCloseReadinessHandler,
  AppCloseReadinessRequest,
} from '@features/app-close-coordination/contracts';

const request: AppCloseReadinessRequest = {
  requestId: 'request-1',
  reason: 'app-quit',
  deadlineAt: Date.now() + 5_000,
};

describe('AppCloseParticipantRegistry', () => {
  it('aggregates explicit blockers and rejected flushes without hiding either failure', async () => {
    const removeFirst = registerAppCloseParticipant('changes', async () => ({
      ok: false,
      blocker: 'Review decisions are not saved.',
    }));
    const removeSecond = registerAppCloseParticipant('drafts', async () => {
      throw new Error('draft fsync failed');
    });

    await expect(runAppCloseParticipants(request)).resolves.toEqual({
      ok: false,
      blockers: ['Review decisions are not saved.', 'drafts: draft fsync failed'],
    });

    removeFirst();
    removeSecond();
  });

  it('does not let an older StrictMode cleanup remove a newer registration with the same id', async () => {
    const removeOld = registerAppCloseParticipant('changes', async () => ({
      ok: false,
      blocker: 'stale handler',
    }));
    const removeCurrent = registerAppCloseParticipant('changes', async () => ({ ok: true }));

    removeOld();
    await expect(runAppCloseParticipants(request)).resolves.toEqual({ ok: true, blockers: [] });

    removeCurrent();
  });

  it('wires and removes the preload readiness listener', async () => {
    let handler: AppCloseReadinessHandler | null = null;
    const api: AppCloseCoordinationElectronApi = {
      onReadinessRequest: (nextHandler) => {
        handler = nextHandler;
        return () => {
          handler = null;
        };
      },
    };

    const cleanup = initializeAppCloseCoordination(api);
    const activeHandler = handler as AppCloseReadinessHandler | null;
    expect(activeHandler).not.toBeNull();
    if (!activeHandler) throw new Error('Readiness handler was not installed');
    await expect(activeHandler(request)).resolves.toEqual({ ok: true, blockers: [] });

    cleanup();
    expect(handler).toBeNull();
  });
});
