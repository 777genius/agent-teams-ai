import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { apiProfileScope } from '../../../src/features/local-http-auth/main/infrastructure/authorityPaths';
import {
  encodeFrame,
  HelperFrames,
  parsePublicationRequest,
  parseResult,
} from '../../../src/features/local-http-auth/main/infrastructure/publicationHelperProtocol';

const request = () => ({
  v: 1,
  id: randomUUID(),
  op: 'publish',
  root: '/private/profile',
  rootMode: 'existing',
  authority: {
    schemaVersion: 1,
    service: 'api',
    profileScope: apiProfileScope('/private/profile'),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl: 'http://127.0.0.1:1234',
    token: 'x'.repeat(32),
  },
});
describe('private publication protocol', () => {
  it('snapshots authority before caller mutation and rejects unknown secret-bearing keys', () => {
    const input = request();
    const parsed = parsePublicationRequest(input);
    input.authority.token = 'y'.repeat(32);
    expect(parsed.authority.token).toBe('x'.repeat(32));
    expect(() =>
      parsePublicationRequest({ ...input, argv: input.authority.token }),
    ).toThrow();
    expect(() =>
      parsePublicationRequest({
        ...input,
        authority: { ...input.authority, extra: true },
      }),
    ).toThrow();
  });
  it('accepts fragmented frames but rejects truncation, extra messages, and invalid UTF8', () => {
    const decoder = new HelperFrames(1);
    const frame = encodeFrame(request());
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toHaveLength(1);
    decoder.end(1);
    expect(() => decoder.push(frame)).toThrow();
    const partial = new HelperFrames(1);
    partial.push(frame.subarray(0, -1));
    expect(() => partial.end(1)).toThrow();
    expect(() =>
      new HelperFrames(1).push(Buffer.from([0, 0, 0, 1, 255])),
    ).toThrow();
  });
  it('correlates operation/id and allows only fixed outcome/evidence', () => {
    const input = parsePublicationRequest(request());
    const result = {
      v: 1,
      kind: 'result',
      id: input.id,
      outcome: 'retained',
      code: 'retained-discovery',
      hintAction: 'keep',
    };
    expect(parseResult(result, input).outcome).toBe('retained');
    expect(() => parseResult({ ...result, id: randomUUID() }, input)).toThrow();
    expect(() =>
      parseResult({ ...result, cause: 'private-error' }, input),
    ).toThrow();
    expect(() =>
      parseResult({ ...result, hintAction: 'revoke-matching' }, input),
    ).toThrow();
    expect(() =>
      parsePublicationRequest({
        ...input,
        op: 'remove',
        rootMode: 'prepare-standalone-private',
      }),
    ).toThrow();
  });
});
