import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const posthogSourcePath = resolve(process.cwd(), 'src/renderer/posthog.ts');

function readPostHogSource(): string {
  return readFileSync(posthogSourcePath, 'utf8');
}

describe('PostHog renderer configuration', () => {
  it('keeps remote script features disabled for the packaged Electron CSP', () => {
    const source = readPostHogSource();

    expect(source).toContain('disable_external_dependency_loading: true');
    expect(source).toContain('advanced_disable_flags: true');
    expect(source).toContain('advanced_disable_feature_flags: true');
    expect(source).toContain('advanced_disable_feature_flags_on_first_load: true');
    expect(source).toContain('disable_surveys: true');
    expect(source).toContain('disable_surveys_automatic_display: true');
    expect(source).toContain('disable_product_tours: true');
    expect(source).toContain('capture_dead_clicks: false');
  });
});
