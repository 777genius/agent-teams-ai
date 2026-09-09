import { createPublicKey, verify } from 'node:crypto';

import { decodeNativeActivationHandleSelection, type NativeActivationHandleSelection } from './hostedNativeActivationHandleContract';
import { type NativeActivationSocketIdentity,nativeActivationSocketIdentity } from './hostedNativeActivationSocketIdentity';

import type { HostedLifecycleAdmissionLauncherPin } from './hostedLifecycleOwnerAdmissionManifest';
import type { Socket } from 'node:net';

export const NATIVE_SUCCESSOR_HANDLE = 'agent-teams.hosted-native-activation-successor/v1';
export interface NativeSuccessorHandle {
  readonly contract: typeof NATIVE_SUCCESSOR_HANDLE;
  readonly transitionSha256: string;
  readonly selection: NativeActivationHandleSelection;
  readonly successorManifest: string;
  readonly endpointIdentity: NativeActivationSocketIdentity;
  readonly signature: string;
}

export function nativeSuccessorHandleSigningBytes(value: NativeSuccessorHandle): Buffer {
  return Buffer.from(`${NATIVE_SUCCESSOR_HANDLE}\0${JSON.stringify({ contract: value.contract,
    transitionSha256: value.transitionSha256, selection: value.selection, successorManifest: value.successorManifest, endpointIdentity: value.endpointIdentity })}`);
}

export function decodeNativeSuccessorHandle(value: unknown): NativeSuccessorHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native_successor_handle_message');
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== 6 || row.contract !== NATIVE_SUCCESSOR_HANDLE ||
    typeof row.transitionSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.transitionSha256) ||
    typeof row.successorManifest !== 'string' || Buffer.byteLength(row.successorManifest) > 16_384 ||
    typeof row.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(row.signature)) throw new Error('native_successor_handle_message');
  const endpoint = row.endpointIdentity as Record<string, unknown> | undefined;
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || Reflect.ownKeys(endpoint).length !== 2 ||
    typeof endpoint.device !== 'string' || !/^[0-9]{1,32}$/u.test(endpoint.device) ||
    typeof endpoint.inode !== 'string' || !/^[0-9]{1,32}$/u.test(endpoint.inode)) throw new Error('native_successor_endpoint_identity');
  return Object.freeze({ contract: NATIVE_SUCCESSOR_HANDLE, transitionSha256: row.transitionSha256,
    selection: decodeNativeActivationHandleSelection(row.selection), successorManifest: row.successorManifest,
    endpointIdentity: Object.freeze({ device: endpoint.device, inode: endpoint.inode }), signature: row.signature });
}

/** Verifies the selected native start/header/endpoint metadata independently of
 * the socket's Owner proof key, against the retained launcher public root. */
export function authenticateNativeSuccessorHandle(value: unknown, transitionSha256: string,
  selection: NativeActivationHandleSelection, socket: Socket, pin: HostedLifecycleAdmissionLauncherPin): void {
  const envelope = decodeNativeSuccessorHandle(value);
  const actual = nativeActivationSocketIdentity(socket);
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (actual.device !== envelope.endpointIdentity.device || actual.inode !== envelope.endpointIdentity.inode ||
    envelope.transitionSha256 !== transitionSha256 ||
    JSON.stringify(envelope.selection) !== JSON.stringify(selection) ||
    signature.toString('base64url') !== envelope.signature ||
    !verify(null, nativeSuccessorHandleSigningBytes(envelope), createPublicKey({ format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: pin.launcherPublicKey } }), signature)) {
    throw new Error('native_successor_handle_authentication');
  }
}
