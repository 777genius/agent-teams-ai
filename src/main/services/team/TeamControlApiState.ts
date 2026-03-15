import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { rm } from 'fs/promises';
import path from 'path';

const logger = createLogger('Service:TeamControlApiState');

const TEAM_CONTROL_API_STATE_FILE = 'team-control-api.json';

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
  const statePath = getTeamControlApiStatePath();
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
  logger.info(`Published team control API endpoint: ${baseUrl}`);
}

export async function clearTeamControlApiState(): Promise<void> {
  const statePath = getTeamControlApiStatePath();
  await rm(statePath, { force: true }).catch(() => undefined);
}
