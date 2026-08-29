import { createHash, randomBytes } from 'node:crypto';

import { HOSTED_PRODUCER_PROVENANCE_ENV } from '../contracts';

import { currentProductHostedProducerProvenance } from './HostedProducerProvenanceRegistry';
import { requireProductHostedProducerInstance } from './ProductHostedProducerOperation';

export type ProductSseFrameIdentity =
  | Readonly<{ frameKind: 'coordination_event'; eventId: string; eventType: string }>
  | Readonly<{ frameKind: 'heartbeat'; eventId: null; eventType: null }>
  | Readonly<{ frameKind: 'resync_required'; eventId: null; eventType: 'resync_required' }>;

export function emitProductSseWrite(
  frame: string,
  identity: ProductSseFrameIdentity,
  wrote: boolean
): boolean {
  if (!wrote) return false;
  const provenance = currentProductHostedProducerProvenance();
  if (provenance === null) {
    if (process.env[HOSTED_PRODUCER_PROVENANCE_ENV] === undefined) return true;
    throw new TypeError('producer-provenance-product-required');
  }
  const frameBytes = Buffer.from(frame);
  provenance.emit('productTimeline', {
    recordType: 'coordination-sse-write-succeeded',
    operationNonce: randomBytes(32).toString('hex'),
    native: Object.freeze({
      ...requireProductHostedProducerInstance(provenance),
      eventId: identity.eventId,
      eventType: identity.eventType,
      frameBytes: frameBytes.byteLength,
      frameKind: identity.frameKind,
      frameSha256: createHash('sha256').update(frameBytes).digest('hex'),
    }),
  });
  return true;
}
