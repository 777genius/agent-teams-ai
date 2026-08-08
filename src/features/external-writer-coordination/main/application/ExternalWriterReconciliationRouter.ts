import type { ExternalFileReconciliationResult, ExternalWriterFeatureKey } from '../../contracts';
import type { ExternalFileReconciliationPort } from '../../core/application';

const RECONCILIATION_ID_PREFIX = 'external-writer-reconciliation:v2:';
const MAX_RECONCILIATION_ID_LENGTH = 4 * 1_024 + 128;

/** A feature-owned reconciliation port selected only by its registered feature key. */
export interface ExternalWriterReconciliationRoute {
  readonly featureKey: ExternalWriterFeatureKey;
  readonly reconciliation: ExternalFileReconciliationPort;
}

function conflict(diagnosticCode: string): ExternalFileReconciliationResult {
  return Object.freeze({ outcome: 'conflict', diagnosticCode });
}

function isCanonicalPositiveInteger(value: string): boolean {
  return /^(?:[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
}

function readLengthPrefixedSegment(
  value: string,
  start: number
): { readonly value: string; readonly next: number } | null {
  const separator = value.indexOf(':', start);
  if (separator <= start) return null;
  const encodedLength = value.slice(start, separator);
  if (!isCanonicalPositiveInteger(encodedLength)) return null;
  const contentStart = separator + 1;
  const next = contentStart + Number(encodedLength);
  if (next > value.length) return null;
  return Object.freeze({ value: value.slice(contentStart, next), next });
}

/**
 * Pending reconciliation IDs are durable observer coordinates. Their canonical
 * scope encoding lets recovery query only the owning feature; probing every
 * authority would let an unrelated outage block a recoverable result.
 */
function featureKeyFromReconciliationId(reconciliationId: string): ExternalWriterFeatureKey | null {
  if (
    typeof reconciliationId !== 'string' ||
    reconciliationId.length === 0 ||
    reconciliationId.length > MAX_RECONCILIATION_ID_LENGTH ||
    !reconciliationId.startsWith(RECONCILIATION_ID_PREFIX)
  ) {
    return null;
  }
  const encodedIdentity = readLengthPrefixedSegment(
    reconciliationId,
    RECONCILIATION_ID_PREFIX.length
  );
  if (encodedIdentity === null || reconciliationId.charAt(encodedIdentity.next) !== ':') {
    return null;
  }
  const tail = reconciliationId.slice(encodedIdentity.next + 1).split(':');
  if (
    tail.length !== 2 ||
    !isCanonicalPositiveInteger(tail[0] ?? '') ||
    !isCanonicalPositiveInteger(tail[1] ?? '')
  ) {
    return null;
  }

  const team = readLengthPrefixedSegment(encodedIdentity.value, 0);
  if (team === null) return null;
  const feature = readLengthPrefixedSegment(encodedIdentity.value, team.next);
  if (feature === null) return null;
  const file = readLengthPrefixedSegment(encodedIdentity.value, feature.next);
  if (file === null || file.next !== encodedIdentity.value.length) return null;
  return feature.value;
}

/**
 * Routes the shared observer to explicitly composed feature consumers. It
 * contains no file, task, message, provider, or lifecycle knowledge.
 */
export class ExternalWriterReconciliationRouter implements ExternalFileReconciliationPort {
  private readonly routesByFeatureKey: ReadonlyMap<
    ExternalWriterFeatureKey,
    ExternalFileReconciliationPort
  >;

  constructor(routes: readonly ExternalWriterReconciliationRoute[]) {
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new TypeError('external-writer-reconciliation-routes-invalid');
    }
    const routesByFeatureKey = new Map<ExternalWriterFeatureKey, ExternalFileReconciliationPort>();
    for (const route of routes) {
      if (
        !route ||
        typeof route.featureKey !== 'string' ||
        route.featureKey.length === 0 ||
        !route.reconciliation ||
        typeof route.reconciliation.getResult !== 'function' ||
        typeof route.reconciliation.reconcile !== 'function' ||
        routesByFeatureKey.has(route.featureKey)
      ) {
        throw new TypeError('external-writer-reconciliation-routes-invalid');
      }
      routesByFeatureKey.set(route.featureKey, route.reconciliation);
    }
    this.routesByFeatureKey = routesByFeatureKey;
  }

  async getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    const featureKey = featureKeyFromReconciliationId(reconciliationId);
    const reconciliation =
      featureKey === null ? undefined : this.routesByFeatureKey.get(featureKey);
    return reconciliation ? reconciliation.getResult(reconciliationId) : null;
  }

  reconcile(
    request: Parameters<ExternalFileReconciliationPort['reconcile']>[0]
  ): Promise<ExternalFileReconciliationResult> {
    const reconciliation = this.routesByFeatureKey.get(request.registration.scope.featureKey);
    return reconciliation
      ? reconciliation.reconcile(request)
      : Promise.resolve(conflict('external_writer_reconciliation_route_unregistered'));
  }
}
