import { createHash } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

import { managementValue } from './capturedManagementCatalog';

import type { CapturedProviderManagement } from '@features/agent-backend/main';

export interface CapturedClaudeAuthentication {
  readonly loggedIn: boolean;
  readonly authMethod: string;
  readonly canLogin: boolean;
  readonly canLogout: boolean;
}

/** Auth metadata is qualified independently of the SDK model catalog and model execution. */
export async function readCapturedClaudeAuthentication(
  selected: CapturedProviderManagement
): Promise<CapturedClaudeAuthentication> {
  const profileHash = createHash('sha256')
    .update(JSON.stringify([selected.profileId, selected.configRevision]))
    .digest('hex');
  const observe = (
    stage: 'request' | 'outcome' | 'decode' | 'current' | 'result',
    code: string,
    authMethod?: string
  ) => {
    try {
      createLogger('RuntimeProvider:ClaudeAuthentication').diagnostic('Claude auth stage', {
        profileHash,
        stage,
        code,
        ...(authMethod === undefined ? {} : { authMethod }),
      });
    } catch {
      /* Private observations never determine authentication or context authority. */
    }
  };
  let response;
  try {
    response = await selected.request('claude.auth', {});
  } catch (error) {
    observe('request', 'unavailable');
    throw error;
  }
  let raw: unknown;
  try {
    raw = managementValue(response);
  } catch (error) {
    const code =
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.ok === false &&
      typeof response.code === 'string' &&
      ['invalid', 'conflict', 'busy', 'held', 'unavailable'].includes(response.code)
        ? 'host.' + response.code
        : 'invalid-response';
    observe('outcome', code);
    throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    observe('decode', 'invalid-response');
    throw new Error('Claude auth state unavailable');
  }
  const value = raw as Record<string, unknown>;
  if (
    value.profileId !== selected.profileId ||
    value.configRevision !== selected.configRevision ||
    typeof value.loggedIn !== 'boolean' ||
    typeof value.canLogin !== 'boolean' ||
    typeof value.canLogout !== 'boolean' ||
    typeof value.authMethod !== 'string' ||
    !['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(
      value.authMethod
    )
  ) {
    observe('decode', 'invalid-response');
    throw new Error('Claude auth state unavailable');
  }
  let current;
  try {
    current = selected.isCurrent();
  } catch (error) {
    observe('current', 'unavailable');
    throw error;
  }
  if (!current) {
    observe('current', 'changed');
    throw new Error('Claude auth state unavailable');
  }
  observe('result', value.loggedIn ? 'logged-in' : 'logged-out', value.authMethod);
  return {
    loggedIn: value.loggedIn,
    authMethod: value.authMethod,
    canLogin: value.canLogin,
    canLogout: value.canLogout,
  };
}
