import {
  sanitizeRendererReactContext,
  sanitizeRendererUiContext,
} from '@renderer/utils/sentryDiagnostics';
import { redactSentryEvent } from '@shared/utils/sentryConfig';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Event = Record<string, unknown>;
interface Options {
  beforeSend: (event: Event) => Event | null;
  beforeSendTransaction: (event: Event) => Event | null;
}
const sdk = vi.hoisted(() => ({
  init: vi.fn<(options: Options) => void>(),
  setUser: vi.fn(),
  setTags: vi.fn(),
  captureException: vi.fn(),
  setContext: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
}));
vi.mock('@sentry/electron/renderer', () => sdk);

const intervalEvent = (): Event => ({
  event_id: 'same-event',
  exception: {
    values: [
      {
        type: 'Error',
        value: 'Minified React error #185; visit https://react.dev/errors/185',
        stacktrace: {
          frames: [{ function: 'dispatchSetState', filename: 'app:///renderer.js', lineno: 74 }],
        },
      },
    ],
  },
});

async function enable() {
  const sentry = await import('@renderer/sentry');
  sentry.syncRendererTelemetry(true);
  return { sentry, options: sdk.init.mock.calls[0]![0] };
}

describe('renderer update-depth diagnostics privacy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.com/1');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        telemetry: { getSentryContext: vi.fn().mockResolvedValue(null) },
      },
    });
    sdk.withScope.mockImplementation(
      (callback: (scope: { setContext: typeof sdk.setContext }) => void) =>
        callback({ setContext: sdk.setContext })
    );
  });

  it('retains static component names without sending component locations or dynamic names', async () => {
    const { sentry } = await enable();
    const error = new Error('Maximum update depth exceeded.');
    sentry.captureRendererException(error, {
      activeTabType: 'team',
      activeTabLabel: 'SecretProject',
      taskId: 'private-task',
      componentStack:
        '\n    at CurrentTaskIndicator (/Users/alice/secret.tsx:74:3)\n    at SecretProject42 (/home/bob/token.tsx:2:3)\n    at App (https://secret.example/token)',
    });
    expect(sdk.setContext).toHaveBeenCalledWith('react', {
      activeTabType: 'team',
      hasComponentStack: true,
      componentNames: ['CurrentTaskIndicator', 'App'],
    });
    expect(sdk.captureException).toHaveBeenCalledWith(error);
    expect(JSON.stringify(sdk.setContext.mock.calls)).not.toMatch(
      /SecretProject|private-task|alice|bob|secret\.example/
    );
    const event = { contexts: { react: sdk.setContext.mock.calls[0]![1] } };
    expect(redactSentryEvent(redactSentryEvent(event))).toEqual(event);
  });

  it('enriches an automatic interval error without changing its exception or grouping', async () => {
    const { sentry, options } = await enable();
    const collector = vi.fn(() => ({
      activeTabType: 'team',
      paneCount: 2,
      memberCount: 60,
      dialogCount: 1,
      rawText: 'private draft',
    }));
    sentry.setRendererErrorContextGetter(collector);
    const event = intervalEvent();
    const result = options.beforeSend(event)!;
    expect(collector).toHaveBeenCalledOnce();
    expect(result.exception).toEqual(event.exception);
    expect(result.event_id).toBe(event.event_id);
    expect(result).not.toHaveProperty('fingerprint');
    expect(result).not.toHaveProperty('message');
    expect(result).toMatchObject({
      contexts: {
        renderer_ui: { activeTabType: 'team', paneCount: 2, memberCount: 60, dialogCount: 1 },
      },
    });
    expect(event).not.toHaveProperty('contexts');
    expect(JSON.stringify(redactSentryEvent(result))).not.toContain('private draft');
    expect(redactSentryEvent(result)).toEqual(result);
    options.beforeSend({ exception: { values: [{ value: 'unrelated error' }] } });
    options.beforeSendTransaction({ ...event, type: 'transaction' });
    options.beforeSend({ ...event, type: 'transaction' });
    expect(collector).toHaveBeenCalledOnce();
    options.beforeSend({ exception: { values: [{ value: 'Maximum update depth exceeded.' }] } });
    expect(collector).toHaveBeenCalledTimes(2);
  });

  it('accepts only closed types, finite bounded counts and named booleans', () => {
    expect(
      sanitizeRendererUiContext({
        activeTabType: 'private-team',
        paneCount: -2,
        tabCount: 1e20,
        memberCount: 3.7,
        taskCount: NaN,
        dialogCount: Infinity,
        listboxCount: '4',
        textareaCount: 2,
        codeMirrorCount: 5,
        hasReview: 'private',
        hasTaskDetail: true,
        teamName: 'secret',
        label: 'secret',
        componentStack: 'secret',
      })
    ).toEqual({
      schemaVersion: 1,
      activeTabType: 'unknown',
      paneCount: 0,
      tabCount: 10000,
      memberCount: 3,
      taskCount: null,
      dialogCount: null,
      listboxCount: null,
      textareaCount: 2,
      codeMirrorCount: 5,
      hasReview: false,
      hasTaskDetail: true,
    });
    const context = sanitizeRendererReactContext({
      activeTabType: 'SecretProject',
      componentStack:
        '\n at MemberCard (/private/path)\n at App-Secret\n at AppSecret\n at /home/MemberList\n at token_sk_secret',
    });
    expect(context).toEqual({
      activeTabType: 'unknown',
      hasComponentStack: true,
      componentNames: ['MemberCard'],
    });
    expect(
      sanitizeRendererReactContext({ componentStack: '\n at App'.repeat(10000) })
    ).toMatchObject({ componentNames: Array(32).fill('App') });
  });

  it('does not collect or capture while opted out before or after initialization', async () => {
    const sentry = await import('@renderer/sentry');
    const collector = vi.fn(() => ({ paneCount: 1 }));
    sentry.setRendererErrorContextGetter(collector);
    sentry.syncRendererTelemetry(false);
    sentry.captureRendererException(new Error('Maximum update depth exceeded'));
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
    sentry.syncRendererTelemetry(true);
    const options = sdk.init.mock.calls[0]![0];
    sentry.syncRendererTelemetry(false);
    expect(options.beforeSend(intervalEvent())).toBeNull();
    expect(options.beforeSendTransaction({ type: 'transaction' })).toBeNull();
    sentry.captureRendererException(new Error('Maximum update depth exceeded'));
    sentry.addNavigationBreadcrumb('team', 'session');
    expect(collector).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(sdk.withScope).not.toHaveBeenCalled();
    expect(sdk.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('reports the original event even when the diagnostic getter throws', async () => {
    const { sentry, options } = await enable();
    sentry.setRendererErrorContextGetter(() => {
      throw new Error('private collector details');
    });
    const event = intervalEvent();
    expect(options.beforeSend(event)).toEqual(event);
  });

  it('records only closed tab types in navigation breadcrumbs', async () => {
    const { sentry } = await enable();
    sentry.addNavigationBreadcrumb('team', 'session');
    expect(sdk.addBreadcrumb).toHaveBeenLastCalledWith({
      category: 'navigation',
      message: 'tab-change',
      level: 'info',
      data: { fromTabType: 'team', toTabType: 'session' },
    });
    sentry.addNavigationBreadcrumb('SecretProject', '/Users/alice/private');
    expect(sdk.addBreadcrumb).toHaveBeenLastCalledWith({
      category: 'navigation',
      message: 'tab-change',
      level: 'info',
      data: { fromTabType: 'unknown', toTabType: 'unknown' },
    });
  });
});
