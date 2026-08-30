import type {
  HostedProducerProvenance,
  ProductSseWriteEmitter,
} from './HostedProducerProvenanceContracts';

export class HostedProducerProvenanceFatalError extends Error {
  readonly code = 'HOSTED_PRODUCER_PROVENANCE_FATAL';

  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'HostedProducerProvenanceFatalError';
  }
}

export function isHostedProducerProvenanceFatalError(
  error: unknown
): error is HostedProducerProvenanceFatalError {
  return error instanceof HostedProducerProvenanceFatalError;
}

export function fatalProvenanceError(error: Error): HostedProducerProvenanceFatalError {
  return isHostedProducerProvenanceFatalError(error)
    ? error
    : new HostedProducerProvenanceFatalError('producer-provenance-fatal', { cause: error });
}

let productProvenance: HostedProducerProvenance | null = null;
let productProvenancePoison: HostedProducerProvenanceFatalError | null = null;
const CLEARED_PRODUCT_SSE_WRITE_EMITTER = Symbol('cleared-product-sse-write-emitter');
let productSseWriteEmitter:
  | ProductSseWriteEmitter
  | null
  | typeof CLEARED_PRODUCT_SSE_WRITE_EMITTER = null;

export function reportProductHostedProducerProvenanceFailure(
  provenance: HostedProducerProvenance,
  fatal: HostedProducerProvenanceFatalError
): void {
  if (productProvenance === provenance) productProvenancePoison ??= fatal;
}

export function installProductHostedProducerProvenance(
  provenance: HostedProducerProvenance | null,
  sseWriteEmitter?: ProductSseWriteEmitter
): void {
  if (provenance === null) return;
  if (provenance.role !== 'product-producer') {
    throw new TypeError('producer-provenance-product-role');
  }
  if (productProvenance !== null && productProvenance !== provenance) {
    throw new Error('producer-provenance-product-already-installed');
  }
  if (productProvenancePoison !== null) throw productProvenancePoison;
  productProvenance = provenance;
  productSseWriteEmitter = sseWriteEmitter ?? null;
}

export function currentProductHostedProducerProvenance(): HostedProducerProvenance | null {
  if (productProvenancePoison !== null) throw productProvenancePoison;
  return productProvenance;
}

export function currentProductHostedProducerSseWriteEmitter(): ProductSseWriteEmitter | null {
  if (productProvenancePoison !== null) throw productProvenancePoison;
  if (productSseWriteEmitter === CLEARED_PRODUCT_SSE_WRITE_EMITTER) {
    throw new HostedProducerProvenanceFatalError('producer-provenance-product-sse-emitter-cleared');
  }
  return productSseWriteEmitter;
}

export function clearProductHostedProducerProvenance(provenance: HostedProducerProvenance): void {
  if (productProvenancePoison !== null) throw productProvenancePoison;
  if (productProvenance === provenance) {
    productProvenance = null;
    productSseWriteEmitter = CLEARED_PRODUCT_SSE_WRITE_EMITTER;
  }
}

export function resetProductHostedProducerProvenanceForTests(): void {
  productProvenance = null;
  productProvenancePoison = null;
  productSseWriteEmitter = null;
}
