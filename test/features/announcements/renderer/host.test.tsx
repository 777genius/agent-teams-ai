import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnouncementHost } from '../../../../src/features/announcements/renderer/AnnouncementHost';
import { openAnnouncementHistory } from '../../../../src/features/announcements/renderer/newsNavigation';
import { useOverlayOccupancy } from '../../../../src/renderer/hooks/useOverlayOccupancy';

import type {
  Announcement,
  AnnouncementsApi,
  AnnouncementsSnapshot,
} from '../../../../src/features/announcements/contracts';

vi.mock('@renderer/api', () => ({ api: { openExternal: vi.fn() } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
const item: Announcement = {
  id: 'release',
  title: 'A fresh release',
  publishedAt: '2026-09-01T00:00:00Z',
  validUntil: '2099-09-01T00:00:00Z',
  showToNewUsers: true,
  minUsageMinutes: 30,
  status: 'published',
  bodyPath: '/announcements/content/release/aa/body.md',
  bodySha256: 'a'.repeat(64),
};
const article = {
  announcement: item,
  markdown: '## Highlights\n\nA useful update.',
  bodyUrl: `https://agentteams.live${item.bodyPath}`,
};
let snapshot: AnnouncementsSnapshot;
let listener: (value: AnnouncementsSnapshot) => void;
let client: AnnouncementsApi;
let root: Root;
let mount: HTMLDivElement;
function Blocker({ open }: { open: boolean }) {
  useOverlayOccupancy(open);
  return null;
}
async function render(ready = true, blocked = false) {
  await act(async () => {
    root.render(
      <>
        <AnnouncementHost ready={ready} client={client} />
        <Blocker open={blocked} />
      </>
    );
  });
}
async function click(text: string) {
  const element = [...document.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text)
  );
  expect(element).toBeTruthy();
  await act(async () => {
    element!.click();
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  snapshot = {
    status: 'ready',
    items: [item],
    candidateId: null,
    revision: 'one',
    checkedAt: '2026-09-04T00:00:00Z',
    autoShowEnabled: true,
  };
  client = {
    getSnapshot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    prepareAuto: vi.fn(async () => null),
    claimAuto: vi.fn(async () => article),
    openManual: vi.fn(async () => article),
    loadAsset: vi.fn(async () => null),
    cancelAsset: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => ({ saved: true })),
    onStateChanged: vi.fn((cb) => {
      listener = cb;
      return () => undefined;
    }),
  };
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
});
afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('announcement host', () => {
  it('opens the immediate history without consumption; row consumes, back and close dismiss', async () => {
    await render(false);
    await act(async () => openAnnouncementHistory());
    expect(client.openManual).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(item.title);
    await click(item.title);
    expect(client.openManual).toHaveBeenCalledWith(item.id);
    expect(document.body.textContent).toContain('Highlights');
    await click('announcements.allNews');
    expect(client.dismiss).toHaveBeenCalledWith(item.id);
    await click('actions.close');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('blocks background, splash and occupied auto claims', async () => {
    vi.mocked(client.prepareAuto).mockResolvedValue({ ...article, revision: 'one' });
    await render(false);
    expect(client.claimAuto).not.toHaveBeenCalled();
    await render(true, true);
    expect(client.claimAuto).not.toHaveBeenCalled();
    await render(true, false);
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render(true, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(true, false);
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('never auto-claims new data inside history or cascades on close/dismiss event', async () => {
    await render();
    await act(async () => openAnnouncementHistory());
    vi.mocked(client.prepareAuto)
      .mockClear()
      .mockResolvedValue({ ...article, revision: 'two' });
    snapshot = { ...snapshot, revision: 'two', candidateId: item.id };
    await act(async () => listener(snapshot));
    expect(client.prepareAuto).not.toHaveBeenCalled();
    await click('actions.close');
    await act(async () => listener(snapshot));
    expect(client.prepareAuto).not.toHaveBeenCalled();
  });
  it('does not reopen after history closes while a manual refresh is pending', async () => {
    let finish!: (value: AnnouncementsSnapshot) => void;
    vi.mocked(client.refresh).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await render();
    await act(async () => openAnnouncementHistory());
    await click('actions.refresh');
    await click('actions.close');
    vi.mocked(client.prepareAuto).mockClear().mockResolvedValue({ ...article, revision: 'two' });
    snapshot = { ...snapshot, revision: 'two', candidateId: item.id };
    await act(async () => listener(snapshot));
    expect(client.prepareAuto).not.toHaveBeenCalled();
    await act(async () => finish(snapshot));
    expect(client.prepareAuto).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('retains a durable claim when focus changes before completion', async () => {
    let finish!: (value: typeof article) => void;
    vi.mocked(client.prepareAuto).mockResolvedValue({ ...article, revision: 'one' });
    vi.mocked(client.claimAuto).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await render();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      finish(article);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(client.prepareAuto).toHaveBeenCalledTimes(1);
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('closes on Escape without selecting another announcement', async () => {
    await render(false);
    await act(async () => openAnnouncementHistory());
    await click(item.title);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(client.dismiss).toHaveBeenCalledWith(item.id);
  });
  it('claims once under StrictMode and does not open while unfocused', async () => {
    vi.mocked(client.prepareAuto).mockResolvedValue({ ...article, revision: 'one' });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () =>
      root.render(
        <React.StrictMode>
          <AnnouncementHost ready client={client} />
        </React.StrictMode>
      )
    );
    expect(client.claimAuto).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('coalesces a blocker release while preparation is pending', async () => {
    let finish!: (value: typeof article & { revision: string }) => void;
    vi.mocked(client.prepareAuto)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ ...article, revision: 'one' });
    await render();
    await render(true, true);
    await render(true, false);
    await act(async () => finish({ ...article, revision: 'one' }));
    expect(client.prepareAuto).toHaveBeenCalledTimes(2);
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('finishes manual loading across background focus changes', async () => {
    let finish!: (value: typeof article) => void;
    vi.mocked(client.openManual).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await render(false);
    await act(async () => openAnnouncementHistory());
    await click(item.title);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      finish(article);
    });
    expect(document.body.textContent).toContain('Highlights');
    expect(document.body.textContent).not.toContain('announcements.loading');
  });
  it('retries on a new successful refresh epoch, but not a dismiss heartbeat', async () => {
    await render(false);
    await act(async () => openAnnouncementHistory());
    snapshot = { ...snapshot, candidateId: item.id };
    await act(async () => listener(snapshot));
    await click('actions.close');
    await render(true);
    vi.mocked(client.prepareAuto)
      .mockClear()
      .mockResolvedValue({ ...article, revision: 'one' });
    await act(async () => listener(snapshot));
    expect(client.prepareAuto).not.toHaveBeenCalled();
    await act(async () => listener({ ...snapshot, checkedAt: '2026-09-04T00:15:00Z' }));
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
  });
  it('waits for document load completion and retries after the load event task', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    vi.mocked(client.prepareAuto).mockResolvedValue({ ...article, revision: 'one' });
    await render();
    expect(client.prepareAuto).not.toHaveBeenCalled();
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    await act(async () => {
      window.dispatchEvent(new Event('load'));
    });
    expect(client.prepareAuto).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.claimAuto).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('closes from the backdrop and footer close control', async () => {
    await render(false);
    await act(async () => openAnnouncementHistory());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    const backdrop = document.querySelector('[data-state="open"].bg-black\\/60');
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => openAnnouncementHistory());
    const footer = [...document.querySelectorAll('footer button')].find(
      (node) => node.textContent === 'actions.close'
    );
    await act(async () => (footer as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('shows writer busy without allowing article consumption', async () => {
    snapshot = { ...snapshot, status: 'writer_busy' };
    await render(false);
    await act(async () => openAnnouncementHistory());
    await click(item.title);
    expect(client.openManual).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('announcements.status.writer_busy');
  });
});
