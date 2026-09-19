import { readFileSync } from 'node:fs';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/renderer/App';

const mocks = vi.hoisted(() => ({
  announcements: { getSnapshot: vi.fn() },
  hostProps: [] as Record<string, unknown>[],
  openExternal: vi.fn(async () => ({ success: true })),
}));

vi.mock('@features/announcements/renderer', () => ({
  AnnouncementHost: (props: Record<string, unknown>) => {
    mocks.hostProps.push(props);
    return null;
  },
}));
vi.mock('@features/localization/renderer', () => ({
  LocalizationProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock('@renderer/api', () => ({
  api: { announcements: mocks.announcements, openExternal: mocks.openExternal },
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock('../../src/renderer/components/common/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../../src/renderer/components/common/ContextSwitchOverlay', () => ({
  ContextSwitchOverlay: () => null,
}));
vi.mock('../../src/renderer/components/common/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock('../../src/renderer/components/layout/TabbedLayout', () => ({ TabbedLayout: () => null }));
vi.mock('../../src/renderer/components/team/ToolApprovalSheet', () => ({
  ToolApprovalSheet: () => null,
}));
vi.mock('../../src/renderer/hooks/useTheme', () => ({ useThemeController: vi.fn() }));
vi.mock('../../src/renderer/store', () => ({
  useStore: (selector: (state: { appConfig: object }) => unknown) =>
    selector({ appConfig: {} }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.getElementById('splash')?.remove();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.hostProps.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('announcements shell renderer composition', () => {
  it('passes the API client, ready state, and a stable API-level external opener', async () => {
    await act(async () => root.render(<App />));
    const first = mocks.hostProps.at(-1)!;
    expect(first).toMatchObject({ client: mocks.announcements, ready: true });
    await act(async () => root.render(<App />));
    const second = mocks.hostProps.at(-1)!;
    expect(second.openExternal).toBe(first.openExternal);
    await (first.openExternal as (url: string) => Promise<unknown>)('https://agentteams.live/news');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://agentteams.live/news');
  });

  it('gates all full-window News buttons at the shell boundary', () => {
    const editor = readFileSync('src/renderer/components/team/editor/ProjectEditorOverlay.tsx', 'utf8');
    const review = readFileSync('src/renderer/components/team/review/ChangeReviewDialogView.tsx', 'utf8');
    const graph = readFileSync('src/features/agent-graph/renderer/ui/TeamGraphOverlay.tsx', 'utf8');
    const graphTab = readFileSync('src/features/agent-graph/renderer/ui/TeamGraphTab.tsx', 'utf8');
    const paneContent = readFileSync('src/renderer/components/layout/PaneContent.tsx', 'utf8');
    const detail = readFileSync('src/renderer/components/team/TeamDetailView.tsx', 'utf8');

    expect(editor).toContain('<AnnouncementNewsButton visible={isElectronMode()} />');
    expect(review).toContain('<AnnouncementNewsButton visible={isElectronMode()} />');
    expect(graph).toContain('<AnnouncementNewsButton visible={announcementsVisible} />');
    expect(graphTab).toContain('announcementsVisible={announcementsVisible}');
    expect(paneContent).toContain('const announcementsVisible = isElectronMode()');
    expect(paneContent).toContain('announcementsVisible={announcementsVisible}');
    expect(detail).toContain('announcementsVisible={isElectronMode()}');
    expect(graph).not.toContain('@renderer/api');
    expect(graphTab).not.toContain('@renderer/api');
  });
});
