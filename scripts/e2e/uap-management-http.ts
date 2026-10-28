import { request } from 'node:http';

/** Node fetch rewrites Host, so this probe must use the actual HTTP transport. */
export function postWithReboundHost(origin: string): Promise<{
  status: number;
  allowedOrigin: string | undefined;
}> {
  const address = new URL('/api/extension-management/hostStatus', origin);
  return new Promise((resolve, reject) => {
    const probe = request(
      address,
      {
        method: 'POST',
        headers: {
          Host: `rebound.invalid:${address.port}`,
          Origin: origin,
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            allowedOrigin: response.headers['access-control-allow-origin'],
          })
        );
        response.resume();
      }
    );
    probe.setTimeout(10_000, () => probe.destroy(new Error('Management HTTP probe timed out')));
    probe.on('error', reject);
    probe.end('{}');
  });
}
