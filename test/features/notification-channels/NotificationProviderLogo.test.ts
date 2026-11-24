import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DELIVERY_PROVIDERS } from '@features/notification-channels/contracts';
import { describe, expect, it } from 'vitest';

describe('Bundled notification provider marks', () => {
  it('includes a safe local SVG for every supported provider', () => {
    for (const { id } of DELIVERY_PROVIDERS) {
      const svg = readFileSync(
        join('src/features/notification-channels/renderer/assets/provider-logos', `${id}.svg`),
        'utf8'
      );
      expect(svg).toContain('<svg');
      expect(svg).toMatch(/viewBox=/);
      expect(svg).not.toMatch(/<script|<foreignObject|<image|onload\s*=|onerror\s*=/i);
    }
  });
});
