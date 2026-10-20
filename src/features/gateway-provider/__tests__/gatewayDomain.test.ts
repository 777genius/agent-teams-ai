/* eslint-disable sonarjs/no-clear-text-protocols -- fixture URLs exercise the HTTP acceptance/rejection policy */
import { describe, expect, it } from 'vitest';

import {
  gatewayBindingKey,
  GatewayValidationError,
  normalizeGatewayBaseUrl,
  utcDayAt,
} from '../core/domain';

describe('normalizeGatewayBaseUrl', () => {
  it('strips one trailing /v1 and trailing slashes', () => {
    expect(normalizeGatewayBaseUrl({ baseUrl: 'https://gw.example.com/v1/' })).toBe(
      'https://gw.example.com'
    );
    expect(normalizeGatewayBaseUrl({ baseUrl: 'https://gw.example.com/sub/v1' })).toBe(
      'https://gw.example.com/sub'
    );
  });

  it('allows local HTTP only for loopback', () => {
    expect(normalizeGatewayBaseUrl({ baseUrl: 'http://127.0.0.1:8080' })).toBe(
      'http://127.0.0.1:8080'
    );
    expect(normalizeGatewayBaseUrl({ baseUrl: 'http://[::1]:8080' })).toBe('http://[::1]:8080');
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'http://gw.example.com' })).toThrow(
      GatewayValidationError
    );
  });

  it('requires approval for private non-loopback addresses', () => {
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'https://192.168.1.5' })).toThrow(
      GatewayValidationError
    );
    expect(
      normalizeGatewayBaseUrl({ baseUrl: 'https://192.168.1.5', allowPrivateNetwork: true })
    ).toBe('https://192.168.1.5');
    expect(() =>
      normalizeGatewayBaseUrl({ baseUrl: 'http://192.168.1.5', allowPrivateNetwork: true })
    ).toThrow(GatewayValidationError);
  });

  it('rejects credentials, query, fragment and unusable hosts', () => {
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'https://user:pass@gw.example.com' })).toThrow(
      GatewayValidationError
    );
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'https://gw.example.com?x=1' })).toThrow(
      GatewayValidationError
    );
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'https://gw.example.com#x' })).toThrow(
      GatewayValidationError
    );
    expect(() => normalizeGatewayBaseUrl({ baseUrl: 'https://0.0.0.0' })).toThrow(
      GatewayValidationError
    );
  });
});

describe('gateway identity helpers', () => {
  it('keeps binding keys collision-free', () => {
    expect(gatewayBindingKey('a\u0000b', 'c')).not.toBe(gatewayBindingKey('a', 'b\u0000c'));
  });

  it('formats UTC days', () => {
    expect(utcDayAt(new Date('2026-10-19T23:59:59.999Z'))).toBe('2026-10-19');
  });
});
