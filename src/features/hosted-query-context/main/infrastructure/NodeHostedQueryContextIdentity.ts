import { Buffer } from 'node:buffer';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { parseActorId, parseRequestId, parseSessionId } from '@shared/contracts/hosted';

import type {
  AuthenticatedHostedSessionId,
  HostedQueryContextIdentityPort,
} from '../../core/application/ports';
import type { HostedPrincipal } from '@features/hosted-access/contracts';

const REQUEST_ID_BYTES = 16;
const FRAME_LENGTH_BYTES = 4;
const ACTOR_PROJECTION_DOMAIN = 'agent-teams/hosted-query-context/actor/v1';
const SESSION_PROJECTION_DOMAIN = 'agent-teams/hosted-query-context/session/v1';

export interface NodeHostedQueryContextIdentityDependencies {
  readonly randomBytes?: (size: number) => Uint8Array;
}

function framedProjectionInput(domain: string, opaqueId: string): Uint8Array {
  const domainBytes = Buffer.from(domain, 'utf8');
  const opaqueIdBytes = Buffer.from(opaqueId, 'utf8');
  const frame = Buffer.allocUnsafe(
    FRAME_LENGTH_BYTES + domainBytes.byteLength + FRAME_LENGTH_BYTES + opaqueIdBytes.byteLength
  );
  let offset = 0;
  frame.writeUInt32BE(domainBytes.byteLength, offset);
  offset += FRAME_LENGTH_BYTES;
  domainBytes.copy(frame, offset);
  offset += domainBytes.byteLength;
  frame.writeUInt32BE(opaqueIdBytes.byteLength, offset);
  offset += FRAME_LENGTH_BYTES;
  opaqueIdBytes.copy(frame, offset);
  return frame;
}

function project(domain: string, opaqueId: string): string {
  return createHash('sha256').update(framedProjectionInput(domain, opaqueId)).digest('hex');
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class NodeHostedQueryContextIdentity implements HostedQueryContextIdentityPort {
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(dependencies: NodeHostedQueryContextIdentityDependencies = {}) {
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  }

  projectActorId(userId: HostedPrincipal['userId']) {
    return parseActorId(`actor_${project(ACTOR_PROJECTION_DOMAIN, userId)}`);
  }

  projectSessionId(authenticatedSessionId: AuthenticatedHostedSessionId) {
    return parseSessionId(`session_${project(SESSION_PROJECTION_DOMAIN, authenticatedSessionId)}`);
  }

  createRequestId() {
    const bytes = this.randomBytes(REQUEST_ID_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== REQUEST_ID_BYTES) {
      throw new TypeError('hosted-query-context-request-id-randomness-invalid');
    }
    return parseRequestId(`request_${hexadecimal(bytes)}`);
  }
}
