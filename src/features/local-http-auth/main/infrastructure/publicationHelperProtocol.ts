import path from 'node:path';

import { validateAuthority } from '../../core/domain/authority';

import { apiProfileScope } from './authorityPaths';

import type { ApiAuthority } from '../../contracts';

export const MAX_HELPER_FRAME = 32_768;
export const HELPER_MARKER = '--local-http-auth-publication-helper-v1';
export type HelperMode = 'node' | 'electron-node';
export interface PublicationRequest {
  v: 1;
  id: string;
  op: 'publish' | 'remove';
  root: string;
  rootMode: 'existing' | 'prepare-standalone-private';
  authority: ApiAuthority;
}
export interface PublicationOutcome {
  code:
    | 'none'
    | 'storage-failed'
    | 'immutable-generation'
    | 'retained-discovery';
  outcome: 'published' | 'removed' | 'retained' | 'failed';
  hintAction: 'keep' | 'revoke-matching';
}
export interface HelperReady {
  v: 1;
  kind: 'ready';
  buildId: string;
  mode: HelperMode;
}
export interface HelperResult extends PublicationOutcome {
  v: 1;
  kind: 'result';
  id: string;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid helper message');
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    throw new Error('Invalid helper message');
  return result;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}
export function parsePublicationRequest(value: unknown): PublicationRequest {
  const r = record(value, ['v', 'id', 'op', 'root', 'rootMode', 'authority']);
  if (
    r.v !== 1 ||
    !identifier(r.id) ||
    (r.op !== 'publish' && r.op !== 'remove') ||
    typeof r.root !== 'string' ||
    r.root.length > 8_192 ||
    !path.isAbsolute(r.root) ||
    path.resolve(r.root) !== r.root ||
    (r.rootMode !== 'existing' &&
      r.rootMode !== 'prepare-standalone-private') ||
    (r.op === 'remove' && r.rootMode !== 'existing')
  )
    throw new Error('Invalid helper request');
  record(r.authority, [
    'schemaVersion',
    'service',
    'profileScope',
    'instanceId',
    'generation',
    'baseUrl',
    'token',
  ]);
  const authority = validateAuthority(r.authority, apiProfileScope(r.root));
  // An explicit snapshot prevents mutation of caller objects after admission.
  return {
    v: 1,
    id: r.id,
    op: r.op,
    root: r.root,
    rootMode: r.rootMode,
    authority: { ...authority },
  };
}
export function parseReady(value: unknown): HelperReady {
  const r = record(value, ['v', 'kind', 'buildId', 'mode']);
  if (
    r.v !== 1 ||
    r.kind !== 'ready' ||
    !identifier(r.buildId) ||
    (r.mode !== 'node' && r.mode !== 'electron-node')
  )
    throw new Error('Invalid helper ready');
  return r as unknown as HelperReady;
}
export function parseResult(
  value: unknown,
  request: PublicationRequest,
): HelperResult {
  const r = record(value, ['v', 'kind', 'id', 'outcome', 'hintAction', 'code']);
  if (
    ![
      'none',
      'storage-failed',
      'immutable-generation',
      'retained-discovery',
    ].includes(String(r.code)) ||
    (r.outcome === 'failed'
      ? !['storage-failed', 'immutable-generation'].includes(String(r.code))
      : r.code !==
        (r.outcome === 'retained' ? 'retained-discovery' : 'none')) ||
    r.v !== 1 ||
    r.kind !== 'result' ||
    r.id !== request.id ||
    !['published', 'removed', 'retained', 'failed'].includes(
      String(r.outcome),
    ) ||
    !['keep', 'revoke-matching'].includes(String(r.hintAction)) ||
    (request.op === 'remove' &&
      ['published', 'retained'].includes(String(r.outcome))) ||
    (request.op === 'publish' && r.outcome === 'removed') ||
    (r.hintAction === 'revoke-matching' &&
      !['removed', 'failed'].includes(String(r.outcome)))
  )
    throw new Error('Invalid helper result');
  return r as unknown as HelperResult;
}
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > MAX_HELPER_FRAME)
    throw new Error('Invalid helper frame');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
/** Single-use streams are bounded even when a peer never completes a frame. */
export class HelperFrames {
  private pending = Buffer.alloc(0);
  private count = 0;
  constructor(private readonly maximum: number) {}
  push(chunk: Buffer): unknown[] {
    if (
      this.pending.length + chunk.length >
      (MAX_HELPER_FRAME + 4) * this.maximum
    )
      throw new Error('Invalid helper frame');
    this.pending = Buffer.concat([this.pending, chunk]);
    const values: unknown[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32BE(0);
      if (!size || size > MAX_HELPER_FRAME || this.count >= this.maximum)
        throw new Error('Invalid helper frame');
      if (this.pending.length < size + 4) break;
      const body = this.pending.subarray(4, size + 4);
      // Reject invalid UTF-8 instead of accepting replacement-character normalization.
      const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
      values.push(JSON.parse(json) as unknown);
      this.count++;
      this.pending = this.pending.subarray(size + 4);
    }
    return values;
  }
  end(expected: number): void {
    if (this.pending.length || this.count !== expected)
      throw new Error('Incomplete helper protocol');
  }
}
