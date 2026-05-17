import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  AGENT_TEAMS_IDENTITY_STORE_PATH_ENV,
  applyAgentTeamsIdentityEnv,
  ensureAgentTeamsClientIdentity,
  getAgentTeamsIdentityStorePath,
  getSentryAnonymousUserId,
  readAgentTeamsIdentityStore,
} from '@main/services/identity/AgentTeamsIdentityStore';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';

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

    expect(first.clientId).toMatch(UUID_PATTERN);
    expect(second.clientId).toBe(first.clientId);
    expect(first.source).toBe('created');
    expect(second.source).toBe('app-data');
    expect(persisted?.schemaVersion).toBe(1);
    expect(persisted?.clientId).toBe(first.clientId);
  });

  it('falls back safely when app-data JSON or UUID is invalid', async () => {
    const storePath = getAgentTeamsIdentityStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{not-json', 'utf8');

    const fromInvalidJson = await ensureAgentTeamsClientIdentity();
    expect(fromInvalidJson.clientId).toMatch(UUID_PATTERN);

    await fs.writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        clientId: 'not-a-uuid',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf8'
    );

    const fromInvalidUuid = await ensureAgentTeamsClientIdentity();
    expect(fromInvalidUuid.clientId).toMatch(UUID_PATTERN);
    expect(fromInvalidUuid.clientId).not.toBe('not-a-uuid');
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
