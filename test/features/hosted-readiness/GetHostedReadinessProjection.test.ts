import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_SCHEMA_VERSION,
  type HostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import { GetHostedReadinessProjection } from '@features/hosted-readiness/core/application/GetHostedReadinessProjection';
import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedReadinessProjectionSourcePort } from '@features/hosted-readiness/core/application/ports/HostedReadinessProjectionPorts';

const DEPLOYMENT_ID = parseDeploymentId('deployment_application');
const BOOT_ID = parseBootId('boot_application');

function projection(
  revision: number,
  reason?: 'dependency_unavailable'
): HostedReadinessProjection {
  return {
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    revision,
    requiredReadiness: ['serve', 'auth'],
    dimensions: HOSTED_READINESS_DIMENSIONS.map((dimension) => ({
      dimension,
      status: reason && dimension === 'read' ? 'not_ready' : 'ready',
      reasons: reason && dimension === 'read' ? [reason] : [],
    })),
    terminal: { dimension: 'terminal', status: 'not_offered', reasons: [] },
    facets: [],
    actions: [],
  };
}

function context(signal = new AbortController().signal) {
  return { deploymentId: DEPLOYMENT_ID, bootId: BOOT_ID, deadlineAtMs: 1_100, signal };
}

function controlledDeadline() {
  let fire = (): void => undefined;
  const cancel = vi.fn();
  const schedule = vi.fn((_delay: number, onDeadline: () => void) => {
    fire = onDeadline;
    return cancel;
  });
  return { cancel, deadline: { schedule }, fire: () => fire(), schedule };
}

describe('GetHostedReadinessProjection', () => {
  it('passes only the fenced deadline and cancellation context to the injected source', async () => {
    const source: HostedReadinessProjectionSourcePort = {
      readProjection: vi.fn(() => projection(1)),
    };
    const deadline = controlledDeadline();
    const useCase = new GetHostedReadinessProjection(source, deadline.deadline, {
      nowMs: () => 1_000,
    });

    const result = await useCase.execute(context());

    expect(result.revision).toBe(1);
    expect(deadline.schedule).toHaveBeenCalledWith(100, expect.any(Function));
    expect(deadline.cancel).toHaveBeenCalledOnce();
    expect(source.readProjection).toHaveBeenCalledOnce();
    expect(source.readProjection).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      deadlineAtMs: 1_100,
      signal: expect.any(AbortSignal),
    });
  });

  it('enforces the deployment and boot fence', async () => {
    const source = {
      readProjection: () => ({ ...projection(1), bootId: 'boot_stale' }),
    };
    const useCase = new GetHostedReadinessProjection(source, controlledDeadline().deadline, {
      nowMs: () => 1_000,
    });

    await expect(useCase.execute(context())).rejects.toMatchObject({
      code: 'source_fence_mismatch',
    });
  });

  it('accepts monotonic revisions and rejects stale or conflicting equal revisions', async () => {
    const source = { readProjection: vi.fn() };
    const useCase = new GetHostedReadinessProjection(source, controlledDeadline().deadline, {
      nowMs: () => 1_000,
    });
    source.readProjection.mockReturnValueOnce(projection(2));
    source.readProjection.mockReturnValueOnce(projection(3));
    source.readProjection.mockReturnValueOnce(projection(2));
    source.readProjection.mockReturnValueOnce(projection(3, 'dependency_unavailable'));

    await expect(useCase.execute(context())).resolves.toMatchObject({ revision: 2 });
    await expect(useCase.execute(context())).resolves.toMatchObject({ revision: 3 });
    await expect(useCase.execute(context())).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(useCase.execute(context())).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('cancels a hung source on caller abort and deadline without waiting for it', async () => {
    const signals: AbortSignal[] = [];
    const source: HostedReadinessProjectionSourcePort = {
      readProjection(request) {
        signals.push(request.signal);
        return new Promise(() => undefined);
      },
    };
    const firstDeadline = controlledDeadline();
    const first = new GetHostedReadinessProjection(source, firstDeadline.deadline, {
      nowMs: () => 1_000,
    });
    const caller = new AbortController();
    const callerResult = first.execute(context(caller.signal));
    await Promise.resolve();
    caller.abort();
    await expect(callerResult).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(signals[0]?.aborted).toBe(true);
    expect(firstDeadline.cancel).toHaveBeenCalledOnce();

    const secondDeadline = controlledDeadline();
    const second = new GetHostedReadinessProjection(source, secondDeadline.deadline, {
      nowMs: () => 1_000,
    });
    const deadlineResult = second.execute(context());
    await Promise.resolve();
    secondDeadline.fire();
    await expect(deadlineResult).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(signals[1]?.aborted).toBe(true);
    expect(secondDeadline.cancel).toHaveBeenCalledOnce();
  });

  it('fails hostile or diagnostic-bearing source output closed', async () => {
    const source = {
      readProjection: () => ({ ...projection(1), checks: [{ probeId: 'private-probe' }] }),
    };
    const useCase = new GetHostedReadinessProjection(source, controlledDeadline().deadline, {
      nowMs: () => 1_000,
    });
    await expect(useCase.execute(context())).rejects.toMatchObject({ code: 'source_invalid' });
  });
});
