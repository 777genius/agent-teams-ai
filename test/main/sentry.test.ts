import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  ipcMain: {
    removeAllListeners: vi.fn(),
  },
}));

vi.mock('electron', () => electronMock);

const requireFromTest = createRequire(import.meta.url);
let restoreCommonJsStubs: Array<() => void> = [];

function stubCommonJsModule(specifier: string, exports: unknown): void {
  const filename = requireFromTest.resolve(specifier);
  const previous = requireFromTest.cache[filename];
  requireFromTest.cache[filename] = {
    children: [],
    exports,
    filename,
    id: filename,
    isPreloading: false,
    loaded: true,
    parent: null,
    path: path.dirname(filename),
    paths: [],
    require: requireFromTest,
  };
  restoreCommonJsStubs.push(() => {
    if (previous) {
      requireFromTest.cache[filename] = previous;
    } else {
      delete requireFromTest.cache[filename];
    }
  });
}

const EXPECTED_SAFE_TAG_KEYS = [
  'app_name',
  'app_namespace',
  'app_version',
  'arch',
  'git_repository',
  'identity_source',
  'platform',
  'release',
  'release_channel',
];

describe('main Sentry telemetry gate', () => {
  let previousDsn: string | undefined;

  beforeEach(() => {
    previousDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    vi.resetModules();
    restoreCommonJsStubs = [];
    stubCommonJsModule('electron', electronMock);
  });

  afterEach(() => {
    for (const restore of restoreCommonJsStubs.reverse()) {
      restore();
    }
    if (previousDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = previousDsn;
    }
    vi.resetModules();
  });

  it('does not initialize Sentry when persisted telemetry config is disabled', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-sentry-config-'));
    fs.writeFileSync(
      path.join(tempRoot, 'agent-teams-config.json'),
      JSON.stringify({ general: { telemetryEnabled: false } }),
      'utf8'
    );

    const { setClaudeBasePathOverride } = await import('@main/utils/pathDecoder');
    setClaudeBasePathOverride(tempRoot);

    const sentrySdk = await import('@sentry/electron/main');
    const init = vi.mocked(sentrySdk.init);
    init.mockClear();

    const sentry = await import('@main/sentry');
    sentry.initializeMainSentry();

    expect(sentry.readPersistedTelemetryEnabled(tempRoot)).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(sentry.filterSentryEventForTelemetry({ ok: true })).toBeNull();
    const status = sentry.getMainSentryStatus();
    expect(status).toMatchObject({
      state: 'disabled',
      reason: 'telemetry-disabled',
      environment: expect.any(String),
    });
    expect(status.release === null || typeof status.release === 'string').toBe(true);

    setClaudeBasePathOverride(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses classic IPC so telemetry can be enabled after Electron is ready', async () => {
    const sentrySdk = await import('@sentry/electron/main');
    const init = vi.mocked(sentrySdk.init);
    init.mockClear();

    const sentry = await import('@main/sentry');
    sentry.setMainSentryLoaderForTesting(() => sentrySdk);
    sentry.initializeMainSentry();

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        ipcMode: sentrySdk.IPCMode.Classic,
      })
    );
  });

  it('reports an unconfigured status without exposing an invalid DSN', async () => {
    process.env.SENTRY_DSN = 'https://user:secret@private.example.com/not-a-project-id';

    const sentry = await import('@main/sentry');
    const status = sentry.getMainSentryStatus();

    expect(status).toMatchObject({
      state: 'unconfigured',
      reason: 'invalid-dsn',
      environment: expect.any(String),
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('private.example.com');
  });

  it('exposes a sanitized failed status when Sentry initialization throws', async () => {
    const sentrySdk = await import('@sentry/electron/main');
    const init = vi.mocked(sentrySdk.init);
    init.mockImplementationOnce(() => {
      throw new Error('secret DSN https://public:private@example.com/1');
    });

    const sentry = await import('@main/sentry');
    sentry.setMainSentryLoaderForTesting(() => sentrySdk);
    sentry.initializeMainSentry();
    const status = sentry.getMainSentryStatus();

    expect(status).toMatchObject({
      state: 'failed',
      reason: 'sdk-init-failed',
      environment: expect.any(String),
    });
    expect(status.release === null || typeof status.release === 'string').toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(JSON.stringify(status)).not.toContain('example.com');
  });

  it('distinguishes a sanitized SDK load failure from an init failure', async () => {
    const sentry = await import('@main/sentry');
    sentry.setMainSentryLoaderForTesting(() => {
      throw new Error('Cannot load /Users/alice/private-sentry-module');
    });

    sentry.initializeMainSentry();
    const status = sentry.getMainSentryStatus();

    expect(status).toMatchObject({
      state: 'failed',
      reason: 'sdk-load-failed',
    });
    expect(JSON.stringify(status)).not.toContain('alice');
    expect(JSON.stringify(status)).not.toContain('private-sentry-module');
  });

  it('captures an explicit main-process exception with a low-cardinality operation tag', async () => {
    const sentry = await import('@main/sentry');
    const error = new Error('startup failed');
    const sentryApi = {
      captureException: vi.fn(() => 'event-id'),
    };
    sentry.setMainSentryApiForTesting(sentryApi);

    const eventId = sentry.captureMainException(error, 'app-startup');

    expect(eventId).toBe('event-id');
    expect(sentryApi.captureException).toHaveBeenCalledWith(error, {
      tags: { 'error.operation': 'app-startup' },
    });
  });

  it('does not leak unbounded operation or thrown values into explicit capture metadata', async () => {
    const sentry = await import('@main/sentry');
    const sentryApi = {
      captureException: vi.fn(() => 'event-id'),
    };
    sentry.setMainSentryApiForTesting(sentryApi);

    sentry.captureMainException(
      { token: 'sk-testsecretsecretsecret' },
      'project /Users/alice/private-repo failed'
    );

    expect(sentryApi.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { 'error.operation': 'main_unknown' },
    });
    const serializedCall = JSON.stringify(sentryApi.captureException.mock.calls[0]);
    expect(serializedCall).not.toContain('sk-testsecretsecretsecret');
    expect(serializedCall).not.toContain('alice');
  });

  it('does not capture explicit exceptions after telemetry is disabled', async () => {
    const sentry = await import('@main/sentry');
    const sentryApi = {
      captureException: vi.fn(() => 'event-id'),
      close: vi.fn(() => Promise.resolve(true)),
      setUser: vi.fn(),
    };
    sentry.setMainSentryApiForTesting(sentryApi);
    sentry.syncTelemetryFlag(false);

    expect(sentry.captureMainException(new Error('ignored'), 'app-startup')).toBeUndefined();
    expect(sentryApi.captureException).not.toHaveBeenCalled();
  });

  it('cleans classic IPC listeners before closing and reinitializing Sentry', async () => {
    const sentrySdk = await import('@sentry/electron/main');
    const init = vi.mocked(sentrySdk.init);
    init.mockClear();
    init.mockImplementation(() => undefined);
    electronMock.ipcMain.removeAllListeners.mockClear();

    const sentry = await import('@main/sentry');
    sentry.setMainSentryLoaderForTesting(() => sentrySdk);
    sentry.initializeMainSentry();
    expect(init).toHaveBeenCalledOnce();

    sentry.syncTelemetryFlag(false);

    const removedChannels = electronMock.ipcMain.removeAllListeners.mock.calls.map(
      ([channel]) => channel
    );
    expect(removedChannels).toHaveLength(6);
    expect(removedChannels).toEqual(
      expect.arrayContaining([
        'sentry-ipc.start',
        'sentry-ipc.scope',
        'sentry-ipc.envelope',
        'sentry-ipc.structured-log',
        'sentry-ipc.metric',
        'sentry-ipc.status',
      ])
    );

    sentry.syncTelemetryFlag(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('clears user scope and drops events when telemetry is disabled', async () => {
    const sentry = await import('@main/sentry');
    const sentryApi = {
      setUser: vi.fn(),
      setTags: vi.fn(),
      close: vi.fn(() => Promise.resolve(true)),
    };
    sentry.setMainSentryApiForTesting(sentryApi);

    sentry.syncTelemetryFlag(false);

    expect(sentryApi.setUser).toHaveBeenCalledWith(null);
    expect(sentryApi.close).toHaveBeenCalled();
    expect(sentry.filterSentryEventForTelemetry({ ok: true })).toBeNull();
  });

  it('returns only hashed anonymous Sentry context when telemetry is enabled', async () => {
    const sentry = await import('@main/sentry');

    sentry.syncTelemetryFlag(true);
    const context = await sentry.getCurrentSentryTelemetryContext();

    expect(context?.userId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(context?.tags ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(
      EXPECTED_SAFE_TAG_KEYS
    );
  });

  it('fails telemetry closed without breaking startup when identity is unrecoverable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-sentry-identity-'));
    const { getAgentTeamsIdentityStorePath } =
      await import('@main/services/identity/AgentTeamsIdentityStore');
    const { setAppDataBasePath } = await import('@main/utils/pathDecoder');
    setAppDataBasePath(tempRoot);
    const storePath = getAgentTeamsIdentityStorePath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{not-json', 'utf8');

    try {
      const sentry = await import('@main/sentry');
      sentry.syncTelemetryFlag(true);

      await expect(sentry.getCurrentSentryTelemetryContext()).resolves.toBeNull();
      expect(fs.readFileSync(storePath, 'utf8')).toBe('{not-json');
    } finally {
      setAppDataBasePath(null);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not attach high-cardinality breadcrumb data', async () => {
    const sentry = await import('@main/sentry');
    const sentryApi = {
      addBreadcrumb: vi.fn(),
    };
    sentry.setMainSentryApiForTesting(sentryApi);

    sentry.addMainBreadcrumb('team', 'launch', { teamName: 'private-team-name' });

    expect(sentryApi.addBreadcrumb).toHaveBeenCalledWith({
      category: 'team',
      message: 'launch',
      level: 'info',
    });
  });

  it('redacts sensitive fields before allowing telemetry events', async () => {
    const sentry = await import('@main/sentry');

    sentry.syncTelemetryFlag(true);
    const filtered = sentry.filterSentryEventForTelemetry({
      message: 'Failed for user dev@example.com in /Users/alice/private-repo',
      extra: {
        projectPath: '/Users/alice/private-repo',
        token: 'sk-testsecretsecretsecret',
        accountUuid: 'd9b2d63a-582c-4d69-8a01-90e8199f532d',
      },
    });

    const serialized = JSON.stringify(filtered);
    expect(serialized).not.toContain('dev@example.com');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('sk-testsecretsecretsecret');
    expect(serialized).not.toContain('d9b2d63a-582c-4d69-8a01-90e8199f532d');
  });

  it('only exposes safe low-cardinality telemetry tags', async () => {
    const { getSafeSentryTelemetryTags } = await import('@main/sentry');

    expect(
      Object.keys(getSafeSentryTelemetryTags('app-data')).sort((a, b) => a.localeCompare(b))
    ).toEqual(EXPECTED_SAFE_TAG_KEYS);
  });
});
