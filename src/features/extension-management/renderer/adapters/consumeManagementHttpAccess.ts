import { MANAGEMENT_ACCESS_CHANGED, MANAGEMENT_ACCESS_FRAGMENT } from '../../contracts';

interface Browser {
  location: Pick<Location, 'href'>;
  history: Pick<History, 'state' | 'replaceState'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/** Consume an owned-desktop grant without leaving it in URLs or sharing it across origins. */
export function consumeManagementHttpAccess(baseUrl: string, browser: Browser): string | undefined {
  const page = new URL(browser.location.href);
  const fragment = new URLSearchParams(page.hash.slice(1));
  const supplied = fragment.get(MANAGEMENT_ACCESS_FRAGMENT);
  if (supplied !== null) {
    fragment.delete(MANAGEMENT_ACCESS_FRAGMENT);
    page.hash = fragment.toString();
    browser.history.replaceState(
      browser.history.state,
      '',
      `${page.pathname}${page.search}${page.hash}`
    );
  }
  const api = new URL(baseUrl);
  if (
    api.origin !== page.origin ||
    api.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)
  )
    return undefined;
  const key = `extension-management-access:${page.origin}`;
  const valid = (value: string | null): value is string =>
    value !== null && /^[a-f0-9]{64}$/.test(value);
  try {
    if (supplied !== null) {
      if (valid(supplied)) browser.sessionStorage.setItem(key, supplied);
      else browser.sessionStorage.removeItem(key);
    }
    const token = supplied ?? browser.sessionStorage.getItem(key);
    return valid(token) ? token : undefined;
  } catch {
    // Blocked browser storage still permits this explicitly authorized page lifetime.
    return valid(supplied) ? supplied : undefined;
  }
}

/** One provider per browser API client; fresh copied links may be same-document navigations. */
export function createManagementHttpAccess(
  baseUrl: string,
  browser: Browser & Pick<Window, 'addEventListener' | 'dispatchEvent'>
): () => string | undefined {
  let capability = consumeManagementHttpAccess(baseUrl, browser);
  browser.addEventListener('hashchange', () => {
    if (!new URLSearchParams(browser.location.href.split('#')[1]).has(MANAGEMENT_ACCESS_FRAGMENT))
      return;
    const replacement = consumeManagementHttpAccess(baseUrl, browser);
    if (replacement === capability) return;
    capability = replacement;
    browser.dispatchEvent(new Event(MANAGEMENT_ACCESS_CHANGED));
  });
  return () => capability;
}
