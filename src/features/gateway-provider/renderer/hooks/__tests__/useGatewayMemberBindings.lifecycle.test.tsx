import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listGatewayBindings, unbindGatewayMember } from '../../adapters/gatewayProviderApi';
import { useGatewayMemberBindings } from '../useGatewayMemberBindings';

import type { GatewayMemberBindingDto } from '../../../contracts';

vi.mock('../../adapters/gatewayProviderApi', () => ({
  listGatewayBindings: vi.fn(),
  unbindGatewayMember: vi.fn(),
}));

const list = vi.mocked(listGatewayBindings);
const unbind = vi.mocked(unbindGatewayMember);
type Mode = 'roster' | 'addition';
const modes: Mode[] = ['roster', 'addition'];
const memberNames = ['existing', 'new'];
const receipt = (memberName: string): GatewayMemberBindingDto => ({
  teamName: 'lifecycle-test-team',
  memberName,
  profileId: 'test-profile',
  profileDisplayName: 'Test gateway',
  gatewayUsageRef: `test-usage-${memberName}`,
  boundAt: '2026-11-07T00:00:00.000Z',
  credentialStatus: 'ready',
});
const existing = receipt('existing');
const allocated = receipt('new');
const expectedRemoval = {
  teamName: allocated.teamName,
  memberName: allocated.memberName,
  expectedBinding: {
    gatewayUsageRef: allocated.gatewayUsageRef,
    boundAt: allocated.boundAt,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root | null;
let host: HTMLDivElement;
let latest: ReturnType<typeof useGatewayMemberBindings>;

function Harness({ mode }: { mode: Mode }) {
  latest = useGatewayMemberBindings(allocated.teamName, { memberNames, mode });
  return null;
}

async function mount(mode: Mode) {
  await act(async () => {
    root!.render(
      <StrictMode>
        <Harness mode={mode} />
      </StrictMode>
    );
  });
  expect(latest.pending).toBe(false);
  expect(latest.boundMemberNames.has('existing')).toBe(true);
}

async function close() {
  const current = root;
  root = null;
  await act(async () => current?.unmount());
}

async function allocate() {
  await act(async () => {
    await latest.runBinding!(async () => allocated);
  });
}

// These tests characterize the existing dialog-owned default. A creation-page
// retention option must not weaken cancellation for launch or add-member dialogs.
describe.each(modes)('gateway dialog lifecycle (%s)', (mode) => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    list.mockReset().mockResolvedValue([existing]);
    unbind.mockReset().mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await close();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('removes only the exact newly allocated receipt when the dialog closes', async () => {
    await mount(mode);
    await allocate();
    expect(unbind).not.toHaveBeenCalled();

    await close();

    expect(unbind).toHaveBeenCalledExactlyOnceWith(expectedRemoval);
  });

  it('does not remove a pre-existing binding when the dialog closes', async () => {
    await mount(mode);

    await close();

    expect(unbind).not.toHaveBeenCalled();
  });

  it('keeps an allocated binding after the submission is accepted', async () => {
    await mount(mode);
    await allocate();
    await act(async () => {
      await latest.run(async () => undefined);
    });

    await close();

    expect(unbind).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'waits for pending acceptance after unmount (accepted=%s)',
    async (accepted) => {
      await mount(mode);
      await allocate();
      const gate = deferred<string>();
      let submission!: Promise<string>;
      await act(async () => {
        submission = latest.run(() => gate.promise);
      });
      // Attach both handlers before rejecting so this never leaks an unhandled rejection.
      const result = submission.then(
        () => 'accepted',
        () => 'rejected'
      );

      await close();
      expect(unbind).not.toHaveBeenCalled();
      await act(async () => {
        if (accepted) gate.resolve('accepted');
        else gate.reject(new Error('submission rejected'));
        expect(await result).toBe(accepted ? 'accepted' : 'rejected');
      });

      if (accepted) expect(unbind).not.toHaveBeenCalled();
      else expect(unbind).toHaveBeenCalledExactlyOnceWith(expectedRemoval);
    }
  );

  it('cleans a binding whose response arrives after the dialog unmounts', async () => {
    await mount(mode);
    const gate = deferred<GatewayMemberBindingDto>();
    let pending!: Promise<GatewayMemberBindingDto>;
    await act(async () => {
      pending = latest.runBinding!(() => gate.promise);
    });

    await close();
    expect(unbind).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve(allocated);
      await pending;
    });

    expect(unbind).toHaveBeenCalledExactlyOnceWith(expectedRemoval);
  });

  it('keeps a saved member binding when the subsequent launch fails', async () => {
    await mount(mode);
    await allocate();
    await act(async () => {
      await expect(
        latest.run(async () => {
          latest.markSaved(memberNames);
          throw new Error('launch failed after saving members');
        }, [])
      ).rejects.toThrow('launch failed after saving members');
    });

    await close();

    expect(unbind).not.toHaveBeenCalled();
  });
});
