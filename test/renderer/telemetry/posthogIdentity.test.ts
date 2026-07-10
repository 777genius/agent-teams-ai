import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestSentryContext = {
  userId: string;
  tags: Record<string, string>;
};

type TestPostHogEvent = {
  event: string;
  properties?: Record<string, unknown>;
};

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

async function loadPostHogModule() {
  vi.resetModules();
  return import('../../../src/renderer/posthog');
}

async function loadRendererTelemetryPipeline() {
  vi.resetModules();
  const telemetryModule = await import('../../../src/renderer/telemetry');
  const analyticsModule = await import('../../../src/renderer/analytics/productAnalytics');

  return {
    recordTaskCreate: analyticsModule.recordTaskCreate,
    syncRendererTelemetry: telemetryModule.syncRendererTelemetry,
  };
}

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

function lastCallOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const callOrder = mock.mock.invocationCallOrder;
  expect(callOrder.length).toBeGreaterThan(0);
  return callOrder[callOrder.length - 1] ?? 0;
}

function getPostHogBeforeSend(): (event: TestPostHogEvent | null) => TestPostHogEvent | null {
  const [, rawOptions] = posthogMock.init.mock.calls[0] ?? [];
  const options = rawOptions as
    | { before_send?: (event: TestPostHogEvent | null) => TestPostHogEvent | null }
    | undefined;
  expect(options?.before_send).toBeTypeOf('function');
  return options?.before_send as (event: TestPostHogEvent | null) => TestPostHogEvent | null;
}

