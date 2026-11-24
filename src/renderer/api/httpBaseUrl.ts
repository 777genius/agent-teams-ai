/**
 * Choose the browser HTTP API origin.
 *
 * A same-origin loopback page must keep its exact host, since localhost and
 * 127.0.0.1 are different origins under the credential security gate.
 * A Vite/remote page using ?port=P targets the loopback API but cannot
 * administer credentials cross-origin.
 */
export function resolveHttpBaseUrl(pageOrigin: string, pageSearch: string): string {
  const explicitPort = new URLSearchParams(pageSearch).get('port');
  if (!explicitPort) return pageOrigin;
  const port = Number(explicitPort);
  if (!/^[1-9][0-9]{0,4}$/.test(explicitPort) || port > 65535) return pageOrigin;

  const target = `http://127.0.0.1:${port}`;
  const page = new URL(pageOrigin);
  if (
    page.protocol === 'http:' &&
    (page.hostname === 'localhost' || page.hostname === '127.0.0.1') &&
    (page.port === String(port) || (port === 80 && page.port === ''))
  ) {
    return page.origin;
  }
  return target;
}
