import { describe, expect, it } from 'vitest';

import { isTrustedRenderer } from '../../../src/features/pr-monitor/main/infrastructure/trustedRenderer';

describe('intended Electron document', () => {
  it('allows only the configured origin and document, preserving hash navigation', () => {
    expect(isTrustedRenderer('http://localhost:5173/#tab', 'http://localhost:5173')).toBe(true);
    expect(isTrustedRenderer('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
    expect(isTrustedRenderer('https://evil.example/', 'http://localhost:5173')).toBe(false);
    expect(
      isTrustedRenderer('file:///app/renderer/index.html#tab', 'file:///app/renderer/index.html')
    ).toBe(true);
    expect(
      isTrustedRenderer(
        'file://evil.example/app/renderer/index.html',
        'file:///app/renderer/index.html'
      )
    ).toBe(false);
    expect(
      isTrustedRenderer('other:/app/renderer/index.html', 'file:///app/renderer/index.html')
    ).toBe(false);
  });
});
