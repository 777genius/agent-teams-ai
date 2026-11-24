import { describe, expect, it, vi } from 'vitest';

import {
  isPublicWebhookAddress,
  sendSafeWebhook,
} from '@features/notification-channels/main/adapters/output/SafeWebhookSender';

const url = 'https://workflow.example.org/hooks/secret-token?sig=private-key';

function stubNetwork(addresses: { address: string; family: number }[], status = 202) {
  const resolve = vi.fn(async (_hostname: string) => addresses);
  const post = vi.fn(async (_url: URL, _body: string, _addresses: readonly { address: string; family: number }[]) => status);
  return { resolve, post };
}

describe('Custom HTTPS webhook SSRF boundary', () => {
  it.each([
    '127.0.0.1', '10.4.5.6', '100.64.0.1', '169.254.169.254',
    '172.20.0.1', '192.168.1.2', '192.0.2.9', '198.18.0.1',
    '198.51.100.1', '203.0.113.2', '224.0.0.2', '0.0.0.0',
    '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '2001:db8::1', '2002:c0a8:0101::',
  ])('blocks non-public address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it.each(['93.184.215.14', '8.8.8.8', '2001:4860:4860::8888'])(
    'allows public address %s', (address) => {
      expect(isPublicWebhookAddress(address)).toBe(true);
    }
  );

  it('sends only fixed JSON to a public, pinned HTTPS destination', async () => {
    const network = stubNetwork([{ address: '8.8.8.8', family: 4 }]);
    expect(await sendSafeWebhook(url, 'user_inbox', 'Agent Teams: Message for you.', network))
      .toEqual({ success: true });
    expect(network.resolve).toHaveBeenCalledWith('workflow.example.org');
    const [target, body, addresses] = network.post.mock.calls[0]!;
    expect(target.toString()).toBe(url);
    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(JSON.parse(body)).toEqual({
      source: 'agent-teams', event: 'user_inbox', message: 'Agent Teams: Message for you.',
    });
    expect(body).not.toContain('private-key');
  });

  it('rejects mixed public/private DNS answers before any POST', async () => {
    const network = stubNetwork([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect(await sendSafeWebhook(url, 'test', 'test', network)).toEqual({
      success: false, code: 'unsafe_endpoint',
    });
    expect(network.post).not.toHaveBeenCalled();
  });

  it('rejects redirects and never exposes signed URLs in failures', async () => {
    const network = stubNetwork([{ address: '8.8.8.8', family: 4 }], 302);
    expect(await sendSafeWebhook(url, 'test', 'test', network)).toEqual({
      success: false, code: 'redirect_rejected',
    });
    network.post.mockRejectedValueOnce(new Error('failed to fetch ' + url));
    const result = await sendSafeWebhook(url, 'test', 'test', network);
    expect(result).toEqual({ success: false, code: 'network_error' });
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('never performs a request for an unsafe literal host', async () => {
    const network = stubNetwork([{ address: '8.8.8.8', family: 4 }]);
    expect(await sendSafeWebhook('https://127.0.0.1/hook', 'test', 'test', network))
      .toEqual({ success: false, code: 'unsafe_endpoint' });
    expect(network.resolve).not.toHaveBeenCalled();
    expect(network.post).not.toHaveBeenCalled();
  });
});
