import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { normalizeTokenUsageSnapshot } from '../../contracts';

import { GatewayUsageStatus } from './GatewayUsageStatus';

function render(fields: Record<string, unknown> = {}): string {
  const snapshot = normalizeTokenUsageSnapshot({
    updatedAt: '2026-10-20T12:00:00Z',
    ...fields,
  });
  return renderToStaticMarkup(
    <GatewayUsageStatus snapshot={snapshot} locale="en-US" t={(key) => key} />
  );
}

describe('gateway dashboard import status', () => {
  it('keeps ordinary dashboards free of gateway status, even when another source is degraded', () => {
    expect(render({ degraded: true })).toBe('');
  });

  it('shows pending gateway imports before any usage events exist', () => {
    const html = render({ gatewaySourceCount: 1, degraded: true });
    expect(html).toContain('tokenUsage.gateway.dailyGranularity');
    expect(html).toContain('tokenUsage.gateway.noConfirmedImport');
    expect(html).not.toContain('<time');
  });

  it('preserves gateway metadata through normalization and renders its timestamp in UTC', () => {
    const html = render({
      gatewaySourceCount: 2,
      gatewayLastSuccessfulAt: '2026-10-20T23:45:00-05:00',
    });
    expect(html).toContain('tokenUsage.gateway.lastSuccessfulImport');
    expect(html).toContain('Oct 21, 2026, 4:45 AM');
    expect(html).toContain(' UTC');
    expect(html).toContain('dateTime="2026-10-20T23:45:00-05:00"');
  });

  it('treats invalid timestamps as unconfirmed instead of crashing the dashboard', () => {
    expect(render({ gatewaySourceCount: 1, gatewayLastSuccessfulAt: 'invalid' })).toContain(
      'tokenUsage.gateway.noConfirmedImport'
    );
  });
});
