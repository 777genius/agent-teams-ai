import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimension,
  type HostedReadinessDimensionState,
  type HostedReadinessDimensionStates,
  isHostedReadinessDimension,
} from './HostedReadinessDimensions';

export const HOSTED_READINESS_PROBE_FAILURE_REASON = 'readiness_probe_failed';
export const HOSTED_READINESS_PROBE_MISSING_REASON = 'readiness_probe_missing';

const READINESS_REASON = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_READINESS_REASON_LENGTH = 128;

export interface HostedComponentReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/**
 * Lifecycle components retain the optional dimension for structural compatibility. Readiness
 * aggregation accepts only probes whose dimension is present and valid.
 */
export interface HostedReadinessProbe {
  readonly id: string;
  readonly dimension?: HostedReadinessDimension;
  readiness(): HostedComponentReadiness | Promise<HostedComponentReadiness>;
}

export interface HostedDimensionReadinessProbe extends HostedReadinessProbe {
  readonly dimension: HostedReadinessDimension;
}

export interface HostedReadinessCheck {
  readonly probeId: string;
  readonly dimension: HostedReadinessDimension;
  readonly status: 'not_ready' | 'ready';
  readonly reasons: readonly string[];
}

export interface HostedReadinessReport {
  readonly revision: number;
  readonly dimensions: HostedReadinessDimensionStates;
  readonly checks: readonly HostedReadinessCheck[];
}

export interface HostedReadinessPublicationGuard {
  readonly generation: number;
  isCurrent(generation: number): boolean;
  readonly staleReason: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertProbes(
  probes: readonly HostedDimensionReadinessProbe[]
): readonly HostedDimensionReadinessProbe[] {
  if (!Array.isArray(probes)) throw new TypeError('Hosted readiness probes must be an array');

  const ids = new Set<string>();
  const validated: HostedDimensionReadinessProbe[] = [];
  for (const probe of probes) {
    if (
      typeof probe !== 'object' ||
      probe === null ||
      typeof probe.id !== 'string' ||
      probe.id.length === 0 ||
      probe.id.trim() !== probe.id ||
      ids.has(probe.id) ||
      !isHostedReadinessDimension(probe.dimension) ||
      typeof probe.readiness !== 'function'
    ) {
      throw new TypeError(`Invalid or duplicate hosted readiness probe id: ${String(probe?.id)}`);
    }
    ids.add(probe.id);
    validated.push(
      Object.freeze({
        id: probe.id,
        dimension: probe.dimension,
        readiness: probe.readiness.bind(probe),
      })
    );
  }

  return Object.freeze(
    validated.sort(
      (left, right) =>
        HOSTED_READINESS_DIMENSIONS.indexOf(left.dimension) -
          HOSTED_READINESS_DIMENSIONS.indexOf(right.dimension) || compareText(left.id, right.id)
    )
  );
}

function normalizeReasons(reasons: readonly string[]): readonly string[] {
  if (!Array.isArray(reasons)) {
    throw new TypeError('Hosted readiness probe returned an invalid reason');
  }
  const values = [...reasons];
  if (
    values.some(
      (reason) =>
        typeof reason !== 'string' ||
        reason.length > MAX_READINESS_REASON_LENGTH ||
        !READINESS_REASON.test(reason)
    )
  ) {
    throw new TypeError('Hosted readiness probe returned an invalid reason');
  }

  return Object.freeze([...new Set(values)].sort(compareText));
}

function normalizeReadiness(
  probe: HostedDimensionReadinessProbe,
  value: HostedComponentReadiness
): HostedReadinessCheck {
  if (typeof value !== 'object' || value === null || typeof value.ready !== 'boolean') {
    throw new TypeError(`Hosted readiness probe returned an invalid result: ${probe.id}`);
  }

  const reasons = normalizeReasons(value.reasons);
  if ((value.ready && reasons.length > 0) || (!value.ready && reasons.length === 0)) {
    throw new TypeError(`Hosted readiness probe returned an inconsistent result: ${probe.id}`);
  }

  return Object.freeze({
    probeId: probe.id,
    dimension: probe.dimension,
    status: value.ready ? 'ready' : 'not_ready',
    reasons,
  });
}

function failedCheck(probe: HostedDimensionReadinessProbe): HostedReadinessCheck {
  return Object.freeze({
    probeId: probe.id,
    dimension: probe.dimension,
    status: 'not_ready',
    reasons: Object.freeze([HOSTED_READINESS_PROBE_FAILURE_REASON]),
  });
}

function buildDimensionState(
  dimension: HostedReadinessDimension,
  checks: readonly HostedReadinessCheck[]
): HostedReadinessDimensionState {
  const dimensionChecks = checks.filter((check) => check.dimension === dimension);
  if (dimensionChecks.length === 0) {
    return Object.freeze({
      dimension,
      status: 'not_ready',
      reasons: Object.freeze([HOSTED_READINESS_PROBE_MISSING_REASON]),
    });
  }

  const reasons = Object.freeze(
    [
      ...new Set(
        dimensionChecks.flatMap((check) => (check.status === 'not_ready' ? check.reasons : []))
      ),
    ].sort(compareText)
  );
  return Object.freeze({
    dimension,
    status: dimensionChecks.every((check) => check.status === 'ready') ? 'ready' : 'not_ready',
    reasons,
  });
}

function buildDimensionStates(
  checks: readonly HostedReadinessCheck[]
): HostedReadinessDimensionStates {
  const states = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => [
      dimension,
      buildDimensionState(dimension, checks),
    ])
  ) as unknown as {
    [TDimension in HostedReadinessDimension]: HostedReadinessDimensionState;
  } & { terminal: typeof HOSTED_TERMINAL_READINESS };
  states.terminal = HOSTED_TERMINAL_READINESS;
  return Object.freeze(states);
}

