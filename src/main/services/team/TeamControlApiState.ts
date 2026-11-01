import { randomUUID } from 'node:crypto';

import { API_AUTH_REFERENCE_ENV,type ApiAuthority } from '@features/local-http-auth/contracts';
import {
  apiProfileScope,
  checkApiReadiness,
  publishApiAuthority,
  removeApiAuthority,
} from '@features/local-http-auth/main';
import { getClaudeBasePath } from '@main/utils/pathDecoder';

const TOKEN_ENV = 'CLAUDE_TEAM_CONTROL_AUTH_TOKEN';
const instanceId = randomUUID();
let revision = 0;
let tail: Promise<void> = Promise.resolve();
let published: { root: string; authority: ApiAuthority } | null = null;

function enqueue(operation: () => Promise<void>): Promise<void> {
  const result = tail.then(operation);
  tail = result.catch(() => undefined);
  return result;
}

function revokeEnvironment(): void {
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  delete process.env[TOKEN_ENV];
  delete process.env[API_AUTH_REFERENCE_ENV];
}

export function buildTeamControlApiBaseUrl(port: number, host = '127.0.0.1'): string {
  const normalized = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${normalized.includes(':') ? `[${normalized}]` : normalized}:${port}`;
}

/** Publish only after authenticated ingress is ready; otherwise revoke discovery. */
export async function syncTeamControlApiAuthority(baseUrl: string | null, authToken: string | null): Promise<void> {
  if (!baseUrl || !authToken) {
    await clearTeamControlApiState();
    return;
  }
  await checkApiReadiness(baseUrl, authToken);
  await writeTeamControlApiState(baseUrl, authToken);
}

/** Publish immutable credentials and switch discovery under the cross-process publication lock. */
export function writeTeamControlApiState(baseUrl: string, authToken: string): Promise<void> {
  if (!/^\S{32,512}$/.test(authToken)) {
    return Promise.reject(
      new Error('Team control API auth token must be 32 to 512 non-whitespace characters')
    );
  }
  const root = getClaudeBasePath();
  const generation = ++revision;
  revokeEnvironment();
  return enqueue(async () => {
    const previous = published;
    const authority: ApiAuthority =
      previous?.root === root &&
      previous.authority.baseUrl === baseUrl &&
      previous.authority.token === authToken
        ? previous.authority
        : {
            schemaVersion: 1,
            service: 'api',
            profileScope: apiProfileScope(root),
            instanceId,
            generation: randomUUID(),
            baseUrl,
            token: authToken,
          };
    const reference = await publishApiAuthority(root, authority);
    published = { root, authority };
    if (previous && previous.authority !== authority) {
      await removeApiAuthority(previous.root, previous.authority);
    }
    if (generation !== revision) return;
    process.env.CLAUDE_TEAM_CONTROL_URL = baseUrl;
    process.env[TOKEN_ENV] = authToken;
    process.env[API_AUTH_REFERENCE_ENV] = reference;
  });
}

/** A stale instance may remove only the exact generation it published. */
export function clearTeamControlApiState(): Promise<void> {
  ++revision;
  revokeEnvironment();
  return enqueue(async () => {
    const owned = published;
    if (!owned) return;
    await removeApiAuthority(owned.root, owned.authority);
    if (published === owned) published = null;
  });
}
