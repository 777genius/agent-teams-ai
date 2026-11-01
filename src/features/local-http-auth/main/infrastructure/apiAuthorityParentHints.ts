import { createHash } from 'node:crypto';

import { API_AUTH_REFERENCE_ENV, type ApiAuthority } from '../../contracts';

import { apiReferencePath } from './authorityPaths';

const TOKEN_ENV = 'CLAUDE_TEAM_CONTROL_AUTH_TOKEN';
let epoch = {};
let selected: { root: string; identity: string; epoch: object } | undefined;
function identity(authority: ApiAuthority): string {
  return createHash('sha256').update(JSON.stringify(authority)).digest('hex');
}
function environment(): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        process.env[API_AUTH_REFERENCE_ENV],
        process.env.CLAUDE_TEAM_CONTROL_URL,
        process.env[TOKEN_ENV],
      ]),
    )
    .digest('hex');
}
export function revokeApiAuthorityHints(): void {
  epoch = {};
  selected = undefined;
  delete process.env.CLAUDE_TEAM_CONTROL_URL;
  delete process.env[TOKEN_ENV];
  delete process.env[API_AUTH_REFERENCE_ENV];
}
export function selectApiAuthorityHints(
  root: string,
  authority: ApiAuthority,
  reference: string,
): void {
  epoch = {};
  selected = { root, identity: identity(authority), epoch };
  process.env.CLAUDE_TEAM_CONTROL_URL = authority.baseUrl;
  process.env[TOKEN_ENV] = authority.token;
  process.env[API_AUTH_REFERENCE_ENV] = reference;
}
export function captureApiAuthorityHintRevocation(
  root: string,
  authority: ApiAuthority,
): () => void {
  const before = selected;
  const beforeEnvironment = environment();
  return () => {
    if (
      before &&
      selected === before &&
      epoch === before.epoch &&
      before.root === root &&
      before.identity === identity(authority) &&
      environment() === beforeEnvironment &&
      process.env[API_AUTH_REFERENCE_ENV] ===
        apiReferencePath(root, authority.instanceId)
    )
      revokeApiAuthorityHints();
  };
}
