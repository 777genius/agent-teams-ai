import {
  isLoopbackHostname,
  isPrivateNetworkHostname,
  isUnusableNetworkHostname,
} from '@shared/utils/networkHost';
import { describe, expect, it } from 'vitest';

describe('IPv4-mapped IPv6 host classification', () => {
  it.each([
    ['127.0.0.1', '7f00:1', true, false, false],
    ['127.255.0.1', '7fff:1', true, false, false],
    ['10.0.0.1', 'a00:1', false, true, false],
    ['172.16.0.1', 'ac10:1', false, true, false],
    ['192.168.0.1', 'c0a8:1', false, true, false],
    ['169.254.1.1', 'a9fe:101', false, true, false],
    ['0.0.0.0', '0:0', false, false, true],
    ['224.0.0.1', 'e000:1', false, false, true],
    ['255.255.255.255', 'ffff:ffff', false, false, true],
    ['8.8.8.8', '808:808', false, false, false],
    ['172.32.0.1', 'ac20:1', false, false, false],
  ])(
    'classifies mapped %s consistently across literal forms',
    (ipv4, hex, loopback, privateNetwork, unusable) => {
      const hosts = [
        `::ffff:${ipv4}`,
        `[::ffff:${ipv4}]`,
        `::ffff:${hex}`,
        `0:0:0:0:0:ffff:${hex}`,
        new URL(`https://[::ffff:${ipv4}]`).hostname,
      ];
      for (const hostname of hosts) {
        expect(isLoopbackHostname(hostname), hostname).toBe(loopback);
        expect(isPrivateNetworkHostname(hostname), hostname).toBe(privateNetwork);
        expect(isUnusableNetworkHostname(hostname), hostname).toBe(unusable);
      }
    }
  );

  it('preserves native IPv6 and hostname classifications', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isPrivateNetworkHostname('[fd00::1]')).toBe(true);
    expect(isUnusableNetworkHostname('[ff02::1]')).toBe(true);
    expect(isPrivateNetworkHostname('gateway.local')).toBe(true);
    expect(isPrivateNetworkHostname('[2001:4860:4860::8888]')).toBe(false);
  });
});
