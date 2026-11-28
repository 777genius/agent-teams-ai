import { realpathSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

import { ManagementCommandError } from '../../management/commandRecords.js';

export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod:
    | 'none'
    | 'claude.ai'
    | 'oauth_token'
    | 'api_key'
    | 'api_key_helper'
    | 'third_party';
  readonly forcedLoginMethod: 'claudeai' | 'console' | 'gateway' | null;
}

/** Native status is evidence only for the exact captured config directory. */
export function parseClaudeAuthStatus(
  stdout: string,
  exitCode: number | null,
  configDirectory: string
): ClaudeAuthStatus {
  if (Buffer.byteLength(stdout) > 64 * 1024) throw new ManagementCommandError('held');
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ManagementCommandError('held');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagementCommandError('held');
  const row = value as Record<string, unknown>;
  if (
    typeof row.loggedIn !== 'boolean' ||
    !['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(
      String(row.authMethod)
    ) ||
    row.apiProvider !== 'firstParty' ||
    typeof row.configDirectory !== 'string' ||
    row.configDirectory !== configDirectory ||
    realpathSync(row.configDirectory) !== configDirectory ||
    exitCode !== (row.loggedIn ? 0 : 1) ||
    (row.loggedIn === false && row.authMethod !== 'none') ||
    (row.loggedIn === true && row.authMethod === 'none') ||
    (row.forcedLoginMethod !== undefined &&
      !['claudeai', 'console', 'gateway'].includes(String(row.forcedLoginMethod)))
  )
    throw new ManagementCommandError('held');
  return {
    loggedIn: row.loggedIn,
    authMethod: row.authMethod as ClaudeAuthStatus['authMethod'],
    forcedLoginMethod: (row.forcedLoginMethod ?? null) as ClaudeAuthStatus['forcedLoginMethod'],
  };
}

/** Read only the pinned CLI's sign-in prompt; arbitrary diagnostic URLs are not authorization. */
export function readClaudeAuthorizationUrl(output: string): string | undefined {
  // Strip terminal styling and OSC hyperlinks without forwarding native output to the UI.
  const text = stripVTControlCharacters(output);
  const match = /(?:If the browser didn't open, visit:|Sign in at:)\s+(https:\/\/[^\s<>]+)/u.exec(
    text
  );
  if (!match) return undefined;
  const url = new URL(match[1]!);
  if (url.username || url.password || url.protocol !== 'https:' || url.href.length > 16384)
    throw new ManagementCommandError('held');
  return url.href;
}
