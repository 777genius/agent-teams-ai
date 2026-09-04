import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoreMenu } from '../../../../src/renderer/components/layout/MoreMenu';

const openHistory = vi.hoisted(() => vi.fn());
vi.mock('@features/announcements/renderer', () => ({
  openAnnouncementHistory: openHistory,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ isElectronMode: () => true }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, ReturnType<typeof vi.fn>>) => unknown) =>
    selector({
      openCommandPalette: vi.fn(),
      openExtensionsTab: vi.fn(),
      openSessionReport: vi.fn(),
      openSchedulesTab: vi.fn(),
      openSettingsTab: vi.fn(),
      openTeamsTab: vi.fn(),
      openTab: vi.fn(),
    }),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('MoreMenu announcements action', () => {
  it('restores focus to its trigger before opening News', async () => {
    await act(async () =>
      root.render(
        <MoreMenu activeTab={undefined} activeTabSessionDetail={null} activeTabId={null} />
      )
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="actions.moreActions"]'
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    const news = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'announcements.title'
    );
    expect(news).toBeTruthy();
    await act(async () => news!.click());
    expect(document.activeElement).toBe(trigger);
    expect(openHistory).toHaveBeenCalledTimes(1);
  });
});
