import { describe, expect, it, vi } from 'vitest';

import { MANAGEMENT_ACCESS_CHANGED } from '../../../src/features/extension-management/contracts';
import {
  consumeManagementHttpAccess,
  createManagementHttpAccess,
} from '../../../src/features/extension-management/renderer/adapters/consumeManagementHttpAccess';
import { createExtensionManagementHttpClient } from '../../../src/features/extension-management/renderer/adapters/createExtensionManagementHttpClient';

const origin = 'http://127.0.0.1:4141';
const token = 'a'.repeat(64);
function browser(href = `${origin}/#management-access=${token}`) {
  const values = new Map<string, string>();
  const location = { href };
  const events = new EventTarget();
  return {
    location,
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    history: {
      state: { preserved: true },
      replaceState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
        location.href = new URL(String(url), location.href).href;
      }),
    },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

describe('owned desktop browser grant', () => {
  it('scrubs the fragment and retains only a same-tab, exact-origin grant across reload', () => {
    const page = browser();
    expect(consumeManagementHttpAccess(origin, page)).toBe(token);
    expect(page.location.href).toBe(`${origin}/`);
    expect(page.history.replaceState).toHaveBeenCalledWith({ preserved: true }, '', '/');
    expect(consumeManagementHttpAccess(origin, page)).toBe(token);
    expect(consumeManagementHttpAccess(origin, browser(`${origin}/`))).toBeUndefined();
    expect(consumeManagementHttpAccess('http://127.0.0.1:4142', page)).toBeUndefined();
    expect(consumeManagementHttpAccess('http://localhost:4141', page)).toBeUndefined();
  });

  it('never grants a query-selected other server and rejects malformed fragments', () => {
    const page = browser(`${origin}/?port=4142#management-access=${token}`);
    expect(consumeManagementHttpAccess('http://127.0.0.1:4142', page)).toBeUndefined();
    expect(page.location.href).toBe(`${origin}/?port=4142`);
    expect(consumeManagementHttpAccess(origin, page)).toBeUndefined();
    page.location.href = `${origin}/#management-access=not-a-grant`;
    expect(consumeManagementHttpAccess(origin, page)).toBeUndefined();
    expect(page.location.href).toBe(`${origin}/`);
  });

  it('sends the capability only to the configured management client', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ available: true })));
    vi.stubGlobal('fetch', fetch);
    try {
      await createExtensionManagementHttpClient(origin, token).hostStatus();
      expect(fetch).toHaveBeenLastCalledWith(
        `${origin}/api/extension-management/hostStatus`,
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        })
      );
      await createExtensionManagementHttpClient(origin).hostStatus();
      expect(fetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts and scrubs a replacement link in the same tab without replacing the API client', async () => {
    const page = browser();
    const changed = vi.fn();
    page.addEventListener(MANAGEMENT_ACCESS_CHANGED, changed);
    const access = createManagementHttpAccess(origin, page);
    const client = createExtensionManagementHttpClient(origin, access);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    try {
      await client.hostStatus();
      const replacement = 'b'.repeat(64);
      page.location.href = `${origin}/#management-access=${replacement}`;
      page.dispatchEvent(new Event('hashchange'));
      expect(page.location.href).toBe(`${origin}/`);
      expect(changed).toHaveBeenCalledOnce();
      await client.hostStatus();
      expect(fetch.mock.calls[1][1]).toMatchObject({
        headers: { Authorization: `Bearer ${replacement}` },
      });
      expect(consumeManagementHttpAccess(origin, page)).toBe(replacement);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('supports the initial and replacement page lifetime when tab storage is blocked', () => {
    const page = browser();
    Object.defineProperty(page, 'sessionStorage', {
      get: () => {
        throw new Error('Storage blocked');
      },
    });
    const access = createManagementHttpAccess(origin, page);
    expect(access()).toBe(token);
    page.location.href = `${origin}/#management-access=${'b'.repeat(64)}`;
    page.dispatchEvent(new Event('hashchange'));
    expect(access()).toBe('b'.repeat(64));
    expect(page.location.href).toBe(`${origin}/`);
  });
});
