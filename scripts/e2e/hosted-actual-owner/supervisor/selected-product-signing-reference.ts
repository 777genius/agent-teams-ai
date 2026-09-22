import { canonicalJson, exactRecord, sha256 } from './canonical';
import type { NativeAdmissionStatement } from './selected-native-admission-contract';

// Existing production configuration names. Only this typed path may supply them.
export const PRODUCT_ACTIVATION_ENV = Object.freeze({
  key: 'HOSTED_APPROVAL_ACTIVATION_PRODUCT_SIGNING_KEY_FILE',
  publicDigest: 'HOSTED_APPROVAL_ACTIVATION_PRODUCT_PUBLIC_KEY_SPKI_DIGEST',
  contract: 'HOSTED_APPROVAL_ACTIVATION_PRODUCT_CONTRACT_DIGEST',
});
export interface SelectedProductActivationSigningReference {
  readonly kind: 'product-activation-signing-key-file/v1';
  readonly keyFile: string;
  readonly publicKeySpkiDerBase64url: string;
  readonly contractDigest: string;
}
export function decodeProductActivationSigningReference(value: unknown): SelectedProductActivationSigningReference {
  const r = exactRecord(value, ['kind', 'keyFile', 'publicKeySpkiDerBase64url', 'contractDigest'], 'product_activation_reference');
  if (r.kind !== 'product-activation-signing-key-file/v1' || typeof r.keyFile !== 'string' ||
    !r.keyFile.startsWith('/sandbox/product-activation/') || r.keyFile.length > 4096 ||
    !/^\/[A-Za-z0-9/_.-]+$/u.test(r.keyFile) ||
    !r.keyFile.split('/').slice(1).every(part => part && part !== '.' && part !== '..') ||
    typeof r.contractDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(r.contractDigest) ||
    typeof r.publicKeySpkiDerBase64url !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(r.publicKeySpkiDerBase64url)) {
    throw new Error('product_activation_reference_rejected');
  }
  const publicKey = Buffer.from(r.publicKeySpkiDerBase64url, 'base64url');
  if (publicKey.length !== 44 || publicKey.toString('base64url') !== r.publicKeySpkiDerBase64url ||
    publicKey.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') throw new Error('product_activation_reference_rejected');
  return Object.freeze({ kind: r.kind, keyFile: r.keyFile,
    publicKeySpkiDerBase64url: r.publicKeySpkiDerBase64url, contractDigest: r.contractDigest });
}
export function assertProductActivationSigningBinding(reference: SelectedProductActivationSigningReference,
  activation: NativeAdmissionStatement['activation']): void {
  const r = decodeProductActivationSigningReference(reference);
  if (canonicalJson({ publicKeySpkiDerBase64url: r.publicKeySpkiDerBase64url, contractDigest: r.contractDigest }) !==
    canonicalJson(activation)) throw new Error('product_activation_reference_binding');
}
/** Never opens a key. Root must later mount the selected private file; the
 * existing Product signing-identity reader authenticates its bytes and mode. */
export function productActivationSigningEnvironment(reference: SelectedProductActivationSigningReference): Readonly<Record<string, string>> {
  const r = decodeProductActivationSigningReference(reference);
  return Object.freeze({ [PRODUCT_ACTIVATION_ENV.key]: r.keyFile,
    [PRODUCT_ACTIVATION_ENV.publicDigest]: `sha256:${sha256(Buffer.from(r.publicKeySpkiDerBase64url, 'base64url'))}`,
    [PRODUCT_ACTIVATION_ENV.contract]: `sha256:${r.contractDigest}` });
}
