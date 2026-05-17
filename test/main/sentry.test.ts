import { vi } from 'vitest';

describe('main Sentry telemetry gate', () => {
  let previousDsn: string | undefined;

  beforeEach(() => {
    previousDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    vi.resetModules();
  });

  afterEach(() => {
    if (previousDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = previousDsn;
    }
    vi.resetModules();
  });

  it('clears user scope and drops events when telemetry is disabled', async () => {
    const sentry = await import('@main/sentry');
    const sentryApi = {
      setUser: vi.fn(),
      setTags: vi.fn(),
    };
    sentry.setMainSentryApiForTesting(sentryApi);

    sentry.syncTelemetryFlag(false);

    expect(sentryApi.setUser).toHaveBeenCalledWith(null);
    expect(sentry.filterSentryEventForTelemetry({ ok: true })).toBeNull();
  });

  it('only exposes safe low-cardinality telemetry tags', async () => {
    const { getSafeSentryTelemetryTags } = await import('@main/sentry');

    expect(
      Object.keys(getSafeSentryTelemetryTags('app-data')).sort((a, b) => a.localeCompare(b))
    ).toEqual(['app_version', 'arch', 'identity_source', 'platform']);
  });
});
