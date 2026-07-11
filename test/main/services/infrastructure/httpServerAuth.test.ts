import { describe, expect, it } from 'vitest';

import {
  assertHttpServerBindAllowed,
  extractBearerAuthToken,
  timingSafeHttpAuthTokenEquals,
} from '../../../../src/main/services/infrastructure/httpServerAuth';

describe('httpServerAuth', () => {
  it('fails closed for non-loopback binds without an auth token', () => {
    expect(() => assertHttpServerBindAllowed('0.0.0.0', null)).toThrow('non-loopback host');
    expect(() => assertHttpServerBindAllowed('127.0.0.1', null)).not.toThrow();
    expect(() => assertHttpServerBindAllowed('0.0.0.0', 'token')).not.toThrow();
  });

  it('compares bearer tokens through fixed-length digests', () => {
    expect(timingSafeHttpAuthTokenEquals('expected-token', 'expected-token')).toBe(true);
    expect(timingSafeHttpAuthTokenEquals('expected-token', 'wrong-token')).toBe(false);
    expect(timingSafeHttpAuthTokenEquals('expected-token', '')).toBe(false);
  });

  it('accepts exactly one bearer token value', () => {
    expect(extractBearerAuthToken('Bearer expected-token')).toBe('expected-token');
    expect(extractBearerAuthToken('Basic expected-token')).toBeNull();
    expect(extractBearerAuthToken('Bearer expected-token extra')).toBeNull();
  });
});
