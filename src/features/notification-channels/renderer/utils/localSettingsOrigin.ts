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
  return pageOrigin === target.origin ? null : target.href;
}
