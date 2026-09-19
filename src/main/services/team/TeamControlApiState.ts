import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { rm } from 'fs/promises';
import path from 'path';

const logger = createLogger('Service:TeamControlApiState');

const TEAM_CONTROL_API_STATE_FILE = 'team-control-api.json';
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

export async function writeTeamControlApiState(baseUrl: string): Promise<void> {
  const generation = ++publicationGeneration;
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  const statePath = getTeamControlApiStatePath();
  await enqueuePublication(async () => {
    await atomicWriteAsync(
      statePath,
      JSON.stringify(
        {
          baseUrl,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    // Publish only committed Host state, never a configured port or a late stopped endpoint.
    if (generation !== publicationGeneration) return;
    process.env.CLAUDE_TEAM_CONTROL_URL = baseUrl;
    logger.info(`Published team control API endpoint: ${baseUrl}`);
  });
}

export async function clearTeamControlApiState(): Promise<void> {
  publicationGeneration++;
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  const statePath = getTeamControlApiStatePath();
  await enqueuePublication(() => rm(statePath, { force: true }).catch(() => undefined));
}
