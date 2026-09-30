// @vitest-environment node

import { parseHostedSessionId, parseUserId } from '@features/hosted-access/contracts';
import { describe, expect, it, vi } from 'vitest';

import { NodeHostedQueryContextIdentity } from '../../../src/features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';

const ACTOR_VECTOR = '65805c43270df50dbadb1a331709edebfad93bf6e7735ad2b2b05f43c31d7c68';
const SESSION_VECTOR = 'a9e4410aa877809f823995f9c8b452a92fb5b90a3e3cda9ba1fc9bdbaa207b32';

describe('NodeHostedQueryContextIdentity', () => {
  it('uses exact big-endian length-framed, domain-separated SHA-256 projections', () => {
    const identity = new NodeHostedQueryContextIdentity();
    const userId = parseUserId('user_owner0001');
    const authenticatedSessionId = parseHostedSessionId('session-oidc_00000001');

    const actorId = identity.projectActorId(userId);
    const sessionId = identity.projectSessionId(authenticatedSessionId);

    expect(actorId).toBe(`actor_${ACTOR_VECTOR}`);
    expect(sessionId).toBe(`session_${SESSION_VECTOR}`);
    expect(ACTOR_VECTOR).not.toBe(SESSION_VECTOR);
    expect(actorId).not.toContain(userId);
    expect(sessionId).not.toContain(authenticatedSessionId);
  });

  it('creates a server RequestId from 128 bits of cryptorandom input', () => {
    const randomBytes = vi.fn((size: number) => {
      expect(size).toBe(16);
      return Uint8Array.from({ length: size }, (_, index) => index);
    });
    const identity = new NodeHostedQueryContextIdentity({ randomBytes });

    expect(identity.createRequestId()).toBe('request_000102030405060708090a0b0c0d0e0f');
    expect(randomBytes).toHaveBeenCalledOnce();
  });

  it('rejects a random source that does not return the exact entropy width', () => {
    const identity = new NodeHostedQueryContextIdentity({
      randomBytes: () => new Uint8Array(15),
    });

    expect(() => identity.createRequestId()).toThrow(
      'hosted-query-context-request-id-randomness-invalid'
    );
  });
});
