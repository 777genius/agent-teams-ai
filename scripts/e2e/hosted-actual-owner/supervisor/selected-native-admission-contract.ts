import { createPublicKey, verify } from 'node:crypto';
import type { ControllerTrustAnchor } from '../controller-authority';
import { parseControllerTrustAnchor } from '../controller-authority';
import { canonicalJson, exactRecord, sha256 } from './canonical';
import { allocationDigest, allocationId, decodeNativeAllocation, immutableAllocation,
  requireAllocation, type NativeAllocationSelection, type NativeGenerationSelection } from './selected-operation-allocation';

export const NATIVE_LAUNCH_ADMISSION = 'agent-teams.owner-native-launch-admission/v2' as const;
export const NATIVE_ADMISSION_MAXIMUM = 128 * 1024;
export type NativePredecessorResult = Readonly<{
  operationId: string; generation: 3; ownerProcessStartToken: string;
  requestRecordSha256: string; responseRecordSha256: string; bodySha256: string;
  peerBindingSha256: string; returnWitnessSha256: string;
}>;
export type NativeAdmissionStatement = Readonly<{
  format: typeof NATIVE_LAUNCH_ADMISSION;
  launchSha256: string; sealedSha256: string; ownerProcessStartToken: string;
  /** Exact canonical descriptor bytes. Owner must run its existing descriptor
   * parser and independent control-document verification after signature check. */
  controllerDescriptor: string;
  controllerTrustAnchor: ControllerTrustAnchor;
  activation: Readonly<{ publicKeySpkiDerBase64url: string; contractDigest: string }>;
  allocationSha256: string; allocation: NativeAllocationSelection;
  generation: NativeGenerationSelection;
  predecessorResults: readonly NativePredecessorResult[];
}>;
export type NativeLaunchAdmission = Readonly<{ statement: NativeAdmissionStatement; signatureBase64url: string }>;
export type NativeLaunchRequest = Readonly<{
  kind: 'native'; generation: number; ownerProcessStartToken: string;
  launch: Readonly<Record<string, unknown>>; sealed: unknown;
}>;
/** This port is root-only. The later native resource writer must independently
 * observe the actual process, sealed memfd, images, endpoints and predecessor
 * returns. Echoing request data is not an implementation of this authority. */
export interface SelectedNativeObservationAuthority {
  observe(request: NativeLaunchRequest, signal: AbortSignal): Promise<Readonly<{
    launchSha256: string; sealedSha256: string; ownerProcessStartToken: string;
    bootstrapV2HeaderSha256: string;
    predecessorResults: readonly NativePredecessorResult[];
  }>>;
}
/** REQUIRED separate root-owned endpoint census. No namespace identity is passed
 * to this port; the implementation must use retained actual native resources. */
