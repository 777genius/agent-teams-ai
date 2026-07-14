import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

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
  });

  afterEach(() => {
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

    expect(sentry.readPersistedTelemetryEnabled(tempRoot)).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(sentry.filterSentryEventForTelemetry({ ok: true })).toBeNull();

    setClaudeBasePathOverride(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