describe('PostHog identity sync', () => {
  beforeEach(() => {
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
    clearElectronApiForTest();
  });

  it('does not initialize or capture before the app identity bridge is available', async () => {
    setElectronApiForTest({});
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);
    await Promise.resolve();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.setPersonProperties).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();

    posthogModule.capturePostHogEvent('task_management:task_create', { source: 'dialog' });
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it('bootstraps the stable app client id before capturing events', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });
    const posthogModule = await loadPostHogModule();
    posthogMock.setPersonProperties.mockImplementationOnce(() => {
      const beforeSend = getPostHogBeforeSend();
      const identifyEvent = { event: '$identify', properties: { distinct_id: 'stable-client-id' } };
      const setEvent = { event: '$set', properties: { distinct_id: 'stable-client-id' } };
      expect(beforeSend(identifyEvent)).toBeNull();
      expect(beforeSend(setEvent)).toBe(setEvent);
      expect(beforeSend({ event: '$identify', properties: { distinct_id: 'other-id' } })).toBeNull();
      expect(beforeSend({ event: '$set', properties: { distinct_id: 'other-id' } })).toBeNull();
      expect(beforeSend({ event: 'task_management:task_create' })).toBeNull();
    });

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });
    expect(posthogMock.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        bootstrap: {
          distinctID: 'stable-client-id',
          isIdentifiedID: true,
        },
        persistence_name: 'agent_teams_posthog_identity_v1',
      })
    );
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(lastCallOrder(posthogMock.opt_in_capturing)).toBeLessThan(
      lastCallOrder(posthogMock.setPersonProperties)
    );
    expect(lastCallOrder(posthogMock.setPersonProperties)).toBeLessThan(
      lastCallOrder(posthogMock.capture)
    );
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(posthogMock.capture).toHaveBeenCalledWith('app:session_start', {
      surface: 'renderer',
    });
    const beforeSend = getPostHogBeforeSend();
    const productEvent = { event: 'task_management:task_create' };
    expect(beforeSend(productEvent)).toBe(productEvent);

    posthogMock.capture.mockClear();
    posthogModule.capturePostHogEvent('task_management:task_create', { source: 'dialog' });

    expect(posthogMock.capture).toHaveBeenCalledWith('task_management:task_create', {
      source: 'dialog',
    });
  });

  it('ignores stale identity syncs so only the latest stable client id captures', async () => {
    const staleContext = createDeferred<TestSentryContext | null>();
    const currentContext = createDeferred<TestSentryContext | null>();
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi
          .fn()
          .mockReturnValueOnce(staleContext.promise)
          .mockReturnValueOnce(currentContext.promise),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);
    posthogModule.syncPostHogTelemetry(true);

    staleContext.resolve({
      userId: 'stale-client-id',
      tags: { identity_source: 'stale' },
    });
    await Promise.resolve();

    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.setPersonProperties).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();

    currentContext.resolve({
      userId: 'stable-client-id',
      tags: { identity_source: 'created' },
    });

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledTimes(1);
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.capture).toHaveBeenCalledTimes(1);
    expect(posthogMock.capture).toHaveBeenCalledWith('app:session_start', {
      surface: 'renderer',
    });
  });

  it('captures one app session start across repeated stable identity syncs', async () => {
    const getSentryContext = vi.fn().mockResolvedValue({
      userId: 'stable-client-id',
      tags: { identity_source: 'created' },
    });
    setElectronApiForTest({
      telemetry: {
        getSentryContext,
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledTimes(1);
    });

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(getSentryContext).toHaveBeenCalledTimes(2);
      expect(posthogMock.register).toHaveBeenCalledTimes(3);
    });
    const appSessionStartCalls = posthogMock.capture.mock.calls.filter(
      ([eventName]) => eventName === 'app:session_start'
    );
    expect(appSessionStartCalls).toHaveLength(1);
  });

  it('does not re-enable capture when telemetry is disabled during identity lookup', async () => {
    const pendingContext = createDeferred<TestSentryContext | null>();
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockReturnValue(pendingContext.promise),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);
    posthogModule.syncPostHogTelemetry(false);
    pendingContext.resolve({
      userId: 'stable-client-id',
      tags: { identity_source: 'created' },
    });
    await Promise.resolve();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogMock.reset).not.toHaveBeenCalled();
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.setPersonProperties).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it('does not initialize the sdk after a missing telemetry context', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue(null),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await Promise.resolve();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogMock.reset).not.toHaveBeenCalled();
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.setPersonProperties).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it('recovers from a temporary missing telemetry context on a later sync', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            userId: 'stable-client-id',
            tags: { identity_source: 'app-data' },
          }),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await Promise.resolve();
    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.reset).not.toHaveBeenCalled();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'app-data' })
      );
    });
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.capture).toHaveBeenCalledWith('app:session_start', {
      surface: 'renderer',
    });
  });

  it('resets and opts out after disabling an initialized sdk', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalled();
    });

    posthogModule.syncPostHogTelemetry(false);

    expect(lastCallOrder(posthogMock.reset)).toBeLessThan(lastCallOrder(posthogMock.opt_out_capturing));
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it('restores the stable client id before capturing after telemetry is re-enabled', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledTimes(1);
    });

    posthogModule.syncPostHogTelemetry(false);
    posthogMock.capture.mockClear();
    posthogMock.identify.mockClear();
    posthogMock.setPersonProperties.mockClear();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.identify).toHaveBeenCalledWith('stable-client-id');
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(lastCallOrder(posthogMock.identify)).toBeLessThan(
      lastCallOrder(posthogMock.opt_in_capturing)
    );
    expect(lastCallOrder(posthogMock.opt_in_capturing)).toBeLessThan(
      lastCallOrder(posthogMock.capture)
    );
    expect(posthogMock.capture).toHaveBeenCalledWith('app:session_start', {
      surface: 'renderer',
    });
  });

  it('overrides a stale identified id from sdk persistence before capture', async () => {
    posthogMock.init.mockImplementation(() => {
      posthogMock.get_distinct_id.mockReturnValue('old-identified-client-id');
    });
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });
    const posthogModule = await loadPostHogModule();

    posthogModule.syncPostHogTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.identify).toHaveBeenCalledWith('stable-client-id');
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });

    expect(lastCallOrder(posthogMock.reset)).toBeLessThan(lastCallOrder(posthogMock.identify));
    expect(lastCallOrder(posthogMock.identify)).toBeLessThan(
      lastCallOrder(posthogMock.opt_in_capturing)
    );
    expect(posthogMock.capture).toHaveBeenCalledWith('app:session_start', {
      surface: 'renderer',
    });
  });

  it('captures a product event through the renderer telemetry pipeline after stable identity', async () => {
    setElectronApiForTest({
      telemetry: {
        getSentryContext: vi.fn().mockResolvedValue({
          userId: 'stable-client-id',
          tags: { identity_source: 'created' },
        }),
      },
    });
    const { recordTaskCreate, syncRendererTelemetry } = await loadRendererTelemetryPipeline();

    syncRendererTelemetry(true);

    await vi.waitFor(() => {
      expect(posthogMock.setPersonProperties).toHaveBeenCalledWith(
        expect.objectContaining({ identity_source: 'created' })
      );
    });
    expect(posthogMock.identify).not.toHaveBeenCalled();

    posthogMock.capture.mockClear();
    recordTaskCreate({
      source: 'dialog',
      targetType: 'team',
      hasAttachments: true,
      hasTaskRefs: false,
      promptLength: 320,
      teamSize: 4,
    });

    expect(posthogMock.capture).toHaveBeenCalledWith('task_management:task_create', {
      source: 'dialog',
      target_type: 'team',
      has_attachments: true,
      has_task_refs: false,
      prompt_length_bucket: '201_1000',
      team_size_bucket: '2_5',
    });
  });
});
