import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { InheritedFdRuntimeIngressSecretSource } from '@features/team-runtime-control/main/adapters/output/runtime-ingress/InheritedFdRuntimeIngressSecretSource';
import { parseDeploymentId, parseMemberId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRuntimeIngressAdapterHarness,
  CREDENTIAL_ID,
  FixtureRuntimeIngressRelayAuthoritySource,
  PLAN_REF,
  runtimeIngressBody,
  runtimeIngressHttpRequest,
  SCOPE,
  SECRET,
} from './fixtures/runtimeIngressAdapterHarness';

const fixtureDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-ingress-relay-fixture-'));
  fixtureDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('fixed-scope controller runtime ingress relay', () => {
  it('binds one opaque handle to persisted lane authority and revokes it on close', async () => {
    const harness = await createRuntimeIngressAdapterHarness(await fixtureDirectory(), {
      allowedVerbs: ['runtime.bootstrap-checkin'],
    });
    const openRequest = {
      planRef: PLAN_REF,
      laneId: SCOPE.laneId,
      memberIds: [harness.issued.session.deliveryOwnerId],
      credentialGeneration: 1,
      allowedVerbs: ['runtime.bootstrap-checkin'] as const,
    };
    const opened = await harness.feature.relay.open(openRequest);
    expect(opened).toMatchObject({ status: 'opened' });
    if (opened.status === 'rejected') throw new Error('relay-fixture-open-rejected');
    expect(harness.secretSource.consumeCount).toBe(1);

    await expect(harness.feature.relay.open(openRequest)).resolves.toEqual({
      status: 'already_open',
      relayRef: opened.relayRef,
      laneRelayHandle: opened.laneRelayHandle,
    });
    expect(harness.secretSource.consumeCount).toBe(1);

    await expect(
      harness.feature.relay.dispatch({
        laneRelayHandle: opened.laneRelayHandle,
        verb: 'runtime.bootstrap-checkin',
        rawBody: runtimeIngressBody(),
      })
    ).resolves.toMatchObject({
      status: 'delivered',
      result: { status: 'accepted' },
    });
    await expect(
      harness.feature.relay.dispatch({
        laneRelayHandle: opened.laneRelayHandle,
        verb: 'runtime.heartbeat',
        rawBody: runtimeIngressBody(),
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'verb_not_allowed' });

    await expect(
      harness.feature.relay.dispatch({
        laneRelayHandle: opened.laneRelayHandle,
        verb: 'runtime.bootstrap-checkin',
        rawBody: JSON.stringify({
          ...JSON.parse(runtimeIngressBody()),
          teamName: 'forged-team',
        }),
      })
    ).resolves.toMatchObject({
      status: 'delivered',
      result: { status: 'rejected', reason: 'bad_request' },
    });

    await expect(
      harness.feature.relay.close({
        planRef: PLAN_REF,
        laneId: SCOPE.laneId,
        relayRef: opened.relayRef,
      })
    ).resolves.toEqual({ status: 'closed' });
    await expect(
      harness.feature.relay.dispatch({
        laneRelayHandle: opened.laneRelayHandle,
        verb: 'runtime.bootstrap-checkin',
        rawBody: runtimeIngressBody(),
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'handle_invalid' });
    await expect(
      harness.feature.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({ statusCode: 401 });
  });

  it('rejects a server-plan member mismatch before consuming the one-use bearer', async () => {
    const harness = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    await expect(
      harness.feature.relay.open({
        planRef: PLAN_REF,
        laneId: SCOPE.laneId,
        memberIds: [parseMemberId(`member_${'f'.repeat(32)}`)],
        credentialGeneration: 1,
        allowedVerbs: SCOPE.allowedVerbs,
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'stale_plan' });
    expect(harness.secretSource.consumeCount).toBe(0);
  });

  it('binds relay admission to the exact trusted plan hash, provider, and deployment', async () => {
    const planHarness = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    await expect(
      planHarness.feature.relay.open({
        planRef: { ...PLAN_REF, planHash: `sha256:${'e'.repeat(64)}` as typeof PLAN_REF.planHash },
        laneId: SCOPE.laneId,
        memberIds: [planHarness.issued.session.deliveryOwnerId],
        credentialGeneration: 1,
        allowedVerbs: SCOPE.allowedVerbs,
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'stale_plan' });
    expect(planHarness.secretSource.consumeCount).toBe(0);

    const differentPlanRef = {
      ...PLAN_REF,
      planHash: `sha256:${'e'.repeat(64)}` as typeof PLAN_REF.planHash,
    };
    const differentPlanAuthority = new FixtureRuntimeIngressRelayAuthoritySource({
      planRef: differentPlanRef,
      deploymentId: SCOPE.deploymentId,
      providerId: SCOPE.providerId,
      laneId: SCOPE.laneId,
      memberIds: [planHarness.issued.session.deliveryOwnerId],
      credentialGeneration: 1,
      allowedVerbs: SCOPE.allowedVerbs,
    });
    const persistedPlanHarness = await createRuntimeIngressAdapterHarness(
      await fixtureDirectory(),
      {
        relayAuthoritySource: differentPlanAuthority,
      }
    );
    await expect(
      persistedPlanHarness.feature.relay.open({
        planRef: differentPlanRef,
        laneId: SCOPE.laneId,
        memberIds: [persistedPlanHarness.issued.session.deliveryOwnerId],
        credentialGeneration: 1,
        allowedVerbs: SCOPE.allowedVerbs,
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'stale_plan' });
    expect(persistedPlanHarness.secretSource.consumeCount).toBe(0);

    const providerAuthority = new FixtureRuntimeIngressRelayAuthoritySource({
      planRef: PLAN_REF,
      deploymentId: SCOPE.deploymentId,
      providerId: 'codex',
      laneId: SCOPE.laneId,
      memberIds: [planHarness.issued.session.deliveryOwnerId],
      credentialGeneration: 1,
      allowedVerbs: SCOPE.allowedVerbs,
    });
    const providerHarness = await createRuntimeIngressAdapterHarness(await fixtureDirectory(), {
      relayAuthoritySource: providerAuthority,
    });
    await expect(
      providerHarness.feature.relay.open({
        planRef: PLAN_REF,
        laneId: SCOPE.laneId,
        memberIds: [providerHarness.issued.session.deliveryOwnerId],
        credentialGeneration: 1,
        allowedVerbs: SCOPE.allowedVerbs,
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'stale_plan' });
    expect(providerHarness.secretSource.consumeCount).toBe(0);

    const deploymentAuthority = new FixtureRuntimeIngressRelayAuthoritySource({
      planRef: PLAN_REF,
      deploymentId: parseDeploymentId('deployment_runtime-ingress-different'),
      providerId: SCOPE.providerId,
      laneId: SCOPE.laneId,
      memberIds: [planHarness.issued.session.deliveryOwnerId],
      credentialGeneration: 1,
      allowedVerbs: SCOPE.allowedVerbs,
    });
    const deploymentHarness = await createRuntimeIngressAdapterHarness(await fixtureDirectory(), {
      relayAuthoritySource: deploymentAuthority,
    });
    await expect(
      deploymentHarness.feature.relay.open({
        planRef: PLAN_REF,
        laneId: SCOPE.laneId,
        memberIds: [deploymentHarness.issued.session.deliveryOwnerId],
        credentialGeneration: 1,
        allowedVerbs: SCOPE.allowedVerbs,
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'stale_plan' });
    expect(deploymentHarness.secretSource.consumeCount).toBe(0);
  });

  it('claims inherited descriptors once and closes them on rejected scope and deadline', async () => {
    const directory = await fixtureDirectory();
    const rejectedPath = join(directory, 'rejected-secret');
    await writeFile(rejectedPath, SECRET, { mode: 0o600 });
    const rejectedFd = openSync(rejectedPath, 'r');
    const rejected = new InheritedFdRuntimeIngressSecretSource(rejectedFd, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 1_000,
    });
    try {
      expect(
        () =>
          new InheritedFdRuntimeIngressSecretSource(rejectedFd, CREDENTIAL_ID, SCOPE, {
            disposeAfterMs: 1_000,
          })
      ).toThrow(/claimed/);
      await expect(
        rejected.consume({
          credentialId: CREDENTIAL_ID,
          expectedScope: { ...SCOPE, credentialGeneration: 2 },
        })
      ).resolves.toEqual({ status: 'rejected' });
      expect(() => fstatSync(rejectedFd)).toThrow();
    } finally {
      try {
        closeSync(rejectedFd);
      } catch {
        // The source owns closure on every terminal path.
      }
    }

    const expiredPath = join(directory, 'expired-secret');
    await writeFile(expiredPath, SECRET, { mode: 0o600 });
    const expiredFd = openSync(expiredPath, 'r');
    const expired = new InheritedFdRuntimeIngressSecretSource(expiredFd, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 5,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(
        expired.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE })
      ).resolves.toEqual({ status: 'unavailable' });
      expect(() => fstatSync(expiredFd)).toThrow();
    } finally {
      try {
        closeSync(expiredFd);
      } catch {
        // The deadline owns closure before consumption.
      }
    }

    const consumedPath = join(directory, 'consumed-secret');
    await writeFile(consumedPath, SECRET, { mode: 0o600 });
    const consumedFd = openSync(consumedPath, 'r');
    const consumed = new InheritedFdRuntimeIngressSecretSource(consumedFd, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 1_000,
    });
    try {
      await expect(
        consumed.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE })
      ).resolves.toEqual({ status: 'consumed', secret: SECRET });
      expect(() => fstatSync(consumedFd)).toThrow();
      await expect(
        consumed.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE })
      ).resolves.toEqual({ status: 'rejected' });
    } finally {
      try {
        closeSync(consumedFd);
      } catch {
        // Successful consumption owns closure too.
      }
    }

    const pendingStream = new PassThrough();
    const pending = new InheritedFdRuntimeIngressSecretSource(987_654, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 5,
      createReadStream: () => pendingStream,
    });
    await expect(
      pending.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE })
    ).resolves.toEqual({ status: 'unavailable' });

    const disposableStream = new PassThrough();
    const disposable = new InheritedFdRuntimeIngressSecretSource(987_655, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 1_000,
      createReadStream: () => disposableStream,
    });
    const consuming = disposable.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE });
    await disposable.dispose();
    await expect(consuming).resolves.toEqual({ status: 'unavailable' });
  });

  it('serializes concurrent inherited-FD consumers through deadline, cancellation, and disposal', async () => {
    vi.useFakeTimers();
    try {
      const deadlineStream = new PassThrough();
      let deadlineStreams = 0;
      const deadline = new InheritedFdRuntimeIngressSecretSource(987_656, CREDENTIAL_ID, SCOPE, {
        disposeAfterMs: 10,
        createReadStream: () => {
          deadlineStreams += 1;
          return deadlineStream;
        },
      });
      const deadlineCalls = [
        deadline.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
        deadline.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
      ];
      await Promise.resolve();
      expect(deadlineStreams).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await expect(Promise.all(deadlineCalls)).resolves.toEqual([
        { status: 'unavailable' },
        { status: 'unavailable' },
      ]);
      expect(deadlineStreams).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    const cancelledStream = new PassThrough();
    let cancelledStreams = 0;
    const cancelled = new InheritedFdRuntimeIngressSecretSource(987_657, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 1_000,
      createReadStream: () => {
        cancelledStreams += 1;
        return cancelledStream;
      },
    });
    const cancelledCalls = [
      cancelled.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
      cancelled.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
    ];
    await Promise.resolve();
    cancelledStream.destroy();
    await expect(Promise.all(cancelledCalls)).resolves.toEqual([
      { status: 'unavailable' },
      { status: 'unavailable' },
    ]);
    expect(cancelledStreams).toBe(1);

    const disposedStream = new PassThrough();
    let disposedStreams = 0;
    const disposed = new InheritedFdRuntimeIngressSecretSource(987_658, CREDENTIAL_ID, SCOPE, {
      disposeAfterMs: 1_000,
      createReadStream: () => {
        disposedStreams += 1;
        return disposedStream;
      },
    });
    const disposedCalls = [
      disposed.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
      disposed.consume({ credentialId: CREDENTIAL_ID, expectedScope: SCOPE }),
    ];
    await Promise.resolve();
    await disposed.dispose();
    await expect(Promise.all(disposedCalls)).resolves.toEqual([
      { status: 'unavailable' },
      { status: 'unavailable' },
    ]);
    expect(disposedStreams).toBe(1);
  });
});
