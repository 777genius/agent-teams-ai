import { validateAnthropicCompatibleBaseUrl } from '@renderer/components/runtime/providerConnectionCards';
import { describe, expect, it } from 'vitest';

const t = ((key: string) => key) as unknown as Parameters<
  typeof validateAnthropicCompatibleBaseUrl
>[1];

describe('validateAnthropicCompatibleBaseUrl', () => {
  it.each([
    ['', 'baseUrlRequired'],
    ['not a url', 'invalidUrl'],
    ['ftp://localhost:1234', 'httpRequired'],
    ['file:///tmp/anthropic.sock', 'httpRequired'],
    ['http://user:secret@localhost:1234', 'noCredentials'],
    ['https://api.anthropic.com/v1', 'firstPartyAnthropic'],
    ['https://api-staging.anthropic.com', 'firstPartyAnthropic'],
  ])('rejects %j with %s', (value, errorKey) => {
    expect(validateAnthropicCompatibleBaseUrl(value, t)).toBe(
      `providerRuntime.compatibleEndpoint.validation.${errorKey}`
    );
  });

  it.each(['http://localhost:1234', 'https://gateway.example.com/anthropic'])(
    'accepts %s',
    (value) => {
      expect(validateAnthropicCompatibleBaseUrl(value, t)).toBeNull();
    }
  );
});
