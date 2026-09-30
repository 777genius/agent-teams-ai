import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchBranches: vi.fn(),
  setTracking: vi.fn(),
}));

vi.mock('@renderer/composition/team/createTeamBranchTrackingTransport', () => ({
  createTeamBranchTrackingTransport: () => ({
    setTracking: mocks.setTracking,
  }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (
    selector: (state: { fetchBranches: typeof mocks.fetchBranches }) => typeof mocks.fetchBranches
  ) => selector({ fetchBranches: mocks.fetchBranches }),
}));

import { useBranchSync } from '@renderer/hooks/useBranchSync';

interface ProbeProps {
  live?: boolean;
  paths: string[];
}

function Probe({ live, paths }: ProbeProps): React.JSX.Element | null {
  useBranchSync(paths, { live });
  return null;
}

const mountedRoots = new Set<Root>();

async function createTestRoot(element: React.ReactNode): Promise<Root> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return root;
}

async function render(root: Root, element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  mountedRoots.delete(root);
}

describe('useBranchSync', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fetchBranches.mockReset().mockResolvedValue(undefined);
    mocks.setTracking.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const root of mountedRoots) {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    }
    mountedRoots.clear();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('preserves the initial deduplicated branch fetch while live tracking is off', async () => {
    const root = await createTestRoot(
      <Probe live={false} paths={[' /sandbox/repo/ ', '/sandbox/repo', '', '   ']} />
    );

    expect(mocks.fetchBranches).toHaveBeenCalledOnce();
    expect(mocks.fetchBranches).toHaveBeenCalledWith(['/sandbox/repo/']);
    expect(mocks.setTracking).not.toHaveBeenCalled();

    await render(root, <Probe live={false} paths={['/sandbox/next']} />);
    expect(mocks.fetchBranches).toHaveBeenNthCalledWith(2, ['/sandbox/next']);
    expect(mocks.setTracking).not.toHaveBeenCalled();

    await unmount(root);
  });

  it('refcounts matching paths across mounted consumers and retains the first exact path', async () => {
    const root = await createTestRoot(
      <>
        <Probe key="first" live paths={['/sandbox/repo/']} />
        <Probe key="second" live paths={['/sandbox/repo']} />
      </>
    );

    expect(mocks.setTracking.mock.calls).toEqual([['/sandbox/repo/', true]]);

    await render(root, <Probe key="second" live paths={['/sandbox/repo']} />);
    expect(mocks.setTracking.mock.calls).toEqual([['/sandbox/repo/', true]]);

    await unmount(root);
    expect(mocks.setTracking.mock.calls).toEqual([
      ['/sandbox/repo/', true],
      ['/sandbox/repo/', false],
    ]);
  });

  it('reconciles path changes without restarting retained tracking', async () => {
    const root = await createTestRoot(<Probe live paths={['/sandbox/first', '/sandbox/shared']} />);

    await render(root, <Probe live paths={['/sandbox/shared', '/sandbox/second']} />);

    expect(mocks.setTracking.mock.calls).toEqual([
      ['/sandbox/first', true],
      ['/sandbox/shared', true],
      ['/sandbox/first', false],
      ['/sandbox/second', true],
    ]);

    await unmount(root);
  });

  it('releases active paths when live tracking turns off without affecting branch fetches', async () => {
    const root = await createTestRoot(<Probe live paths={['/sandbox/project']} />);

    await render(root, <Probe live={false} paths={['/sandbox/project']} />);

    expect(mocks.fetchBranches).toHaveBeenCalledOnce();
    expect(mocks.setTracking.mock.calls).toEqual([
      ['/sandbox/project', true],
      ['/sandbox/project', false],
    ]);

    await unmount(root);
    expect(mocks.setTracking).toHaveBeenCalledTimes(2);
  });
});
