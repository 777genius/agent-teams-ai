import {
  HOSTED_READINESS_PROBE_FAILURE_REASON,
  HostedReadiness,
  type HostedReadinessProbe,
} from '@main/composition/hosted/application';
import { describe, expect, it, vi } from 'vitest';

describe('HostedReadiness', () => {
  it('tracks readiness transitions and preserves probe order', async () => {
    let storageReady = false;
    const storage = {
      id: 'storage',
      readiness: vi.fn(async () => ({
        ready: storageReady,
        reasons: storageReady ? [] : ['recovering'],
      })),
    } satisfies HostedReadinessProbe;
    const listener = {
      id: 'listener',
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    } satisfies HostedReadinessProbe;
    const readiness = new HostedReadiness([storage, listener]);

    await expect(readiness.readiness()).resolves.toEqual({
      ready: false,
      checks: [
        { componentId: 'storage', ready: false, reasons: ['recovering'] },
        { componentId: 'listener', ready: true, reasons: [] },
      ],
    });

    storageReady = true;
    await expect(readiness.readiness()).resolves.toEqual({
      ready: true,
      checks: [
        { componentId: 'storage', ready: true, reasons: [] },
        { componentId: 'listener', ready: true, reasons: [] },
      ],
    });
  });

  it('fails closed on thrown and malformed probe results while checking every component', async () => {
    const probeFailure = new Error('probe unavailable');
    const throwing = {
      id: 'throwing',
      readiness: vi.fn(async () => {
        throw probeFailure;
      }),
    } satisfies HostedReadinessProbe;
    const malformed = {
      id: 'malformed',
      readiness: vi.fn(async () => ({ ready: true, reasons: [1] }) as never),
    } satisfies HostedReadinessProbe;
    const healthy = {
      id: 'healthy',
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    } satisfies HostedReadinessProbe;

    const report = await new HostedReadiness([throwing, malformed, healthy]).readiness();

    expect(report.ready).toBe(false);
    expect(report.checks[0]).toEqual({
      componentId: 'throwing',
      ready: false,
      reasons: [HOSTED_READINESS_PROBE_FAILURE_REASON],
      error: probeFailure,
    });
    expect(report.checks[1]).toMatchObject({
      componentId: 'malformed',
      ready: false,
      reasons: [HOSTED_READINESS_PROBE_FAILURE_REASON],
      error: expect.any(TypeError),
    });
    expect(report.checks[2]).toEqual({ componentId: 'healthy', ready: true, reasons: [] });
    expect(healthy.readiness).toHaveBeenCalledOnce();
  });

  it('returns an immutable ready report when no components are required', async () => {
    const report = await new HostedReadiness([]).readiness();

    expect(report).toEqual({ ready: true, checks: [] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
  });

  it('rejects duplicate probe identities at composition time', () => {
    const probe = {
      id: 'duplicate',
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    } satisfies HostedReadinessProbe;

    expect(() => new HostedReadiness([probe, probe])).toThrowError(
      'Invalid or duplicate hosted readiness probe id: duplicate'
    );
  });
});