function buildUnavailableStates(reason: string): HostedReadinessDimensionStates {
  const reasons = normalizeReasons([reason]);
  const states = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => [
      dimension,
      Object.freeze({ dimension, status: 'not_ready' as const, reasons }),
    ])
  ) as unknown as {
    [TDimension in HostedReadinessDimension]: HostedReadinessDimensionState;
  } & { terminal: typeof HOSTED_TERMINAL_READINESS };
  states.terminal = HOSTED_TERMINAL_READINESS;
  return Object.freeze(states);
}

function semanticFingerprint(dimensions: HostedReadinessDimensionStates): string {
  return JSON.stringify(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => {
      const state = dimensions[dimension];
      return [state.dimension, state.status, state.reasons];
    })
  );
}

/** Aggregates dimension-owned probes without consulting ambient or provider-specific runtime state. */
export class HostedReadiness {
  private readonly probes: readonly HostedDimensionReadinessProbe[];
  private revision = 0;
  private previousFingerprint: string | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(probes: readonly HostedDimensionReadinessProbe[]) {
    this.probes = assertProbes(probes);
  }

  readiness(guard?: HostedReadinessPublicationGuard): Promise<HostedReadinessReport> {
    const generation = guard?.generation;
    const isCurrent = guard?.isCurrent.bind(guard);
    const staleReason = guard?.staleReason;

    return this.enqueue(async () => {
      const checks: HostedReadinessCheck[] = [];
      for (const probe of this.probes) {
        try {
          checks.push(normalizeReadiness(probe, await probe.readiness()));
        } catch {
          checks.push(failedCheck(probe));
        }
      }

      if (
        generation !== undefined &&
        isCurrent !== undefined &&
        staleReason !== undefined &&
        !isCurrent(generation)
      ) {
        return this.publish(buildUnavailableStates(staleReason), Object.freeze([]));
      }

      return this.publish(buildDimensionStates(checks), Object.freeze(checks));
    });
  }

  unavailable(reason: string): Promise<HostedReadinessReport> {
    return this.enqueue(() => this.publish(buildUnavailableStates(reason), Object.freeze([])));
  }

  private enqueue(
    operation: () => HostedReadinessReport | Promise<HostedReadinessReport>
  ): Promise<HostedReadinessReport> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private publish(
    dimensions: HostedReadinessDimensionStates,
    checks: readonly HostedReadinessCheck[]
  ): HostedReadinessReport {
    const fingerprint = semanticFingerprint(dimensions);
    if (fingerprint !== this.previousFingerprint) {
      this.revision += 1;
      this.previousFingerprint = fingerprint;
    }

    return Object.freeze({
      revision: this.revision,
      dimensions,
      checks,
    });
  }
}
