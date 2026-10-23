import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { rm } from 'fs/promises';
import path from 'path';

const logger = createLogger('Service:TeamControlApiState');

const TEAM_CONTROL_API_STATE_FILE = 'team-control-api.json';
const TEAM_CONTROL_API_AUTH_TOKEN_ENV = 'CLAUDE_TEAM_CONTROL_AUTH_TOKEN';
let publicationGeneration = 0;
let publicationTail: Promise<void> = Promise.resolve();

// Host start/stop/root-change callers must order disk publication as well as env updates.
function enqueuePublication(operation: () => Promise<void>): Promise<void> {
  const result = publicationTail.then(operation);
  publicationTail = result.catch(() => undefined);
  return result;
}

function normalizeBaseUrlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }

  return host;
}

export function buildTeamControlApiBaseUrl(port: number, host: string = '127.0.0.1'): string {
  return `http://${normalizeBaseUrlHost(host)}:${port}`;
}

function getTeamControlApiStatePath(): string {
  return path.join(getClaudeBasePath(), TEAM_CONTROL_API_STATE_FILE);
}

export async function writeTeamControlApiState(baseUrl: string, authToken: string): Promise<void> {
  if (!/^\S{32,512}$/.test(authToken)) {
    throw new Error('Team control API auth token must be 32 to 512 non-whitespace characters');
  }
  const generation = ++publicationGeneration;
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  delete process.env[TEAM_CONTROL_API_AUTH_TOKEN_ENV];
  const statePath = getTeamControlApiStatePath();
  await enqueuePublication(async () => {
    await atomicWriteAsync(
      statePath,
      JSON.stringify(
        {
          baseUrl,
          authToken,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600, directoryMode: 0o700 }
    );
    // Publish only committed Host state, never a configured port or a late stopped endpoint.
    if (generation !== publicationGeneration) return;
    process.env.CLAUDE_TEAM_CONTROL_URL = baseUrl;
    process.env[TEAM_CONTROL_API_AUTH_TOKEN_ENV] = authToken;
    logger.info(`Published team control API endpoint: ${baseUrl}`);
  });
}

export async function clearTeamControlApiState(): Promise<void> {
  publicationGeneration++;
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  delete process.env[TEAM_CONTROL_API_AUTH_TOKEN_ENV];
  const statePath = getTeamControlApiStatePath();
  await enqueuePublication(() => rm(statePath, { force: true }).catch(() => undefined));
}
