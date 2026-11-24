import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

import { validateProviderCredential } from '../../../core/domain/routing';

import type { DeliveryEvent, DeliveryFailureCode } from '../../../contracts';

type WebhookResult = { success: boolean; code?: DeliveryFailureCode };
type Address = { address: string; family: number };

const deniedV4 = new BlockList();
const deniedV6 = new BlockList();
const globalV6 = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deniedV4.addSubnet(address, prefix, 'ipv4');
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
] as const) deniedV6.addSubnet(address, prefix, 'ipv6');

/** Only globally routable destinations; deliberately reject IP literals and tunnels. */
export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, 'ipv4');
  return family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !deniedV6.check(address, 'ipv6');
}

interface WebhookNetwork {
  resolve(hostname: string): Promise<readonly Address[]>;
  post(url: URL, body: string, addresses: readonly Address[]): Promise<number>;
}

/** Resolve once, vet every A/AAAA answer and pin that exact set for TLS. */
const network: WebhookNetwork = {
  resolve: (hostname) => lookup(hostname, { all: true }),
  post: (url, body, addresses) =>
    new Promise<number>((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        agent: false, // Independent of process-global fetch dispatchers/proxies.
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        lookup: (hostname, options, callback) => {
          if (hostname !== url.hostname) {
            callback(new Error('Untrusted webhook DNS lookup host'));
            return;
          }
          if (options.all) {
            callback(null, [...addresses]);
            return;
          }
          const address = addresses.find((item) => !options.family || item.family === options.family);
          if (!address) {
            callback(new Error('No approved address for requested family'));
            return;
          }
          callback(null, address.address, address.family);
        },
      }, (response) => {
        const status = response.statusCode ?? 0;
        response.destroy(); // Never follow redirects or buffer an untrusted body.
        resolve(status);
      });
      const timer = setTimeout(() => req.destroy(new Error('Webhook timeout')), 10_000);
      req.once('error', reject);
      req.once('close', () => clearTimeout(timer));
      req.end(body);
    }),
};

async function resolveWithDeadline(
  hostname: string,
  port: WebhookNetwork
): Promise<readonly Address[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.resolve(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** No arbitrary headers, redirects, agent data, or credential-bearing error output. */
export async function sendSafeWebhook(
  secretUrl: string,
  event: DeliveryEvent | 'test',
  message: string,
  port: WebhookNetwork = network
): Promise<WebhookResult> {
  try {
    validateProviderCredential('webhook', secretUrl);
  } catch {
    return { success: false, code: 'unsafe_endpoint' };
  }
  const url = new URL(secretUrl);
  let addresses: readonly Address[];
  try {
    addresses = await resolveWithDeadline(url.hostname, port);
  } catch {
    return { success: false, code: 'network_error' };
  }
  if (
    addresses.length === 0 ||
    addresses.some((item) => item.family !== isIP(item.address) ||
      !isPublicWebhookAddress(item.address))
  ) {
    return { success: false, code: 'unsafe_endpoint' };
  }

  const body = JSON.stringify({ source: 'agent-teams', event, message });
  let status: number;
  try {
    status = await port.post(url, body, addresses);
  } catch {
    // Never surface request errors: signed webhook URLs may be embedded in them.
    return { success: false, code: 'network_error' };
  }
  if (status >= 200 && status < 300) return { success: true };
  if (status >= 300 && status < 400) return { success: false, code: 'redirect_rejected' };
  if (status === 401 || status === 403) return { success: false, code: 'authentication_failed' };
  if (status === 429) return { success: false, code: 'rate_limited' };
  if (status === 400 || status === 415 || status === 422) {
    return { success: false, code: 'invalid_request' };
  }
  return { success: false, code: status >= 500 ? 'network_error' : 'delivery_failed' };
}
