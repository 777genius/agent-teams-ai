import {
  AGENT_TEAMS_IDENTITY_STORE_PATH_ENV,
  applyAgentTeamsIdentityEnv,
  ensureAgentTeamsClientIdentity,
  getAgentTeamsIdentityStorePath,
  getSentryAnonymousUserId,
  readAgentTeamsIdentityStore,
} from '@main/services/identity/AgentTeamsIdentityStore';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const LEGACY_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('AgentTeamsIdentityStore', () => {
  let tempRoot: string;
  let tempHome: string;
  let tempAppDataBase: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-identity-'));
    tempHome = path.join(tempRoot, 'home');
    tempAppDataBase = path.join(tempRoot, 'app-user-data');
    await fs.mkdir(tempHome, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    setClaudeBasePathOverride(null);
    setAppDataBasePath(tempAppDataBase);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates and reuses a stable app-data UUID', async () => {
    const first = await ensureAgentTeamsClientIdentity();
    const second = await ensureAgentTeamsClientIdentity();
    const persisted = await readAgentTeamsIdentityStore();
    const recovery = JSON.parse(
      await fs.readFile(`${getAgentTeamsIdentityStorePath()}.recovery`, 'utf8')
    ) as Record<string, unknown>;

    expect(first.clientId).toMatch(UUID_PATTERN);
    expect(second.clientId).toBe(first.clientId);
    expect(first.source).toBe('created');
    expect(second.source).toBe('app-data');
    expect(persisted?.schemaVersion).toBe(1);
    expect(persisted?.clientId).toBe(first.clientId);
    expect(recovery).toMatchObject({ schemaVersion: 1, clientId: first.clientId });
    expect(recovery).not.toHaveProperty('session');
    expect(recovery).not.toHaveProperty('capabilities');
  });

  it('deduplicates concurrent first-run identity creation', async () => {
    const results = await Promise.all([
      ensureAgentTeamsClientIdentity(),
      ensureAgentTeamsClientIdentity(),
      ensureAgentTeamsClientIdentity(),
      ensureAgentTeamsClientIdentity(),
    ]);
    const persisted = await readAgentTeamsIdentityStore();
    const clientIds = new Set(results.map((result) => result.clientId));

    expect(clientIds.size).toBe(1);
    expect([...clientIds][0]).toBe(persisted?.clientId);
    expect(results[0]?.source).toBe('created');
    expect(results.slice(1).every((result) => result.clientId === results[0]?.clientId)).toBe(true);
  });

  it('recovers from a stale cross-process identity creation lock', async () => {
    const storePath = getAgentTeamsIdentityStorePath();
    const lockPath = `${storePath}.lock`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 123,
        token: 'stale-lock',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      'utf8'
    );
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    const identity = await ensureAgentTeamsClientIdentity();
    const persisted = await readAgentTeamsIdentityStore();

    expect(identity.clientId).toMatch(UUID_PATTERN);
    expect(identity.clientId).toBe(persisted?.clientId);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the same client id from the recovery snapshot when the primary JSON is invalid', async () => {
    const original = await ensureAgentTeamsClientIdentity();
    const storePath = getAgentTeamsIdentityStorePath();
    await fs.writeFile(storePath, '{not-json', 'utf8');

    const recovered = await ensureAgentTeamsClientIdentity();
    const persisted = await readAgentTeamsIdentityStore();

    expect(recovered).toMatchObject({ clientId: original.clientId, source: 'app-data' });
    expect(persisted?.clientId).toBe(original.clientId);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    [
      'invalid UUID',
      JSON.stringify({
        schemaVersion: 1,
        clientId: 'not-a-uuid',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ],
  ])('fails closed for %s without replacing an unrecoverable identity', async (_label, raw) => {
    const storePath = getAgentTeamsIdentityStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, raw, 'utf8');

    await expect(ensureAgentTeamsClientIdentity()).rejects.toThrow(
      'identity store is invalid and no recovery identity is available'
    );
    expect(await fs.readFile(storePath, 'utf8')).toBe(raw);
    await expect(fs.stat(`${storePath}.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an invalid primary store from the legacy identity without minting a UUID', async () => {
    const storePath = getAgentTeamsIdentityStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{not-json', 'utf8');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({
        agentTeams: {
          clientId: LEGACY_CLIENT_ID,
        },
      }),
      'utf8'
    );

    const recovered = await ensureAgentTeamsClientIdentity();

    expect(recovered).toMatchObject({
      clientId: LEGACY_CLIENT_ID,
      source: 'legacy-global-config',
    });
    expect((await readAgentTeamsIdentityStore())?.clientId).toBe(LEGACY_CLIENT_ID);
  });

  it('soft-migrates legacy ~/.claude.json agentTeams into app data', async () => {
    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({
        agentTeams: {
          clientId: LEGACY_CLIENT_ID,
          session: {
            accessToken: 'legacy-access',
            refreshToken: 'legacy-refresh',
          },
          capabilities: {
            token: 'legacy-capabilities',
          },
        },
      }),
      'utf8'
    );

    const identity = await ensureAgentTeamsClientIdentity();
    const persisted = await readAgentTeamsIdentityStore();
    const legacy = JSON.parse(await fs.readFile(path.join(tempHome, '.claude.json'), 'utf8')) as {
      agentTeams?: { clientId?: string };
    };

    expect(identity).toMatchObject({
      clientId: LEGACY_CLIENT_ID,
      source: 'legacy-global-config',
    });
    expect(persisted?.clientId).toBe(LEGACY_CLIENT_ID);
    expect(legacy.agentTeams?.clientId).toBe(LEGACY_CLIENT_ID);
  });

  it('builds deterministic Sentry-safe anonymous user ids', () => {
    const hashed = getSentryAnonymousUserId(LEGACY_CLIENT_ID);

    expect(hashed).toBe(getSentryAnonymousUserId(LEGACY_CLIENT_ID));
    expect(hashed).not.toBe(LEGACY_CLIENT_ID);
    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sets the orchestrator identity store env path', () => {
    const env: NodeJS.ProcessEnv = {};

    applyAgentTeamsIdentityEnv(env);

    expect(env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]).toBe(getAgentTeamsIdentityStorePath());
  });
});
