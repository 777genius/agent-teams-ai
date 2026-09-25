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

type TeamControlApiEnsurer = () => Promise<string | null>;
let controlApiEnsurer: TeamControlApiEnsurer | null = null;

/** Registers the Host's start-and-publish resolver; returns it for inline registration. */
export function registerTeamControlApiEnsurer<T extends TeamControlApiEnsurer>(ensure: T): T {
  controlApiEnsurer = ensure;
  return ensure;
}

/**
 * The control URL is part of the OpenCode app MCP config, and so of the pinned
 * profile scope and host identity. Every OpenCode bridge command, launch as
 * well as later delivery, must therefore see the same committed endpoint
 * instead of whatever happened to be published at that moment.
 */
export async function ensureTeamControlApiBaseUrl(): Promise<string | null> {
  const published = process.env.CLAUDE_TEAM_CONTROL_URL?.trim();
  if (published || !controlApiEnsurer) return published || null;
  try {
    return (await controlApiEnsurer())?.trim() || null;
  } catch (error) {
    logger.warn(
      `Team control API is unavailable for OpenCode: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
