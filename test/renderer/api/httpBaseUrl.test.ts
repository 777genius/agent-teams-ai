import { describe, expect, it } from 'vitest';

import { resolveHttpBaseUrl } from '@renderer/api/httpBaseUrl';

describe('browser HTTP API base URL', () => {
  it('preserves the exact valid loopback origin when port matches', () => {
    expect(resolveHttpBaseUrl('http://localhost:3456', '?port=3456')).toBe(
      'http://localhost:3456'
    );
    expect(resolveHttpBaseUrl('http://127.0.0.1:3456', '?port=3456')).toBe(
      'http://127.0.0.1:3456'
    );
  });

  it('uses the explicit loopback API for different-origin Vite pages', () => {
    expect(resolveHttpBaseUrl('http://localhost:5173', '?port=3456')).toBe(
      'http://127.0.0.1:3456'
    );
    expect(resolveHttpBaseUrl('https://example.org', '?port=3456')).toBe(
      'http://127.0.0.1:3456'
    );
  });

  it('keeps standalone same-origin and rejects invalid explicit ports', () => {
    expect(resolveHttpBaseUrl('http://localhost:3456', '')).toBe('http://localhost:3456');
    expect(resolveHttpBaseUrl('http://localhost:3456', '?port=99999')).toBe(
      'http://localhost:3456'
    );
    expect(resolveHttpBaseUrl('http://localhost:3456', '?port=nope')).toBe(
      'http://localhost:3456'
    );
    expect(resolveHttpBaseUrl('http://localhost', '?port=80')).toBe('http://localhost');
  });
});
