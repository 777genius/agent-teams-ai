import { EventEmitter } from 'node:events';

import { sendSafeWebhook } from '@features/notification-channels/main/adapters/output/SafeWebhookSender';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';

const networkMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  request: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: { lookup: networkMocks.resolve },
  lookup: networkMocks.resolve,
}));
vi.mock('node:https', () => ({ default: { request: networkMocks.request } }));

const webhookUrl = 'https://workflow.example.org/hooks/test';

describe('custom webhook pinned HTTPS lookup failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    networkMocks.resolve.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  it.each([
    {
      name: 'rejects a different hostname for a single-address lookup',
      hostname: 'unexpected.example.org',
      lookupOptions: { all: false },
      emptyAddress: '',
      message: 'Untrusted webhook DNS lookup host',
    },
    {
      name: 'rejects a different hostname for an all-address lookup',
      hostname: 'unexpected.example.org',
      lookupOptions: { all: true },
      emptyAddress: [],
      message: 'Untrusted webhook DNS lookup host',
    },
    {
      name: 'rejects a requested family missing from the approved addresses',
      hostname: 'workflow.example.org',
      lookupOptions: { all: false, family: 6 },
      emptyAddress: '',
      message: 'No approved address for requested family',
    },
  ])('$name', async ({ hostname, lookupOptions, emptyAddress, message }) => {
    const lookupResult = vi.fn<Parameters<LookupFunction>[2]>();
    networkMocks.request.mockImplementation((_url: URL, options: RequestOptions) => {
      const request = new EventEmitter();
      lookupResult.mockImplementation((error) => {
        if (error) request.emit('error', error);
        request.emit('close');
      });
      return Object.assign(request, {
        end: () => {
          if (!options.lookup) throw new Error('Pinned lookup was not provided');
          options.lookup(hostname, lookupOptions, lookupResult);
        },
        destroy: (error: Error) => {
          request.emit('error', error);
          request.emit('close');
        },
      });
    });

    await expect(sendSafeWebhook(webhookUrl, 'test', 'Test notification')).resolves.toEqual({
      success: false,
      code: 'network_error',
    });
    expect(networkMocks.resolve).toHaveBeenCalledExactlyOnceWith('workflow.example.org', { all: true });
    expect(networkMocks.request).toHaveBeenCalledTimes(1);
    expect(lookupResult).toHaveBeenCalledExactlyOnceWith(expect.any(Error), emptyAddress);
    expect(lookupResult.mock.calls[0]?.[0]?.message).toBe(message);
  });
});
