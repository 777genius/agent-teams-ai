export const HOSTED_READINESS_PROBE_FAILURE_REASON = 'readiness_probe_failed';

export interface HostedComponentReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface HostedReadinessProbe {
  readonly id: string;
  readiness(): HostedComponentReadiness | Promise<HostedComponentReadiness>;
}

export interface HostedReadinessCheck {
  readonly componentId: string;
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly error?: unknown;
}

export interface HostedReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly HostedReadinessCheck[];
}

function assertProbeIds(probes: readonly HostedReadinessProbe[]): void {
  const ids = new Set<string>();

  for (const probe of probes) {
    if (probe.id.length === 0 || probe.id.trim() !== probe.id || ids.has(probe.id)) {
      throw new TypeError(`Invalid or duplicate hosted readiness probe id: ${probe.id}`);
    }
    ids.add(probe.id);
  }
}

function normalizeReadiness(
  componentId: string,
  value: HostedComponentReadiness
): HostedReadinessCheck {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.ready !== 'boolean' ||
    !Array.isArray(value.reasons) ||
    value.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)
  ) {
    throw new TypeError(`Hosted readiness probe returned an invalid result: ${componentId}`);
  }

  return Object.freeze({
    componentId,
    ready: value.ready,
    reasons: Object.freeze([...value.reasons]),
  });
}

function failedCheck(componentId: string, error: unknown): HostedReadinessCheck {
  return Object.freeze({
    componentId,
    ready: false,
    reasons: Object.freeze([HOSTED_READINESS_PROBE_FAILURE_REASON]),
    error,
  });
}

/** Aggregates component-owned readiness without consulting ambient runtime state. */
export class HostedReadiness {
  private readonly probes: readonly HostedReadinessProbe[];

  constructor(probes: readonly HostedReadinessProbe[]) {
    assertProbeIds(probes);
    this.probes = Object.freeze([...probes]);
  }

  async readiness(): Promise<HostedReadinessReport> {
    const checks: HostedReadinessCheck[] = [];

    for (const probe of this.probes) {
      try {
        checks.push(normalizeReadiness(probe.id, await probe.readiness()));
      } catch (error) {
        checks.push(failedCheck(probe.id, error));
      }
    }

    return Object.freeze({
      ready: checks.every((check) => check.ready),
      checks: Object.freeze(checks),
    });
  }
}
