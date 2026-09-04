import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { AnnouncementMarkdown } from '../../../../src/features/announcements/renderer/AnnouncementMarkdown';
import { announcementUrl } from '../../../../src/features/announcements/renderer/markdownPolicy';
const external = vi.hoisted(() => vi.fn());
const loadAsset = vi.hoisted(() => vi.fn());
const cancelAsset = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@renderer/api', () => ({
  api: { announcements: { loadAsset, cancelAsset }, openExternal: external },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
const base = 'https://agentteams.live/announcements/content/release/abcdef/body.md';
describe('remote Markdown boundary', () => {
  it('only loads same-bundle publisher assets and HTTPS external links', () => {
    expect(announcementUrl('assets/demo.gif', base, true)).toBe(
      'https://agentteams.live/announcements/content/release/abcdef/assets/demo.gif'
    );
    for (const bad of [
      '//evil.test/x',
      'https://evil.test/x',
      '../assets/x.png',
      'file:///tmp/x',
      'data:image/png,hi',
      'assets/%2e%2e/x',
      'https://user@agentteams.live/announcements/content/release/abcdef/assets/a.png',
    ])
      expect(announcementUrl(bad, base, true)).toBeNull();
    for (const bad of [
      'task://123',
      'team://hi',
      'file:///tmp/x',
      'javascript:alert(1)',
      'http://example.com',
      '//example.com',
      'https://x@y.test',
    ])
      expect(announcementUrl(bad, base)).toBeNull();
    expect(announcementUrl('https://example.com/docs', base)).toBe('https://example.com/docs');
  });
  it('renders GFM tables/images/code/lists/quotes with bounded overflow and no raw HTML', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    loadAsset.mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    const markdown =
      '# Release\n\n![Demo](assets/demo.gif)\n\n| A | B |\n| - | - |\n| one | two |\n\n> Quote\n\n- [x] Done\n\n```js\nconst x = 1;\n```\n\n[External](https://example.com/docs) [Task](task://a)\n\n<script>alert(1)</script><iframe src="https://evil.test"></iframe>';
    await act(async () =>
      root.render(
        <React.StrictMode>
          <AnnouncementMarkdown
            markdown={markdown}
            bodyUrl={base}
            heroImagePath="/announcements/content/release/abcdef/assets/demo.gif"
            heroImageAlt="Release cover"
          />
        </React.StrictMode>
      )
    );
    expect(mount.querySelector('table')).not.toBeNull();
    expect(mount.querySelector('table')?.parentElement?.className).toContain('overflow-x-auto');
    expect(mount.querySelector('pre')?.className).toContain('overflow-x-auto');
    expect(loadAsset).toHaveBeenCalledWith(
      'https://agentteams.live/announcements/content/release/abcdef/assets/demo.gif',
      expect.stringMatching(/^article_/)
    );
    expect(mount.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    );
    expect(mount.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    const hero = mount.querySelector('[data-announcement-hero]');
    expect(hero?.getAttribute('alt')).toBe('Release cover');
    expect(hero?.className).toContain('aspect-[55/12]');
    expect(hero?.className).toContain('w-full');
    expect(loadAsset).toHaveBeenCalledTimes(1);
    expect(mount.querySelector('blockquote')).not.toBeNull();
    expect(mount.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(mount.querySelector('script,iframe')).toBeNull();
    expect(mount.querySelectorAll('a')).toHaveLength(0);
    const externalButton = [...mount.querySelectorAll('button')].find(
      (button) => button.textContent === 'External'
    );
    expect(externalButton).toBeTruthy();
    externalButton!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(external).not.toHaveBeenCalled();
    await act(async () => externalButton!.click());
    expect(external).toHaveBeenCalledWith('https://example.com/docs');
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  });
});
