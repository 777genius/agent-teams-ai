import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { getView, openTeamTab, state } = vi.hoisted(() => ({
  getView: vi.fn(),
  openTeamTab: vi.fn(),
  state: {
    repositoryGroups: [],
    projects: [
      { id: 'a', name: 'Same name', path: '/TEST/a' },
      { id: 'b', name: 'Same name', path: '/TEST/b' },
    ],
  },
}));
vi.mock('@renderer/api', () => ({ api: { teams: { getProjectContextView: getView } } }));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => ({ openTeamTab }),
  }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { project?: string }) => `${key} ${options?.project ?? ''}`.trim(),
  }),
}));

import { ProjectContextRecoveryNotice } from './ProjectContextRecoveryNotice';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.clearAllMocks();
});

it('opens the exact blocked project from another project without launching or rewriting history', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getView.mockResolvedValue({
    mode: 'per_project',
    state: 'needs_project',
    recoveryProjectPath: '/TEST/b',
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const onNavigate = vi.fn();
  await act(async () =>
    root.render(<ProjectContextRecoveryNotice teamName="builders" onNavigate={onNavigate} />)
  );
  expect(host.textContent).toContain('/TEST/b');
  expect(host.textContent).not.toContain('/TEST/a');
  await act(async () => host.querySelector('button')?.click());
  expect(openTeamTab).toHaveBeenCalledExactlyOnceWith('builders', '/TEST/b');
  expect(onNavigate).toHaveBeenCalledOnce();
  expect(getView).toHaveBeenCalledExactlyOnceWith('builders', null);
});

describe.each(['/missing/b', null])('unavailable recovery destination %s', (path) => {
  it('never navigates to the currently selected unrelated project', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'needs_project',
      recoveryProjectPath: path,
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanup.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await act(async () =>
      root.render(<ProjectContextRecoveryNotice teamName="builders" onNavigate={() => undefined} />)
    );
    expect(host.querySelector('button')).toBeNull();
    expect(openTeamTab).not.toHaveBeenCalled();
  });
});
