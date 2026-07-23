import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewLifecycleRegistration } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppCloseParticipant } from '@features/app-close-coordination/renderer';
import type {
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from '@features/change-review/renderer';

interface LifecycleProbeProps {
  open: boolean;
  hostId?: string;
  sessionId?: string;
  requestClose: () => Promise<boolean>;
  closeRejectedDialog: () => void;
  flushForAppClose: AppCloseParticipant;
  registerOwner: RegisterChangeReviewLifecycleOwner;
  registerAppCloseParticipant: RegisterChangeReviewAppCloseParticipant;
}

async function flushReact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function LifecycleProbe({
  open,
  hostId = 'host-a',
  sessionId = 'session-a',
  requestClose,
  closeRejectedDialog,
  flushForAppClose,
  registerOwner,
  registerAppCloseParticipant,
}: Readonly<LifecycleProbeProps>): React.JSX.Element {
  const [authorized, setAuthorized] = useState(false);
  useChangeReviewLifecycleRegistration({
    open,
    authorized,
    hostId,
    sessionId,
    tabId: 'tab-a',
    requestClose,
    closeRejectedDialog,
    setAuthorized,
    appCloseParticipantId: 'changes:team-a:scope-a',
    flushForAppClose,
    registerOwner,
    registerAppCloseParticipant,
  });
  return <div data-authorized={String(authorized)} />;
}

describe('useChangeReviewLifecycleRegistration', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('claims ownership in layout and registers app-close only after authorization', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const unregisterOwner = vi.fn();
    const unregisterAppClose = vi.fn();
    const registerOwner = vi.fn<RegisterChangeReviewLifecycleOwner>(() => ({
      accepted: true,
      unregister: unregisterOwner,
    }));
    let appCloseParticipant: AppCloseParticipant | null = null;
    const registerAppCloseParticipant = vi.fn<RegisterChangeReviewAppCloseParticipant>(
      (_id, participant) => {
        appCloseParticipant = participant;
        return unregisterAppClose;
      }
    );
    const requestClose = vi.fn(() => Promise.resolve(true));
    const closeRejectedDialog = vi.fn();
    const flushForAppClose = vi.fn<AppCloseParticipant>(() => Promise.resolve({ ok: true }));

    await flushReact(() => {
      root.render(
        <LifecycleProbe
          open
          requestClose={requestClose}
          closeRejectedDialog={closeRejectedDialog}
          flushForAppClose={flushForAppClose}
          registerOwner={registerOwner}
          registerAppCloseParticipant={registerAppCloseParticipant}
        />
      );
    });

    expect(host.firstElementChild?.getAttribute('data-authorized')).toBe('true');
    expect(registerOwner).toHaveBeenCalledOnce();
    expect(registerOwner).toHaveBeenCalledWith({
      hostId: 'host-a',
      sessionId: 'session-a',
      tabId: 'tab-a',
      requestClose,
      focus: undefined,
    });
    expect(closeRejectedDialog).not.toHaveBeenCalled();
    expect(registerAppCloseParticipant).toHaveBeenCalledWith(
      'changes:team-a:scope-a',
      flushForAppClose
    );

    await appCloseParticipant!({
      requestId: 'close-a',
      reason: 'window-close',
      deadlineAt: Date.now() + 1_000,
    });
    expect(flushForAppClose).toHaveBeenCalledOnce();
    expect(closeRejectedDialog).not.toHaveBeenCalled();

    await flushReact(() => root.unmount());
    expect(unregisterOwner).toHaveBeenCalledOnce();
    expect(unregisterAppClose).toHaveBeenCalledOnce();
  });

  it('closes a rejected duplicate without registering an app-close participant', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const unregisterOwner = vi.fn();
    const registerOwner = vi.fn<RegisterChangeReviewLifecycleOwner>(() => ({
      accepted: false,
      unregister: unregisterOwner,
    }));
    const registerAppCloseParticipant = vi.fn<RegisterChangeReviewAppCloseParticipant>();
    const closeRejectedDialog = vi.fn();

    await flushReact(() => {
      root.render(
        <LifecycleProbe
          open
          requestClose={() => Promise.resolve(true)}
          closeRejectedDialog={closeRejectedDialog}
          flushForAppClose={() => Promise.resolve({ ok: true })}
          registerOwner={registerOwner}
          registerAppCloseParticipant={registerAppCloseParticipant}
        />
      );
    });

    expect(host.firstElementChild?.getAttribute('data-authorized')).toBe('false');
    expect(closeRejectedDialog).toHaveBeenCalledOnce();
    expect(registerAppCloseParticipant).not.toHaveBeenCalled();

    await flushReact(() => root.unmount());
    expect(unregisterOwner).toHaveBeenCalledOnce();
  });

  it('unregisters the previous owner before claiming a new host and session', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const firstUnregister = vi.fn();
    const secondUnregister = vi.fn();
    const registerOwner = vi
      .fn<RegisterChangeReviewLifecycleOwner>()
      .mockReturnValueOnce({ accepted: true, unregister: firstUnregister })
      .mockReturnValueOnce({ accepted: true, unregister: secondUnregister });
    const registerAppCloseParticipant = vi.fn<RegisterChangeReviewAppCloseParticipant>(() =>
      vi.fn()
    );
    const sharedProps = {
      open: true,
      requestClose: () => Promise.resolve(true),
      closeRejectedDialog: vi.fn(),
      flushForAppClose: () => Promise.resolve({ ok: true }),
      registerOwner,
      registerAppCloseParticipant,
    };

    await flushReact(() => {
      root.render(<LifecycleProbe {...sharedProps} hostId="host-a" sessionId="session-a" />);
    });
    await flushReact(() => {
      root.render(<LifecycleProbe {...sharedProps} hostId="host-b" sessionId="session-b" />);
    });

    expect(firstUnregister).toHaveBeenCalledOnce();
    expect(registerOwner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostId: 'host-b', sessionId: 'session-b' })
    );
    expect(host.firstElementChild?.getAttribute('data-authorized')).toBe('true');

    await flushReact(() => root.unmount());
    expect(secondUnregister).toHaveBeenCalledOnce();
  });
});
