import { parseTeamId } from '@shared/contracts/hosted';

import { admitCanonicalLaunch } from '../domain';

import { createLifecycleOperationDeadline } from './ports/TeamLifecycleCommandPorts';

import type {
  PrepareProvisioningRequest,
  PrepareProvisioningResult,
  ProvisioningPreflightLaneView,
} from '../../contracts';
import type {
  ProvisioningPreflightPort,
  TeamLifecycleClockPort,
  TeamLifecycleCommandContext,
  TeamLifecycleCommandStatePort,
  TeamLifecycleDeadlinePort,
} from './ports/TeamLifecycleCommandPorts';

export interface PrepareProvisioningDependencies {
  readonly state: TeamLifecycleCommandStatePort;
  readonly preflight: ProvisioningPreflightPort;
  readonly deadlines: TeamLifecycleDeadlinePort;
  readonly clock: TeamLifecycleClockPort;
}

/** Bounded capability preflight only: it does not allocate or persist a run identity. */
export class PrepareProvisioning {
  constructor(private readonly dependencies: PrepareProvisioningDependencies) {}

  async execute(
    request: PrepareProvisioningRequest,
    context: TeamLifecycleCommandContext
  ): Promise<PrepareProvisioningResult> {
    if (
      request.schemaVersion !== 1 ||
      !Number.isSafeInteger(request.inputRevision) ||
      request.inputRevision < 1
    ) {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    let teamId;
    try {
      teamId = parseTeamId(request.teamId);
    } catch {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    if (isCancelled(context)) return { status: 'rejected', reason: 'cancelled' };

    const loaded = await this.dependencies.state.load(teamId);
    if (loaded.status === 'missing') return { status: 'rejected', reason: 'not_found' };
    if (loaded.status === 'unavailable') return { status: 'rejected', reason: 'unavailable' };
    if (loaded.snapshot.lifecycle.deploymentId !== context.deploymentId) {
      return { status: 'rejected', reason: 'not_found' };
    }
    const admission = admitCanonicalLaunch(loaded.snapshot.lifecycle.cutover);
    if (admission.status === 'rejected') {
      return { status: 'rejected', reason: admission.reason };
    }

    const deadline = createLifecycleOperationDeadline(this.dependencies.clock.nowIso());
    let bounded;
    try {
      bounded = await this.dependencies.deadlines.run(
        {
          deadline,
          cancellation: context.cancellation,
        },
        async () =>
          await this.dependencies.preflight.preflight({
            teamId,
            inputRevision: request.inputRevision,
            cancellation: context.cancellation,
            deadline,
          })
      );
    } catch {
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (bounded.status !== 'completed') {
      return {
        status: 'rejected',
        reason: bounded.status === 'cancelled' ? 'cancelled' : 'preparation_timeout',
      };
    }
    const result = bounded.value;
    if (result.status !== 'ready') {
      return {
        status: 'rejected',
        reason:
          result.status === 'cancelled'
            ? 'cancelled'
            : result.status === 'deadline_exceeded'
              ? 'preparation_timeout'
              : result.status === 'unsupported'
                ? 'unsupported'
                : 'unavailable',
      };
    }
    const lanes = normalizeLanes(result.lanes);
    if (!lanes) return { status: 'rejected', reason: 'unavailable' };
    if (lanes.some((lane) => lane.status === 'unsupported')) {
      return { status: 'rejected', reason: 'unsupported' };
    }
    if (lanes.some((lane) => lane.status === 'unavailable')) {
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (isCancelled(context)) return { status: 'rejected', reason: 'cancelled' };
    return Object.freeze({
      status: 'ready',
      inputRevision: request.inputRevision,
      lanes,
    });
  }
}

function normalizeLanes(laneValues: unknown): readonly ProvisioningPreflightLaneView[] | null {
  if (!Array.isArray(laneValues) || laneValues.length === 0) return null;
  const seen = new Set<string>();
  const normalized: ProvisioningPreflightLaneView[] = [];
  for (const candidate of laneValues as readonly unknown[]) {
    if (!isRecord(candidate)) return null;
    const { backend, laneKey, status } = candidate;
    if (
      typeof laneKey !== 'string' ||
      laneKey.length === 0 ||
      seen.has(laneKey) ||
      (backend !== 'provisioning_cli' && backend !== 'opencode') ||
      (status !== 'ready' && status !== 'unsupported' && status !== 'unavailable')
    ) {
      return null;
    }
    seen.add(laneKey);
    normalized.push(Object.freeze({ backend, laneKey, status }));
  }
  normalized.sort((left, right) =>
    left.laneKey < right.laneKey ? -1 : left.laneKey > right.laneKey ? 1 : 0
  );
  return Object.freeze(normalized);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCancelled(context: TeamLifecycleCommandContext): boolean {
  try {
    return context.cancellation.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}
