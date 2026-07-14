import * as SentryElectron from '@sentry/electron/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMock = vi.hoisted(() => ({
  capture: vi.fn(),
  debug: vi.fn(),
  get_distinct_id: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  register: vi.fn(),
  reset: vi.fn(),
  setPersonProperties: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: posthogMock,
}));

function setElectronApiForTest(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value,
    writable: true,
  });
}

function clearElectronApiForTest(): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'electronAPI');
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function loadTelemetryModule() {
  vi.resetModules();
  return import('../../../src/renderer/telemetry');
}

describe('bootstrapRendererTelemetryFromConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('__OFFICIAL_POSTHOG_BUILD__', true);
    vi.useRealTimers();
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.com/1');
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com');
    for (const mock of Object.values(posthogMock)) {
      mock.mockClear();
    }
    posthogMock.init.mockImplementation((_, options?: { bootstrap?: { distinctID?: string } }) => {
      posthogMock.get_distinct_id.mockReturnValue(options?.bootstrap?.distinctID);
    });
    posthogMock.identify.mockImplementation((distinctId: string) => {
      posthogMock.get_distinct_id.mockReturnValue(distinctId);
    });
    posthogMock.reset.mockImplementation(() => {
      posthogMock.get_distinct_id.mockReturnValue('anonymous-after-reset');
    });
    vi.mocked(SentryElectron.init).mockClear();
    vi.mocked(SentryElectron.setUser).mockClear();
    vi.mocked(SentryElectron.setTags).mockClear();
    clearElectronApiForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enables renderer telemetry from persisted config during startup', async () => {
    setElectronApiForTest({
      config: {
        get: vi.fn().mockResolvedValue({ general: { telemetryEnabled: true } }),
      },
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });

    const telemetry = await loadTelemetryModule();

    await telemetry.bootstrapRendererTelemetryFromConfig();

    expect(SentryElectron.init).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(SentryElectron.setUser).toHaveBeenCalledWith({ id: 'stable-client-id' });
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });
    expect(posthogMock.identify).not.toHaveBeenCalled();
  });

  it('keeps renderer telemetry disabled when persisted config opts out', async () => {
    setElectronApiForTest({
      config: {
        get: vi.fn().mockResolvedValue({ general: { telemetryEnabled: false } }),
      },
      telemetry: {
        getSentryContext: vi.fn(),
      },
    });

    const telemetry = await loadTelemetryModule();

    await telemetry.bootstrapRendererTelemetryFromConfig();

    expect(SentryElectron.init).not.toHaveBeenCalled();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('keeps renderer telemetry closed when startup config cannot be read', async () => {
    setElectronApiForTest({
      config: {
        get: vi.fn().mockRejectedValue(new Error('config unavailable')),
      },
      telemetry: {
        getSentryContext: vi.fn(),
      },
    });

    const telemetry = await loadTelemetryModule();

    await telemetry.bootstrapRendererTelemetryFromConfig();

    expect(SentryElectron.init).not.toHaveBeenCalled();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('does not let a stale startup config response override a newer sync', async () => {
    const pendingConfig = createDeferred<{ general: { telemetryEnabled: boolean } }>();
    setElectronApiForTest({
      config: {
        get: vi.fn().mockReturnValue(pendingConfig.promise),
      },
      telemetry: {
        getSentryContext: vi.fn(),
      },
    });

    const telemetry = await loadTelemetryModule();
    const bootstrap = telemetry.bootstrapRendererTelemetryFromConfig();

    telemetry.syncRendererTelemetry(false);
    pendingConfig.resolve({ general: { telemetryEnabled: true } });
    await bootstrap;

    expect(SentryElectron.init).not.toHaveBeenCalled();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('retries Sentry identity when the early telemetry handler is not ready yet', async () => {
    vi.useFakeTimers();
    const getSentryContext = vi
      .fn()
      .mockRejectedValueOnce(new Error('No handler registered for telemetry:getSentryContext'))
      .mockResolvedValue({
        userId: 'stable-client-id',
        tags: { identity_source: 'created' },
      });
    setElectronApiForTest({
      config: {
        get: vi.fn().mockResolvedValue({ general: { telemetryEnabled: true } }),
      },
      telemetry: {
        getSentryContext,
      },
    });

    const telemetry = await loadTelemetryModule();

    await telemetry.bootstrapRendererTelemetryFromConfig();
    expect(SentryElectron.init).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);

    expect(getSentryContext).toHaveBeenCalledTimes(3);
    expect(SentryElectron.setUser).toHaveBeenCalledWith({ id: 'stable-client-id' });
    expect(SentryElectron.setTags).toHaveBeenCalledWith({ identity_source: 'created' });
  });
});