export interface SelectedSuccessorEndpointObservationAuthority {
  observe(generation: NativeGenerationSelection, native: Readonly<{
    launchSha256: string; sealedSha256: string; ownerProcessStartToken: string; bootstrapV2HeaderSha256: string;
  }>, signal: AbortSignal): Promise<Readonly<{ device: string; inode: string }>>;
}
export function decodeNativeLaunchRequest(value: unknown): NativeLaunchRequest {
  const r = exactRecord(value, ['kind', 'generation', 'ownerProcessStartToken', 'launch', 'sealed'], 'native_request');
  requireAllocation(r.kind === 'native' && [1, 2, 3, 4].includes(Number(r.generation)) && typeof r.generation === 'number');
  allocationDigest(r.ownerProcessStartToken);
  requireAllocation(r.launch && typeof r.launch === 'object' && !Array.isArray(r.launch) &&
    Reflect.get(r.launch, 'ownerProcessStartToken') === r.ownerProcessStartToken &&
    Buffer.byteLength(canonicalJson(r)) <= 256 * 1024);
  return immutableAllocation(structuredClone(r)) as NativeLaunchRequest;
}
export function decodeNativeAdmissionSelection(value: unknown) {
  const s = exactRecord(value, ['controllerDescriptor', 'controllerTrustAnchor', 'activation', 'allocation'], 'native_selection');
  requireAllocation(Buffer.byteLength(canonicalJson(value)) <= NATIVE_ADMISSION_MAXIMUM - 8192);
  requireAllocation(typeof s.controllerDescriptor === 'string' && Buffer.byteLength(s.controllerDescriptor) <= 48 * 1024);
  const descriptor = JSON.parse(s.controllerDescriptor);
  requireAllocation(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) &&
    canonicalJson(descriptor) === s.controllerDescriptor);
  const controllerTrustAnchor = parseControllerTrustAnchor(s.controllerTrustAnchor);
  const activation = exactRecord(s.activation, ['publicKeySpkiDerBase64url', 'contractDigest'], 'native_activation');
  allocationDigest(activation.contractDigest);
  requireAllocation(typeof activation.publicKeySpkiDerBase64url === 'string' && /^[A-Za-z0-9_-]{59}$/u.test(activation.publicKeySpkiDerBase64url));
  const key = Buffer.from(activation.publicKeySpkiDerBase64url, 'base64url');
  requireAllocation(key.length === 44 && key.toString('base64url') === activation.publicKeySpkiDerBase64url &&
    key.subarray(0, 12).toString('hex') === '302a300506032b6570032100');
  const allocation = decodeNativeAllocation(s.allocation);
  return immutableAllocation(structuredClone({ controllerDescriptor: s.controllerDescriptor, controllerTrustAnchor,
    activation: activation as NativeAdmissionStatement['activation'], allocation }));
}
export function decodeNativeAdmissionStatement(value: unknown): NativeAdmissionStatement {
  requireAllocation(Buffer.byteLength(canonicalJson(value)) <= NATIVE_ADMISSION_MAXIMUM);
  const s = exactRecord(value, ['format', 'launchSha256', 'sealedSha256', 'ownerProcessStartToken',
    'controllerDescriptor', 'controllerTrustAnchor', 'activation', 'allocationSha256', 'allocation',
    'generation', 'predecessorResults'], 'native_statement');
  requireAllocation(s.format === NATIVE_LAUNCH_ADMISSION);
  for (const key of ['launchSha256', 'sealedSha256', 'ownerProcessStartToken', 'allocationSha256']) allocationDigest(s[key]);
  const { controllerDescriptor, controllerTrustAnchor, activation, allocation } = decodeNativeAdmissionSelection({ controllerDescriptor: s.controllerDescriptor,
    controllerTrustAnchor: s.controllerTrustAnchor, activation: s.activation, allocation: s.allocation });
  requireAllocation(s.allocationSha256 === sha256(canonicalJson(allocation)));
  const generation = allocation.generations.find(g => canonicalJson(g) === canonicalJson(s.generation));
  requireAllocation(generation && Array.isArray(s.predecessorResults) && s.predecessorResults.length === (generation.generation === 4 ? 1 : 0));
  const predecessorResults = s.predecessorResults.map(value => {
    const r = exactRecord(value, ['operationId', 'generation', 'ownerProcessStartToken', 'requestRecordSha256',
      'responseRecordSha256', 'bodySha256', 'peerBindingSha256', 'returnWitnessSha256'], 'native_predecessor_result');
    allocationId(r.operationId);
    requireAllocation(r.generation === 3 && allocation.entries.some(e => e.id === r.operationId &&
      e.generation === 3 && e.slot === 'A' && e.operation.kind === 'retry-reply'));
    for (const k of ['ownerProcessStartToken', 'requestRecordSha256', 'responseRecordSha256', 'bodySha256', 'peerBindingSha256', 'returnWitnessSha256']) allocationDigest(r[k]);
    requireAllocation(r.ownerProcessStartToken !== s.ownerProcessStartToken);
    return r as NativePredecessorResult;
  });
  const result: NativeAdmissionStatement = { format: NATIVE_LAUNCH_ADMISSION,
    launchSha256: allocationDigest(s.launchSha256), sealedSha256: allocationDigest(s.sealedSha256),
    ownerProcessStartToken: allocationDigest(s.ownerProcessStartToken), allocationSha256: allocationDigest(s.allocationSha256),
    controllerDescriptor, controllerTrustAnchor, activation, allocation, generation, predecessorResults };
  return immutableAllocation(structuredClone(result));
}
export function nativeLaunchAdmissionSigningBytes(value: NativeAdmissionStatement): Buffer {
  return Buffer.from(`${NATIVE_LAUNCH_ADMISSION}\0${canonicalJson(decodeNativeAdmissionStatement(value))}`, 'utf8');
}
export function decodeNativeLaunchAdmission(value: unknown): NativeLaunchAdmission {
  const e = exactRecord(value, ['statement', 'signatureBase64url'], 'native_admission');
  requireAllocation(typeof e.signatureBase64url === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(e.signatureBase64url));
  const sig = Buffer.from(e.signatureBase64url, 'base64url');
  requireAllocation(sig.length === 64 && sig.toString('base64url') === e.signatureBase64url);
  return immutableAllocation({ statement: decodeNativeAdmissionStatement(e.statement), signatureBase64url: e.signatureBase64url });
}
export function verifyNativeLaunchAdmission(value: unknown, launcherPublicKey: string,
  launch: Readonly<Record<string, unknown>>, sealed: unknown): NativeLaunchAdmission {
  const e = decodeNativeLaunchAdmission(value);
  requireAllocation(/^[A-Za-z0-9_-]{43}$/u.test(launcherPublicKey));
  const raw = Buffer.from(launcherPublicKey, 'base64url');
  requireAllocation(raw.length === 32 && raw.toString('base64url') === launcherPublicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: launcherPublicKey } });
  requireAllocation(key.export({ format: 'der', type: 'spki' }).toString('base64url') !== e.statement.activation.publicKeySpkiDerBase64url &&
    e.statement.launchSha256 === sha256(canonicalJson(launch)) && e.statement.sealedSha256 === sha256(canonicalJson(sealed)) &&
    e.statement.ownerProcessStartToken === launch.ownerProcessStartToken &&
    verify(null, nativeLaunchAdmissionSigningBytes(e.statement), key, Buffer.from(e.signatureBase64url, 'base64url')));
  return e;
}
