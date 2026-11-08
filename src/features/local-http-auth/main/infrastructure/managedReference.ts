import path from 'node:path';

import { API_AUTH_REFERENCE_ENV } from '../../contracts';

/** Project only the current publisher's endpoint-bound private reference into a managed child. */
export function applyApiAuthReference(
  env: Record<string, string | undefined>,
  root: string,
  baseUrl: string | null | undefined
): void {
  const reference = process.env[API_AUTH_REFERENCE_ENV];
  delete env[API_AUTH_REFERENCE_ENV];
  delete env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN;
  delete env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF;
  if (
    baseUrl &&
    baseUrl === process.env.CLAUDE_TEAM_CONTROL_URL &&
    reference &&
    path.dirname(reference) === path.join(root, 'local-http-auth') &&
    /^api-[a-f0-9-]{36}\.ref\.json$/.test(path.basename(reference))
  ) {
    env[API_AUTH_REFERENCE_ENV] = reference;
  }
}
