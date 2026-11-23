/** No cross-origin credential editing: use the app served from the exact API origin. */
export function resolveLocalSettingsUrl(
  pageOrigin: string,
  pageSearch: string,
  electronMode: boolean
): string | null {
  if (electronMode) return null;
  const port = new URLSearchParams(pageSearch).get('port');
  if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
  const target = new URL(`http://127.0.0.1:${Number(port)}/`);
  const localOrigin = `http://localhost:${Number(port)}`;
  return pageOrigin === target.origin || pageOrigin === localOrigin ? null : target.href;
}

/** Match the server's local-only HTTP administration policy before loading settings. */
export function isLocalSettingsOrigin(pageOrigin: string, electronMode: boolean): boolean {
  if (electronMode) return true;
  try {
    const page = new URL(pageOrigin);
    return page.protocol === 'http:' &&
      (page.hostname === 'localhost' || page.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
