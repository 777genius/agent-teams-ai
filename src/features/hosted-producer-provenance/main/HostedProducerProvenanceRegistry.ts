import type { HostedProducerProvenance } from './HostedProducerProvenance';

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

export function poisonInstalledProductProvenance(
  provenance: HostedProducerProvenance,
  fatal: HostedProducerProvenanceFatalError
): void {
  if (productProvenance === provenance) productProvenancePoison ??= fatal;
}

export function installProductHostedProducerProvenance(
  provenance: HostedProducerProvenance | null
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
}

export function currentProductHostedProducerProvenance(): HostedProducerProvenance | null {
  if (productProvenancePoison !== null) throw productProvenancePoison;
  return productProvenance;
}

export function clearProductHostedProducerProvenance(provenance: HostedProducerProvenance): void {
  if (productProvenancePoison !== null) throw productProvenancePoison;
  if (productProvenance === provenance) productProvenance = null;
}
