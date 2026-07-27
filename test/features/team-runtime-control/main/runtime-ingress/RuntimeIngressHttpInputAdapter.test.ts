import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { parseLaneId } from '@features/team-runtime-control/contracts';
import {
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressSessionId,
} from '@features/team-runtime-control/core/domain/runtime-ingress';
import {
  acquireStoreLock,
  deriveRuntimeIngressPortableProcessInstanceId,
  publishSnapshotFile,
  readRuntimeIngressProcessInstanceId,
  resolveStorePaths,
  runtimeIngressWindowsLockHelperEnvironment,
} from '@features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressFileStoreIo';
import { createRuntimeIngressFeature } from '@features/team-runtime-control/main/composition/createRuntimeIngressFeature';
import { parseRunId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTED_AT,
  createRuntimeIngressAdapterHarness,
  CREDENTIAL_ID,
  DELIVERY_OWNER_ID,
  FixtureRelaySecretSource,
  FixtureRuntimeIngressProcessIdentityProbe,
  KEYRING,
  NEXT_CREDENTIAL_ID,
  NEXT_SECRET,
  NEXT_SESSION_ID,
  PLAN_REF,
  PROCESS_INSTANCE_ID,
  REUSED_PROCESS_INSTANCE_ID,
  REVOKED_AT,
  ROTATED_AT,
  runtimeIngressBody,
  runtimeIngressHttpRequest,
  runtimeIngressRotation,
  SCOPE,
  SECRET,
} from './fixtures/runtimeIngressAdapterHarness';

const fixtureDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-ingress-http-fixture-'));
  fixtureDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('private runtime ingress HTTP adapter', () => {
  it('persists one exact acknowledgement and replays it after restart', async () => {
    const directory = await fixtureDirectory();
    const first = await createRuntimeIngressAdapterHarness(directory);
    const canonicalBody = JSON.stringify({
      observedAtIso: '2026-07-27T10:00:30.000Z',
      payload: { z: 1, a: { z: false, a: true } },
      sequence: 1,
      commandId: 'command:fixture:bootstrap:1',
      runtimeInstanceId: 'runtime-instance:fixture:1',
    });
    const request = runtimeIngressHttpRequest(canonicalBody);

    const accepted = await first.feature.httpInput.handle(request);
    expect(accepted).toMatchObject({
      statusCode: 202,
      headers: { 'cache-control': 'no-store' },
      body: { status: 'accepted', acceptedAtIso: ACCEPTED_AT },
    });
    if (!('acknowledgementId' in accepted.body)) {
      throw new Error('runtime-ingress-acceptance-fixture-rejected');
    }
    expect(JSON.stringify(accepted)).not.toContain(SECRET);
    expect(JSON.stringify(accepted)).not.toContain(SCOPE.teamId);

    const restarted = createRuntimeIngressFeature({
      snapshotPath: join(directory, 'runtime-ingress-state.json'),
      keyring: KEYRING,
      antiRollbackFence: first.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: first.relayAuthoritySource,
      clock: first.clock,
      nextRequestId: () => 'runtime-request:restart',
    });
    const replayed = await restarted.httpInput.handle(request);
    expect(replayed).toMatchObject({
      statusCode: 200,
      body: {
        status: 'replayed',
        acknowledgementId: accepted.body.acknowledgementId,
        effectRef: accepted.body.effectRef,
      },
    });

    const conflict = await restarted.httpInput.handle(
      runtimeIngressHttpRequest(runtimeIngressBody({ a: { a: true, z: true }, z: 1 }))
    );
    expect(conflict).toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });

    const snapshotText = await readFile(join(directory, 'runtime-ingress-state.json'), 'utf8');
    const snapshotMode = (await stat(join(directory, 'runtime-ingress-state.json'))).mode & 0o777;
    const snapshot = JSON.parse(snapshotText) as {
      effects: { authority: unknown; payloadJson: string }[];
    };
    expect(snapshotText).not.toContain(SECRET);
    expect(snapshotMode).toBe(0o600);
    expect(snapshot.effects).toHaveLength(1);
    expect(snapshot.effects[0]).toMatchObject({
      authority: {
        teamId: SCOPE.teamId,
        runId: SCOPE.runId,
        laneId: SCOPE.laneId,
        credentialGeneration: 1,
      },
      payloadJson: '{"a":{"a":true,"z":false},"z":1}',
    });
  });

  it('serializes concurrent identical and conflicting command claims exactly once', async () => {
    const identical = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    const [first, second] = await Promise.all([
      identical.feature.httpInput.handle(runtimeIngressHttpRequest()),
      identical.feature.httpInput.handle(runtimeIngressHttpRequest()),
    ]);
    expect(
      [first.body, second.body]
        .map((body) => ('status' in body ? body.status : 'error'))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(['accepted', 'replayed']);
    if (!('acknowledgementId' in first.body) || !('acknowledgementId' in second.body)) {
      throw new Error('runtime-ingress-identical-concurrency-rejected');
    }
    expect(second.body.acknowledgementId).toBe(first.body.acknowledgementId);

    const conflicting = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    const [left, right] = await Promise.all([
      conflicting.feature.httpInput.handle(runtimeIngressHttpRequest()),
      conflicting.feature.httpInput.handle(
        runtimeIngressHttpRequest(runtimeIngressBody({ state: 'conflicting' }))
      ),
    ]);
    expect([left.statusCode, right.statusCode].sort((left, right) => left - right)).toEqual([
      202, 409,
    ]);
    const snapshot = JSON.parse(
      await readFile(
        join(fixtureDirectories[fixtureDirectories.length - 1], 'runtime-ingress-state.json'),
        'utf8'
      )
    ) as { effects: unknown[] };
    expect(snapshot.effects).toHaveLength(1);
  });

  it('serializes writers from distinct store instances under one durable generation', async () => {
    const directory = await fixtureDirectory();
    const initial = await createRuntimeIngressAdapterHarness(directory);
    const dependencies = {
      snapshotPath: join(directory, 'runtime-ingress-state.json'),
      keyring: KEYRING,
      antiRollbackFence: initial.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: initial.relayAuthoritySource,
      clock: initial.clock,
    };
    const left = createRuntimeIngressFeature(dependencies);
    const right = createRuntimeIngressFeature(dependencies);
    const rotation = {
      previousCredentialId: CREDENTIAL_ID,
      credentialId: NEXT_CREDENTIAL_ID,
      presentedSecret: NEXT_SECRET,
      scope: { ...SCOPE, credentialGeneration: 2 },
      planRef: PLAN_REF,
      sessionId: NEXT_SESSION_ID,
      deliveryOwnerId: DELIVERY_OWNER_ID,
      issuedAtIso: ROTATED_AT,
      revocationReason: 'cross-process-generation-race',
    } as const;

    const outcomes = await Promise.all([
      left.store.rotateCredential(rotation),
      right.store.rotateCredential(rotation),
    ]);
    expect(
      outcomes.map((outcome) => outcome.status).sort((left, right) => left.localeCompare(right))
    ).toEqual(['conflict', 'rotated']);

    const snapshot = JSON.parse(
      await readFile(join(directory, 'runtime-ingress-state.json'), 'utf8')
    ) as {
      generation: number;
      credentials: { phase: string }[];
    };
    expect(snapshot.generation).toBe(2);
    expect(snapshot.credentials.filter((credential) => credential.phase === 'active')).toHaveLength(
      1
    );

    const lockPath = join(directory, '.runtime-ingress-state.json.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        lockVersion: 2,
        ownerPid: 2_147_483_647,
        ownerInstanceId: PROCESS_INSTANCE_ID,
        token: '00000000-0000-4000-8000-000000000000',
      }),
      { mode: 0o600 }
    );
    const recovered = createRuntimeIngressFeature({
      ...dependencies,
      storeLimits: { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
    });
    await expect(recovered.store.loadCredential(CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers incomplete orphan locks while preserving live-owner exclusion', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory, {
      storeLimits: { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
    });
    const lockPath = join(directory, '.runtime-ingress-state.json.lock');

    await writeFile(lockPath, '', { mode: 0o600 });
    await expect(harness.feature.store.loadCredential(CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(lockPath, '{"lockVersion":', { mode: 0o600 });
    await expect(harness.feature.store.loadCredential(CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const ownerInstanceId = await readRuntimeIngressProcessInstanceId(process.pid);
    if (!ownerInstanceId) throw new Error('runtime-ingress-live-owner-identity-unavailable');
    const liveRecord = JSON.stringify({
      lockVersion: 2,
      ownerPid: process.pid,
      ownerInstanceId,
      token: '00000000-0000-4000-8000-000000000001',
    });
    await writeFile(lockPath, liveRecord, { mode: 0o600 });
    await expect(harness.feature.store.loadCredential(CREDENTIAL_ID)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(await readFile(lockPath, 'utf8')).toBe(liveRecord);
    expect((await readdir(directory)).filter((name) => name.endsWith('.candidate'))).toEqual([]);
    await unlink(lockPath);
  });

  it('reclaims a reused PID only when its process-instance identity differs', async () => {
    const paths = await resolveStorePaths(
      join(await fixtureDirectory(), 'runtime-ingress-state.json')
    );
    const processIdentity = new FixtureRuntimeIngressProcessIdentityProbe(
      1,
      REUSED_PROCESS_INSTANCE_ID
    );
    const staleRecord = JSON.stringify({
      lockVersion: 2,
      ownerPid: 1,
      ownerInstanceId: PROCESS_INSTANCE_ID,
      token: '00000000-0000-4000-8000-000000000010',
    });
    await writeFile(paths.lock, staleRecord, { mode: 0o600 });

    const lock = await acquireStoreLock(
      paths,
      { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
      processIdentity
    );
    const acquired = JSON.parse(await readFile(paths.lock, 'utf8')) as {
      ownerPid: number;
      ownerInstanceId: string;
      token: string;
    };
    expect(acquired).toMatchObject({
      ownerPid: 1,
      ownerInstanceId: REUSED_PROCESS_INSTANCE_ID,
    });
    expect(acquired.token).not.toBe('00000000-0000-4000-8000-000000000010');
    await lock.release();
    await expect(stat(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not resolve the portable process-instance probe through a hostile PATH', async () => {
    if (process.platform === 'win32') return;
    const directory = await fixtureDirectory();
    const markerPath = join(directory, 'hostile-ps-executed');
    await writeFile(
      join(directory, 'ps'),
      `#!/bin/sh\n: > "${markerPath}"\nprintf 'hostile process identity\\n'\n`,
      { mode: 0o700 }
    );
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = directory;
      await expect(readRuntimeIngressProcessInstanceId(process.pid, 'darwin')).resolves.toMatch(
        /^sha256:[a-f0-9]{64}$/
      );
      await expect(stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('uses the fail-closed invariant Windows process-start probe contract', async () => {
    if (process.platform !== 'win32') return;
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = await fixtureDirectory();
      await expect(readRuntimeIngressProcessInstanceId(process.pid)).resolves.toMatch(
        /^sha256:[a-f0-9]{64}$/
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('pins the Windows lock helper environment to one owned direct-child temp path', async () => {
    const paths = await resolveStorePaths(
      join(await fixtureDirectory(), 'runtime-ingress-state.json')
    );
    const token = '00000000-0000-4000-8000-000000000030';
    const helperName = `.${basename(paths.lockGuard)}.${token}.helper`;
    const helperTemp = join(paths.parent, helperName);
    const environment = runtimeIngressWindowsLockHelperEnvironment(
      paths,
      helperTemp,
      token,
      'C:\\Windows'
    );

    expect(environment).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: '',
      TEMP: helperTemp,
      TMP: helperTemp,
      USERPROFILE: helperTemp,
    });
    expect(Object.isFrozen(environment)).toBe(true);
    for (const unsafe of [
      helperName,
      join(paths.parent, 'nested', helperName),
      join(dirname(paths.parent), helperName),
      paths.parent,
    ]) {
      expect(() =>
        runtimeIngressWindowsLockHelperEnvironment(paths, unsafe, token, 'C:\\Windows')
      ).toThrow('runtime-ingress-store-os-lock-helper-temp-unsafe');
    }
    expect(() =>
      runtimeIngressWindowsLockHelperEnvironment(paths, helperTemp, token, 'C:\\Windows\\..')
    ).toThrow('runtime-ingress-store-os-lock-helper-temp-unsafe');
  });

  it('starts and cleans the Windows helper under non-admin ambient temp constraints', async () => {
    if (process.platform !== 'win32') return;
    const directory = await fixtureDirectory();
    const paths = await resolveStorePaths(join(directory, 'runtime-ingress-state.json'));
    const keys = ['TEMP', 'TMP', 'USERPROFILE'] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const helperEntries = async (): Promise<string[]> =>
      (await readdir(paths.parent)).filter(
        (name) => name.startsWith(`.${basename(paths.lockGuard)}.`) && name.endsWith('.helper')
      );
    try {
      for (const key of keys) process.env[key] = 'Z:\\ambient-temp-is-not-authority';
      const staleToken = '00000000-0000-4000-8000-000000000031';
      const staleHelper = join(paths.parent, `.${basename(paths.lockGuard)}.${staleToken}.helper`);
      await mkdir(staleHelper, { mode: 0o700 });
      await writeFile(
        paths.lock,
        JSON.stringify({
          lockVersion: 2,
          ownerPid: 2_147_483_647,
          ownerInstanceId: PROCESS_INSTANCE_ID,
          token: staleToken,
        }),
        { mode: 0o600 }
      );

      const lock = await acquireStoreLock(paths, {
        lockAcquireTimeoutMs: 2_000,
        lockRetryDelayMs: 5,
      });
      expect(await helperEntries()).toHaveLength(1);
      await publishSnapshotFile(paths, '{"generation":1}', lock);
      expect(await readFile(paths.snapshot, 'utf8')).toBe('{"generation":1}');
      await lock.release();
      expect(await helperEntries()).toEqual([]);

      const lost = await acquireStoreLock(
        paths,
        { lockAcquireTimeoutMs: 2_000, lockRetryDelayMs: 5 },
        undefined,
        { beforeSnapshotRename: async (loseHelperAuthority) => loseHelperAuthority() }
      );
      expect(await helperEntries()).toHaveLength(1);
      await expect(publishSnapshotFile(paths, '{"generation":2}', lost)).rejects.toThrow(
        'runtime-ingress-store-os-lock-lost'
      );
      await expect(lost.release()).rejects.toThrow('runtime-ingress-store-os-lock-lost');
      expect(await helperEntries()).toEqual([]);
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('strictly accepts one bounded invariant Windows UTC tick token', () => {
    const ticks = '638892676041234567';
    const identity = deriveRuntimeIngressPortableProcessInstanceId('win32', ticks);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(deriveRuntimeIngressPortableProcessInstanceId('win32', '638892676041234568')).not.toBe(
      identity
    );
    expect(
      deriveRuntimeIngressPortableProcessInstanceId('darwin', 'Mon Jul 27 18:46:44 2026\n')
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      deriveRuntimeIngressPortableProcessInstanceId('darwin', 'Tue Jul 27 18:46:44 2026\n')
    ).toBeNull();
    for (const malformed of [
      `${ticks}\n`,
      `${ticks}0`,
      `${ticks} extra`,
      `-${ticks}`,
      `0${ticks}`,
      '504911231999999999',
      '3155378976000000000',
    ]) {
      expect(deriveRuntimeIngressPortableProcessInstanceId('win32', malformed)).toBeNull();
    }
  });

  it('does not displace a verified live replacement that appears before orphan takeover', async () => {
    const paths = await resolveStorePaths(
      join(await fixtureDirectory(), 'runtime-ingress-state.json')
    );
    const processIdentity = new FixtureRuntimeIngressProcessIdentityProbe(
      2,
      REUSED_PROCESS_INSTANCE_ID
    );
    processIdentity.setLive(1, REUSED_PROCESS_INSTANCE_ID);
    processIdentity.setLive(3, PROCESS_INSTANCE_ID);
    await writeFile(
      paths.lock,
      JSON.stringify({
        lockVersion: 2,
        ownerPid: 1,
        ownerInstanceId: PROCESS_INSTANCE_ID,
        token: '00000000-0000-4000-8000-000000000020',
      }),
      { mode: 0o600 }
    );
    const replacementRecord = JSON.stringify({
      lockVersion: 2,
      ownerPid: 3,
      ownerInstanceId: PROCESS_INSTANCE_ID,
      token: '00000000-0000-4000-8000-000000000021',
    });
    processIdentity.afterNextRead(1, async () => {
      const replacementPath = `${paths.lock}.replacement`;
      await writeFile(replacementPath, replacementRecord, { mode: 0o600 });
      await rename(replacementPath, paths.lock);
    });

    await expect(
      acquireStoreLock(paths, { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 }, processIdentity)
    ).rejects.toThrow('runtime-ingress-store-lock-timeout');
    expect(await readFile(paths.lock, 'utf8')).toBe(replacementRecord);
    expect((await readdir(paths.parent)).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('leaves snapshot bytes unchanged when the lock helper is lost before rename', async () => {
    const paths = await resolveStorePaths(
      join(await fixtureDirectory(), 'runtime-ingress-state.json')
    );
    const processIdentity = new FixtureRuntimeIngressProcessIdentityProbe();
    const baseline = '{"generation":0}';
    await writeFile(paths.snapshot, baseline, { mode: 0o600 });
    let injectedLosses = 0;
    const lock = await acquireStoreLock(
      paths,
      { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
      processIdentity,
      {
        beforeSnapshotRename: async (loseHelperAuthority) => {
          injectedLosses += 1;
          await loseHelperAuthority();
        },
      }
    );

    await expect(publishSnapshotFile(paths, '{"generation":1}', lock)).rejects.toThrow(
      'runtime-ingress-store-os-lock-lost'
    );
    expect(injectedLosses).toBe(1);
    expect(await readFile(paths.snapshot, 'utf8')).toBe(baseline);
    expect((await readdir(paths.parent)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(paths.parent)).filter((name) => name.endsWith('.candidate'))).toEqual([]);
    await expect(lock.release()).rejects.toThrow('runtime-ingress-store-os-lock-lost');
  });

  it('does not steal a live same-instance lock or a live owner whose identity is unavailable', async () => {
    const directory = await fixtureDirectory();
    const paths = await resolveStorePaths(join(directory, 'runtime-ingress-state.json'));
    const processIdentity = new FixtureRuntimeIngressProcessIdentityProbe(
      2,
      REUSED_PROCESS_INSTANCE_ID
    );
    processIdentity.setLive(1, PROCESS_INSTANCE_ID);
    const liveRecord = JSON.stringify({
      lockVersion: 2,
      ownerPid: 1,
      ownerInstanceId: PROCESS_INSTANCE_ID,
      token: '00000000-0000-4000-8000-000000000011',
    });
    await writeFile(paths.lock, liveRecord, { mode: 0o600 });

    await expect(
      acquireStoreLock(paths, { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 }, processIdentity)
    ).rejects.toThrow('runtime-ingress-store-lock-timeout');
    expect(await readFile(paths.lock, 'utf8')).toBe(liveRecord);

    processIdentity.setLive(1, null);
    await expect(
      acquireStoreLock(paths, { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 }, processIdentity)
    ).rejects.toThrow('runtime-ingress-store-lock-timeout');
    expect(await readFile(paths.lock, 'utf8')).toBe(liveRecord);
    expect((await readdir(directory)).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('rejects tampered lock ownership and replaces only the malformed orphan record', async () => {
    const paths = await resolveStorePaths(
      join(await fixtureDirectory(), 'runtime-ingress-state.json')
    );
    const processIdentity = new FixtureRuntimeIngressProcessIdentityProbe();
    await writeFile(
      paths.lock,
      JSON.stringify({
        lockVersion: 2,
        ownerPid: processIdentity.currentPid,
        ownerInstanceId: 'untrusted-instance',
        token: '00000000-0000-4000-8000-000000000012',
      }),
      { mode: 0o600 }
    );
    const recovered = await acquireStoreLock(
      paths,
      { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
      processIdentity
    );
    const record = JSON.parse(await readFile(paths.lock, 'utf8')) as {
      lockVersion: 2;
      ownerPid: number;
      ownerInstanceId: string;
      token: string;
    };
    await writeFile(
      paths.lock,
      JSON.stringify({ ...record, ownerInstanceId: REUSED_PROCESS_INSTANCE_ID }),
      { mode: 0o600 }
    );
    await expect(recovered.assertOwned()).rejects.toThrow(
      'runtime-ingress-store-lock-ownership-lost'
    );
    await expect(recovered.release()).rejects.toThrow('runtime-ingress-store-lock-ownership-lost');

    const replacement = await acquireStoreLock(
      paths,
      { lockAcquireTimeoutMs: 20, lockRetryDelayMs: 5 },
      processIdentity
    );
    expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toMatchObject({
      lockVersion: 2,
      ownerPid: processIdentity.currentPid,
      ownerInstanceId: PROCESS_INSTANCE_ID,
    });
    await replacement.release();
  });

  it('canonicalizes prototype-shaped JSON keys without mutation or key loss', async () => {
    const harness = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    const payload = JSON.parse(
      '{"z":1,"__proto__":{"polluted":"no"},"constructor":{"prototype":{"polluted":"no"}}}'
    ) as Record<string, unknown>;

    await expect(
      harness.feature.httpInput.handle(runtimeIngressHttpRequest(runtimeIngressBody(payload)))
    ).resolves.toMatchObject({ statusCode: 202 });
    expect((Object.prototype as { polluted?: string }).polluted).toBeUndefined();

    const snapshot = JSON.parse(
      await readFile(
        join(fixtureDirectories[fixtureDirectories.length - 1], 'runtime-ingress-state.json'),
        'utf8'
      )
    ) as { effects: { payloadJson: string }[] };
    expect(snapshot.effects[0]?.payloadJson).toBe(
      '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"polluted":"no"}},"z":1}'
    );
  });

  it('derives authority and session ownership only from verified credential state', async () => {
    const harness = await createRuntimeIngressAdapterHarness(await fixtureDirectory());
    const forbiddenBodies = [
      { ...JSON.parse(runtimeIngressBody()), teamId: SCOPE.teamId },
      { ...JSON.parse(runtimeIngressBody()), runId: SCOPE.runId },
      { ...JSON.parse(runtimeIngressBody()), laneId: SCOPE.laneId },
      { ...JSON.parse(runtimeIngressBody()), cwd: '/fixture/raw-path' },
      { ...JSON.parse(runtimeIngressBody()), teamName: 'forged-team' },
      { ...JSON.parse(runtimeIngressBody()), topology: { lanes: [] } },
      { ...JSON.parse(runtimeIngressBody()), deliveryOwnerId: DELIVERY_OWNER_ID },
      {
        ...JSON.parse(runtimeIngressBody()),
        payload: { evidence: { previousLaunchState: 'forged' } },
      },
    ];

    for (const body of forbiddenBodies) {
      const encoded = JSON.stringify(body);
      await expect(
        harness.feature.httpInput.handle(runtimeIngressHttpRequest(encoded))
      ).resolves.toMatchObject({
        statusCode: 400,
        body: { error: { code: 'runtime_ingress_bad_request' } },
      });
    }

    await expect(
      harness.feature.httpInput.handle(
        runtimeIngressHttpRequest(undefined, {
          runId: parseRunId(`run_${'f'.repeat(32)}`),
        })
      )
    ).resolves.toMatchObject({
      statusCode: 403,
      body: { error: { code: 'runtime_ingress_scope_mismatch' } },
    });
    await expect(
      harness.feature.httpInput.handle(
        runtimeIngressHttpRequest(undefined, {
          authorizationHeader: `Bearer fixture.${'z'.repeat(64)}`,
        })
      )
    ).resolves.toMatchObject({
      statusCode: 401,
      body: { error: { code: 'runtime_ingress_unauthorized' } },
    });
    await expect(
      harness.feature.httpInput.handle({
        ...runtimeIngressHttpRequest(),
        authorizationHeader: undefined,
        credentialIdHeader: undefined,
        cookieHeader: 'hosted-session=fixture-browser-cookie',
      })
    ).resolves.toMatchObject({
      statusCode: 401,
      body: { error: { code: 'runtime_ingress_unauthorized' } },
    });
  });

  it('enforces bounded body and credential-scoped request rate before command execution', async () => {
    const bodyBounded = await createRuntimeIngressAdapterHarness(await fixtureDirectory(), {
      bodyLimitBytes: 180,
    });
    const fenceReads = bodyBounded.antiRollbackFence.validateCount;
    await expect(
      bodyBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(runtimeIngressBody({ evidence: 'x'.repeat(200) }))
      )
    ).resolves.toMatchObject({
      statusCode: 413,
      body: { error: { code: 'runtime_ingress_payload_too_large' } },
    });
    expect(bodyBounded.feature.httpInput.preMaterializationSizeFence).toEqual({
      maximumBodyBytes: 180,
      overflowStatusCode: 413,
      rejectBeforeBodyMaterialization: true,
    });
    await expect(
      bodyBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(undefined, {
          contentLengthHeader: '1',
          rawBody: new Uint8Array(181).fill(0xff),
        })
      )
    ).resolves.toMatchObject({
      statusCode: 413,
      body: { error: { code: 'runtime_ingress_payload_too_large' } },
    });
    expect(bodyBounded.antiRollbackFence.validateCount).toBe(fenceReads);

    const rateBounded = await createRuntimeIngressAdapterHarness(await fixtureDirectory(), {
      rateLimitPolicy: {
        globalRequestsPerWindow: 3,
        credentialRequestsPerWindow: 1,
        windowMs: 60_000,
        maxCredentialBuckets: 4,
      },
    });
    await expect(
      rateBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(undefined, {
          authorizationHeader: `Bearer fixture.${'z'.repeat(64)}`,
        })
      )
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      rateBounded.feature.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({ statusCode: 202 });
    await expect(
      rateBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { status: 'alive' },
            'command:fixture:heartbeat:2',
            2,
            '2026-07-27T10:00:40.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 429,
      headers: { 'retry-after': '60' },
      body: { error: { code: 'runtime_ingress_rate_limited', retryable: true } },
    });
  });

  it('rejects oversized snapshots and retains bounded replay identity across compaction', async () => {
    const byteBoundedDirectory = await fixtureDirectory();
    const byteBounded = await createRuntimeIngressAdapterHarness(byteBoundedDirectory, {
      storeLimits: { maxSnapshotBytes: 8 * 1024 },
    });
    await expect(
      byteBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(runtimeIngressBody({ evidence: 'x'.repeat(7 * 1024) }))
      )
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });
    const byteBoundedSnapshot = JSON.parse(
      await readFile(join(byteBoundedDirectory, 'runtime-ingress-state.json'), 'utf8')
    ) as { generation: number; effects: unknown[] };
    expect(byteBoundedSnapshot).toMatchObject({ generation: 1, effects: [] });
    expect((await readdir(byteBoundedDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    );

    const retentionBoundedDirectory = await fixtureDirectory();
    const retentionBounded = await createRuntimeIngressAdapterHarness(retentionBoundedDirectory, {
      storeLimits: { maxCommands: 1, maxEffects: 1, maxCompactedCommands: 3 },
    });
    await expect(
      retentionBounded.feature.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({ statusCode: 202 });
    const heartbeatRequest = runtimeIngressHttpRequest(
      runtimeIngressBody(
        { status: 'alive' },
        'command:fixture:heartbeat:2',
        2,
        '2026-07-27T10:00:40.000Z'
      ),
      { verb: 'runtime.heartbeat' }
    );
    const heartbeatAccepted = await retentionBounded.feature.httpInput.handle(heartbeatRequest);
    expect(heartbeatAccepted).toMatchObject({
      statusCode: 202,
      body: { status: 'accepted' },
    });
    if (!('acknowledgementId' in heartbeatAccepted.body)) {
      throw new Error('runtime-ingress-compaction-acceptance-fixture-rejected');
    }
    const retained = JSON.parse(
      await readFile(join(retentionBoundedDirectory, 'runtime-ingress-state.json'), 'utf8')
    ) as {
      commands: unknown[];
      effects: unknown[];
      replayCompaction: { compactedCommandCount: number; chainRoot: string };
    };
    expect(retained.commands).toHaveLength(1);
    expect(retained.effects).toHaveLength(1);
    expect(retained.replayCompaction).toMatchObject({ compactedCommandCount: 1 });
    expect(retained.replayCompaction.chainRoot).toMatch(/^sha256:[a-f0-9]{64}$/);
    const taskRequest = runtimeIngressHttpRequest(
      runtimeIngressBody(
        { taskId: 'task:fixture:3' },
        'command:fixture:task:3',
        3,
        '2026-07-27T10:00:50.000Z'
      ),
      { verb: 'runtime.task-event' }
    );
    await expect(retentionBounded.feature.httpInput.handle(taskRequest)).resolves.toMatchObject({
      statusCode: 202,
      body: { status: 'accepted' },
    });
    const heartbeatReplayed = await retentionBounded.feature.httpInput.handle(heartbeatRequest);
    expect(heartbeatReplayed).toMatchObject({
      statusCode: 200,
      body: {
        status: 'replayed',
        acknowledgementId: heartbeatAccepted.body.acknowledgementId,
        effectRef: heartbeatAccepted.body.effectRef,
      },
    });
    await expect(
      retentionBounded.feature.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { status: 'changed-intent' },
            'command:fixture:heartbeat:2',
            4,
            '2026-07-27T10:00:55.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });
    const fourthRequest = runtimeIngressHttpRequest(
      runtimeIngressBody(
        { status: 'alive' },
        'command:fixture:heartbeat:4',
        4,
        '2026-07-27T10:00:55.000Z'
      ),
      { verb: 'runtime.heartbeat' }
    );
    const fourthAccepted = await retentionBounded.feature.httpInput.handle(fourthRequest);
    expect(fourthAccepted).toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
    if (!('acknowledgementId' in fourthAccepted.body)) {
      throw new Error('runtime-ingress-rolling-compaction-fourth-fixture-rejected');
    }
    const fifthRequest = runtimeIngressHttpRequest(
      runtimeIngressBody(
        { taskId: 'task:fixture:5' },
        'command:fixture:task:5',
        5,
        '2026-07-27T10:00:56.000Z'
      ),
      { verb: 'runtime.task-event' }
    );
    const fifthAccepted = await retentionBounded.feature.httpInput.handle(fifthRequest);
    expect(fifthAccepted).toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
    if (!('acknowledgementId' in fifthAccepted.body)) {
      throw new Error('runtime-ingress-rolling-compaction-fixture-rejected');
    }
    const sixthRequest = runtimeIngressHttpRequest(
      runtimeIngressBody(
        { status: 'alive' },
        'command:fixture:heartbeat:6',
        6,
        '2026-07-27T10:00:57.000Z'
      ),
      { verb: 'runtime.heartbeat' }
    );
    await expect(retentionBounded.feature.httpInput.handle(sixthRequest)).resolves.toMatchObject({
      statusCode: 202,
      body: { status: 'accepted' },
    });
    const boundedReplay = JSON.parse(
      await readFile(join(retentionBoundedDirectory, 'runtime-ingress-state.json'), 'utf8')
    ) as {
      commands: { commandId: string }[];
      replayCompaction: {
        compactedCommandCount: number;
        retainedCommands: { commandId: string }[];
      };
    };
    expect(boundedReplay.commands).toHaveLength(1);
    expect(boundedReplay.replayCompaction).toMatchObject({
      compactedCommandCount: 5,
      retainedCommands: [
        { commandId: 'command:fixture:task:3' },
        { commandId: 'command:fixture:heartbeat:4' },
        { commandId: 'command:fixture:task:5' },
      ],
    });

    const restarted = createRuntimeIngressFeature({
      snapshotPath: join(retentionBoundedDirectory, 'runtime-ingress-state.json'),
      keyring: KEYRING,
      antiRollbackFence: retentionBounded.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: retentionBounded.relayAuthoritySource,
      clock: retentionBounded.clock,
      storeLimits: { maxCommands: 1, maxEffects: 1, maxCompactedCommands: 2 },
      nextRequestId: () => 'runtime-request:rolling-restart',
    });
    await expect(restarted.httpInput.handle(fourthRequest)).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: 'replayed',
        acknowledgementId: fourthAccepted.body.acknowledgementId,
        effectRef: fourthAccepted.body.effectRef,
      },
    });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { status: 'changed-intent' },
            'command:fixture:heartbeat:4',
            7,
            '2026-07-27T10:00:58.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });
    await expect(restarted.httpInput.handle(fifthRequest)).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: 'replayed',
        acknowledgementId: fifthAccepted.body.acknowledgementId,
        effectRef: fifthAccepted.body.effectRef,
      },
    });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { taskId: 'task:fixture:changed-intent' },
            'command:fixture:task:5',
            7,
            '2026-07-27T10:00:58.000Z'
          ),
          { verb: 'runtime.task-event' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { taskId: 'task:fixture:evicted-id-new-intent' },
            'command:fixture:task:3',
            7,
            '2026-07-27T10:00:58.000Z'
          ),
          { verb: 'runtime.task-event' }
        )
      )
    ).resolves.toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { taskId: 'task:fixture:8' },
            'command:fixture:task:8',
            8,
            '2026-07-27T10:00:59.000Z'
          ),
          { verb: 'runtime.task-event' }
        )
      )
    ).resolves.toMatchObject({ statusCode: 202, body: { status: 'accepted' } });

    const tamperedPath = join(retentionBoundedDirectory, 'runtime-ingress-state.json');
    const tamperedRetained = JSON.parse(await readFile(tamperedPath, 'utf8')) as {
      replayCompaction: {
        compactedCommandCount: number;
        retainedCommands: { commandId: string }[];
      };
    };
    expect(tamperedRetained.replayCompaction).toMatchObject({
      compactedCommandCount: 7,
      retainedCommands: [
        { commandId: 'command:fixture:heartbeat:6' },
        { commandId: 'command:fixture:task:3' },
      ],
    });
    tamperedRetained.replayCompaction.retainedCommands[0].commandId =
      'command:fixture:tampered-retained';
    await writeFile(tamperedPath, JSON.stringify(tamperedRetained), { mode: 0o600 });
    const tamperedRestart = createRuntimeIngressFeature({
      snapshotPath: tamperedPath,
      keyring: KEYRING,
      antiRollbackFence: retentionBounded.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: retentionBounded.relayAuthoritySource,
      clock: retentionBounded.clock,
      storeLimits: { maxCommands: 1, maxEffects: 1, maxCompactedCommands: 2 },
    });
    await expect(
      tamperedRestart.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });
  });

  it('keeps progressing through repeated 24 KiB exhaustion at 100-command bounds', async () => {
    const directory = await fixtureDirectory();
    const limits = {
      maxSnapshotBytes: 24 * 1024,
      maxCommands: 100,
      maxEffects: 100,
      maxCompactedCommands: 100,
    };
    const harness = await createRuntimeIngressAdapterHarness(directory, { storeLimits: limits });
    const requests = Array.from({ length: 10 }, (_, offset) => {
      const sequence = offset + 1;
      return runtimeIngressHttpRequest(
        runtimeIngressBody(
          { data: 'x'.repeat(2_000) },
          `command:fixture:byte-fill:${sequence}`,
          sequence,
          `2026-07-27T10:00:${String(29 + sequence).padStart(2, '0')}.000Z`
        ),
        { verb: sequence === 1 ? 'runtime.bootstrap-checkin' : 'runtime.heartbeat' }
      );
    });
    let newestAcknowledgementId = '';
    for (const request of requests) {
      const accepted = await harness.feature.httpInput.handle(request);
      expect(accepted).toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
      if (!('acknowledgementId' in accepted.body)) {
        throw new Error('runtime-ingress-byte-compaction-fixture-rejected');
      }
      newestAcknowledgementId = accepted.body.acknowledgementId;
      expect((await stat(join(directory, 'runtime-ingress-state.json'))).size).toBeLessThanOrEqual(
        limits.maxSnapshotBytes
      );
    }
    const byteCompacted = JSON.parse(
      await readFile(join(directory, 'runtime-ingress-state.json'), 'utf8')
    ) as { replayCompaction: { compactedCommandCount: number } };
    expect(byteCompacted.replayCompaction.compactedCommandCount).toBeGreaterThan(1);
    const newest = requests[requests.length - 1];
    await expect(harness.feature.httpInput.handle(newest)).resolves.toMatchObject({
      statusCode: 200,
      body: { status: 'replayed', acknowledgementId: newestAcknowledgementId },
    });

    const restarted = createRuntimeIngressFeature({
      snapshotPath: join(directory, 'runtime-ingress-state.json'),
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: limits,
    });
    await expect(restarted.httpInput.handle(newest)).resolves.toMatchObject({
      statusCode: 200,
      body: { status: 'replayed', acknowledgementId: newestAcknowledgementId },
    });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { data: 'changed-intent' },
            'command:fixture:byte-fill:10',
            11,
            '2026-07-27T10:00:40.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });
    await expect(
      restarted.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody({}, 'command:fixture:byte-tiny:11', 11, '2026-07-27T10:00:40.000Z'),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
  });

  it('keeps every repeated credential rotation durable within 24 KiB at 100-entry bounds', async () => {
    const directory = await fixtureDirectory();
    const snapshotPath = join(directory, 'runtime-ingress-state.json');
    const limits = {
      maxSnapshotBytes: 24 * 1024,
      maxCredentials: 100,
      maxSessions: 100,
      maxCommands: 100,
      maxEffects: 100,
      maxCompactedCommands: 100,
    };
    const harness = await createRuntimeIngressAdapterHarness(directory, { storeLimits: limits });
    let active: {
      credentialId: typeof CREDENTIAL_ID;
      secret: typeof SECRET;
      sessionId: typeof NEXT_SESSION_ID;
      scope: typeof SCOPE;
    } = {
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      sessionId: parseRuntimeIngressSessionId('runtime-session:fixture:1'),
      scope: SCOPE,
    };
    const revoked: (typeof active)[] = [];

    for (let generation = 2; generation <= 40; generation += 1) {
      const rotation = runtimeIngressRotation(generation, active.credentialId);
      const result = await harness.feature.store.rotateCredential(rotation);
      expect(result).toMatchObject({ status: 'rotated' });
      revoked.push(active);
      active = {
        credentialId: rotation.credentialId,
        secret: rotation.presentedSecret,
        sessionId: rotation.sessionId,
        scope: rotation.scope,
      };

      const serialized = await readFile(snapshotPath, 'utf8');
      const recoverySerialized = await readFile(`${snapshotPath}.recovery`, 'utf8');
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(limits.maxSnapshotBytes);
      expect(Buffer.byteLength(recoverySerialized, 'utf8')).toBeLessThanOrEqual(
        limits.maxSnapshotBytes
      );
      expect(recoverySerialized).toBe(serialized);
      const snapshot = JSON.parse(serialized) as {
        authentication: { algorithm: string; keyVersion: string; mac: string };
        credentials: { credentialId: string; phase: string }[];
        sessions: { sessionId: string }[];
        planBindings: { credentialId: string }[];
        credentialGenerationFences: {
          highestIssuedGeneration: number;
          revokedThroughGeneration: number;
          activeGeneration: number | null;
        }[];
      };
      expect(snapshot.authentication).toMatchObject({
        algorithm: 'hmac-sha256',
        keyVersion: KEYRING.activeFingerprintKeyVersion,
      });
      expect(snapshot.authentication.mac).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.credentials).toContainEqual(
        expect.objectContaining({
          credentialId: active.credentialId,
          phase: 'active',
        })
      );
      expect(snapshot.sessions).toContainEqual(
        expect.objectContaining({ sessionId: active.sessionId })
      );
      expect(snapshot.planBindings).toContainEqual(
        expect.objectContaining({ credentialId: active.credentialId })
      );
      expect(snapshot.credentialGenerationFences).toEqual([
        expect.objectContaining({
          highestIssuedGeneration: generation,
          revokedThroughGeneration: generation - 1,
          activeGeneration: generation,
        }),
      ]);
    }

    const finalSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      credentials: { credentialId: string }[];
    };
    const persistedCredentialIds = new Set(
      finalSnapshot.credentials.map(({ credentialId }) => credentialId)
    );
    const evicted = revoked.filter(({ credentialId }) => !persistedCredentialIds.has(credentialId));
    expect(evicted.length).toBeGreaterThan(0);
    expect(harness.antiRollbackFence.readCredentialGenerationFence(SCOPE)).toMatchObject({
      highestIssuedGeneration: 40,
      revokedThroughGeneration: 39,
      activeGeneration: 40,
    });

    const restarted = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: limits,
    });
    await expect(restarted.store.loadCredential(active.credentialId)).resolves.toMatchObject({
      status: 'found',
      credential: { credentialId: active.credentialId, phase: 'active' },
    });
    await expect(
      restarted.store.resolveCredentialContext({
        credentialId: active.credentialId,
        secret: active.secret,
      })
    ).resolves.toMatchObject({ status: 'resolved' });
    for (const prior of revoked) {
      await expect(
        restarted.store.resolveCredentialContext({
          credentialId: prior.credentialId,
          secret: prior.secret,
        })
      ).resolves.toEqual({ status: 'rejected' });
    }

    const increased = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: {
        maxSnapshotBytes: 128 * 1024,
        maxCredentials: 200,
        maxSessions: 200,
        maxCommands: 200,
        maxEffects: 200,
        maxCompactedCommands: 200,
      },
    });
    for (const prior of evicted) {
      await expect(increased.store.loadCredential(prior.credentialId)).resolves.toEqual({
        status: 'missing',
      });
    }
    await expect(
      increased.revokeRuntimeIngressCredential.execute({
        credentialId: active.credentialId,
        expectedScope: active.scope,
        revokedAtIso: REVOKED_AT,
        reason: 'complete-repeated-rotation-regression',
      })
    ).resolves.toEqual({ status: 'revoked' });
    expect(harness.antiRollbackFence.readCredentialGenerationFence(SCOPE)).toMatchObject({
      highestIssuedGeneration: 40,
      revokedThroughGeneration: 40,
      activeGeneration: null,
    });
    const afterFinalRevocation = await readFile(snapshotPath, 'utf8');
    const resurrection = evicted[0];
    await expect(
      increased.store.issueCredential({
        credentialId: resurrection.credentialId,
        presentedSecret: resurrection.secret,
        scope: resurrection.scope,
        planRef: PLAN_REF,
        sessionId: resurrection.sessionId,
        deliveryOwnerId: DELIVERY_OWNER_ID,
        issuedAtIso: REVOKED_AT,
      })
    ).resolves.toEqual({ status: 'unavailable' });
    expect(await readFile(snapshotPath, 'utf8')).toBe(afterFinalRevocation);
  });

  it('normalizes command, effect, and compacted decreases without restart re-increase resurrection', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory, {
      storeLimits: { maxCommands: 4, maxEffects: 4, maxCompactedCommands: 4 },
    });
    const requests = [
      runtimeIngressHttpRequest(),
      runtimeIngressHttpRequest(
        runtimeIngressBody(
          { status: 'alive' },
          'command:fixture:normalize:2',
          2,
          '2026-07-27T10:00:40.000Z'
        ),
        { verb: 'runtime.heartbeat' }
      ),
      runtimeIngressHttpRequest(
        runtimeIngressBody(
          { taskId: 'task:fixture:normalize:3' },
          'command:fixture:normalize:3',
          3,
          '2026-07-27T10:00:50.000Z'
        ),
        { verb: 'runtime.task-event' }
      ),
      runtimeIngressHttpRequest(
        runtimeIngressBody(
          { status: 'alive' },
          'command:fixture:normalize:4',
          4,
          '2026-07-27T10:00:55.000Z'
        ),
        { verb: 'runtime.heartbeat' }
      ),
      runtimeIngressHttpRequest(
        runtimeIngressBody(
          { taskId: 'task:fixture:normalize:5' },
          'command:fixture:normalize:5',
          5,
          '2026-07-27T10:00:56.000Z'
        ),
        { verb: 'runtime.task-event' }
      ),
    ];
    const acknowledgements: string[] = [];
    for (const request of requests) {
      const accepted = await harness.feature.httpInput.handle(request);
      expect(accepted).toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
      if (!('acknowledgementId' in accepted.body)) {
        throw new Error('runtime-ingress-normalization-fixture-rejected');
      }
      acknowledgements.push(accepted.body.acknowledgementId);
    }
    const snapshotPath = join(directory, 'runtime-ingress-state.json');
    const generationBefore = (
      JSON.parse(await readFile(snapshotPath, 'utf8')) as {
        generation: number;
      }
    ).generation;
    const lowLimits = { maxCommands: 1, maxEffects: 1, maxCompactedCommands: 2 };
    const lower = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: lowLimits,
    });
    await expect(lower.store.loadCredential(CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });
    const normalized = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      generation: number;
      commands: { commandId: string }[];
      effects: { claimKey: string }[];
      replayCompaction: { retainedCommands: { commandId: string }[] };
    };
    expect(normalized).toMatchObject({
      generation: generationBefore + 1,
      commands: [{ commandId: 'command:fixture:normalize:5' }],
      replayCompaction: {
        retainedCommands: [
          { commandId: 'command:fixture:normalize:3' },
          { commandId: 'command:fixture:normalize:4' },
        ],
      },
    });
    expect(normalized.effects).toHaveLength(1);
    expect(JSON.stringify(normalized)).not.toContain('command:fixture:normalize:2');
    expect(await readFile(`${snapshotPath}.recovery`, 'utf8')).toBe(
      await readFile(snapshotPath, 'utf8')
    );

    const lowerRestart = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: lowLimits,
    });
    await expect(lowerRestart.httpInput.handle(requests[3])).resolves.toMatchObject({
      statusCode: 200,
      body: { status: 'replayed', acknowledgementId: acknowledgements[3] },
    });
    await expect(
      lowerRestart.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { status: 'changed-intent' },
            'command:fixture:normalize:4',
            6,
            '2026-07-27T10:00:57.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });

    const increasedRestart = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: { maxCommands: 10, maxEffects: 10, maxCompactedCommands: 10 },
    });
    await expect(increasedRestart.httpInput.handle(requests[3])).resolves.toMatchObject({
      statusCode: 200,
      body: { status: 'replayed', acknowledgementId: acknowledgements[3] },
    });
    await expect(increasedRestart.httpInput.handle(requests[1])).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: 'runtime_ingress_conflict' } },
    });
    await expect(
      increasedRestart.httpInput.handle(
        runtimeIngressHttpRequest(
          runtimeIngressBody(
            { status: 'expired-id-new-intent' },
            'command:fixture:normalize:2',
            6,
            '2026-07-27T10:00:57.000Z'
          ),
          { verb: 'runtime.heartbeat' }
        )
      )
    ).resolves.toMatchObject({ statusCode: 202, body: { status: 'accepted' } });
  });

  it('normalizes credential fences on a 2-to-1 restart without resurrection after re-increase', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory, {
      storeLimits: { maxCredentials: 2, maxSessions: 2 },
    });
    const retainedScope = Object.freeze({
      ...SCOPE,
      laneId: parseLaneId('lane:opencode:retained'),
    });
    await expect(
      harness.feature.store.issueCredential({
        credentialId: NEXT_CREDENTIAL_ID,
        presentedSecret: NEXT_SECRET,
        scope: retainedScope,
        planRef: PLAN_REF,
        sessionId: NEXT_SESSION_ID,
        deliveryOwnerId: DELIVERY_OWNER_ID,
        issuedAtIso: ROTATED_AT,
      })
    ).resolves.toMatchObject({ status: 'issued' });
    await expect(
      harness.feature.revokeRuntimeIngressCredential.execute({
        credentialId: CREDENTIAL_ID,
        expectedScope: SCOPE,
        revokedAtIso: REVOKED_AT,
        reason: 'credential-retention-normalization',
      })
    ).resolves.toEqual({ status: 'revoked' });

    const snapshotPath = join(directory, 'runtime-ingress-state.json');
    const before = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      generation: number;
      credentials: unknown[];
      credentialGenerationFences: unknown[];
    };
    expect(before.credentials).toHaveLength(2);
    expect(before.credentialGenerationFences).toHaveLength(2);
    const lowLimits = { maxCredentials: 1, maxSessions: 1 };
    const lower = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: lowLimits,
    });
    await expect(lower.store.loadCredential(NEXT_CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });
    const normalizedSerialized = await readFile(snapshotPath, 'utf8');
    const normalized = JSON.parse(normalizedSerialized) as {
      generation: number;
      credentials: { credentialId: string }[];
      credentialGenerationFences: { laneId: string; activeGeneration: number | null }[];
    };
    expect(normalized.generation).toBe(before.generation + 1);
    expect(normalized.credentials).toHaveLength(1);
    expect(normalized.credentials.map(({ credentialId }) => credentialId)).toEqual([
      NEXT_CREDENTIAL_ID,
    ]);
    expect(normalized.credentialGenerationFences).toMatchObject([
      { laneId: retainedScope.laneId, activeGeneration: 1 },
    ]);
    expect(normalized.credentialGenerationFences).toHaveLength(1);
    expect(JSON.stringify(normalized)).not.toContain(CREDENTIAL_ID);
    expect(await readFile(`${snapshotPath}.recovery`, 'utf8')).toBe(normalizedSerialized);

    const lowerRestart = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: lowLimits,
    });
    await expect(lowerRestart.store.loadCredential(CREDENTIAL_ID)).resolves.toEqual({
      status: 'missing',
    });
    await expect(lowerRestart.store.loadCredential(NEXT_CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
    });

    const increasedRestart = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
      storeLimits: { maxCredentials: 4, maxSessions: 4 },
    });
    await expect(increasedRestart.store.loadCredential(CREDENTIAL_ID)).resolves.toEqual({
      status: 'missing',
    });
    await expect(
      increasedRestart.store.issueCredential({
        credentialId: CREDENTIAL_ID,
        presentedSecret: SECRET,
        scope: SCOPE,
        planRef: PLAN_REF,
        sessionId: parseRuntimeIngressSessionId('runtime-session:fixture:resurrection'),
        deliveryOwnerId: DELIVERY_OWNER_ID,
        issuedAtIso: REVOKED_AT,
      })
    ).resolves.toEqual({ status: 'unavailable' });
    expect(await readFile(snapshotPath, 'utf8')).toBe(normalizedSerialized);
  });

  it('authenticates one anchored no-follow bounded snapshot read', async () => {
    const tamperedDirectory = await fixtureDirectory();
    const tampered = await createRuntimeIngressAdapterHarness(tamperedDirectory);
    const tamperedPath = join(tamperedDirectory, 'runtime-ingress-state.json');
    const forged = JSON.parse(await readFile(tamperedPath, 'utf8')) as {
      credentials: { scope: { providerId: string } }[];
      sessions: { authorityScope: { providerId: string } }[];
    };
    forged.credentials[0].scope.providerId = 'codex';
    forged.sessions[0].authorityScope.providerId = 'codex';
    await writeFile(tamperedPath, JSON.stringify(forged), 'utf8');
    const tamperedRestart = createRuntimeIngressFeature({
      snapshotPath: tamperedPath,
      keyring: KEYRING,
      antiRollbackFence: tampered.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: tampered.relayAuthoritySource,
      clock: tampered.clock,
    });
    await expect(
      tamperedRestart.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });

    const symlinkDirectory = await fixtureDirectory();
    const symlinkHarness = await createRuntimeIngressAdapterHarness(symlinkDirectory);
    const symlinkPath = join(symlinkDirectory, 'runtime-ingress-state.json');
    const externalPath = join(await fixtureDirectory(), 'external-runtime-ingress-state.json');
    await writeFile(externalPath, await readFile(symlinkPath));
    await unlink(symlinkPath);
    await symlink(externalPath, symlinkPath);
    const symlinkRestart = createRuntimeIngressFeature({
      snapshotPath: symlinkPath,
      keyring: KEYRING,
      antiRollbackFence: symlinkHarness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: symlinkHarness.relayAuthoritySource,
      clock: symlinkHarness.clock,
    });
    await expect(
      symlinkRestart.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });
  });

  it('fails closed when the resolved snapshot parent is substituted', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory);
    const displaced = `${directory}-displaced`;
    fixtureDirectories.push(displaced);
    await rename(directory, displaced);
    await mkdir(directory, { mode: 0o700 });

    await expect(harness.feature.store.loadCredential(CREDENTIAL_ID)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('revokes old authority and rejects snapshot rollback or a reissued generation', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory);
    await expect(
      harness.feature.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({ statusCode: 202 });
    const preRotationSnapshot = await readFile(
      join(directory, 'runtime-ingress-state.json'),
      'utf8'
    );

    const rotated = await harness.feature.store.rotateCredential({
      previousCredentialId: CREDENTIAL_ID,
      credentialId: NEXT_CREDENTIAL_ID,
      presentedSecret: NEXT_SECRET,
      scope: { ...SCOPE, credentialGeneration: 2 },
      planRef: PLAN_REF,
      sessionId: NEXT_SESSION_ID,
      deliveryOwnerId: DELIVERY_OWNER_ID,
      issuedAtIso: ROTATED_AT,
      revocationReason: 'lane-restarted',
    });
    expect(rotated).toMatchObject({ status: 'rotated' });
    harness.clock.set(ROTATED_AT);

    await expect(
      harness.feature.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({ statusCode: 401 });
    const nextRequest = runtimeIngressHttpRequest(
      runtimeIngressBody({ state: 'restarted' }, 'command:fixture:bootstrap:2', 1, ROTATED_AT),
      {
        credentialIdHeader: NEXT_CREDENTIAL_ID,
        authorizationHeader: `Bearer ${NEXT_SECRET}`,
      }
    );
    await expect(harness.feature.httpInput.handle(nextRequest)).resolves.toMatchObject({
      statusCode: 202,
      body: { status: 'accepted' },
    });

    harness.clock.set(REVOKED_AT);
    await expect(
      harness.feature.revokeRuntimeIngressCredential.execute({
        credentialId: NEXT_CREDENTIAL_ID,
        expectedScope: { ...SCOPE, credentialGeneration: 2 },
        revokedAtIso: REVOKED_AT,
        reason: 'lane-stopped',
      })
    ).resolves.toEqual({ status: 'revoked' });
    await expect(harness.feature.httpInput.handle(nextRequest)).resolves.toMatchObject({
      statusCode: 401,
      body: { error: { code: 'runtime_ingress_unauthorized' } },
    });
    await expect(
      harness.feature.store.issueCredential({
        credentialId: parseRuntimeIngressCredentialId('credential:fixture:lane:rollback'),
        presentedSecret: SECRET,
        scope: SCOPE,
        planRef: PLAN_REF,
        sessionId: parseRuntimeIngressSessionId('runtime-session:fixture:rollback'),
        deliveryOwnerId: DELIVERY_OWNER_ID,
        issuedAtIso: REVOKED_AT,
      })
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      harness.feature.store.issueCredential({
        credentialId: parseRuntimeIngressCredentialId('credential:fixture:lane:plan-substitution'),
        presentedSecret: SECRET,
        scope: { ...SCOPE, credentialGeneration: 3 },
        planRef: {
          ...PLAN_REF,
          planHash: `sha256:${'e'.repeat(64)}` as typeof PLAN_REF.planHash,
        },
        sessionId: parseRuntimeIngressSessionId('runtime-session:fixture:plan-substitution'),
        deliveryOwnerId: DELIVERY_OWNER_ID,
        issuedAtIso: REVOKED_AT,
      })
    ).resolves.toEqual({ status: 'unavailable' });

    await writeFile(join(directory, 'runtime-ingress-state.json'), preRotationSnapshot, {
      mode: 0o600,
    });
    const rolledBack = createRuntimeIngressFeature({
      snapshotPath: join(directory, 'runtime-ingress-state.json'),
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
    });
    await expect(rolledBack.httpInput.handle(runtimeIngressHttpRequest())).resolves.toMatchObject({
      statusCode: 401,
      body: { error: { code: 'runtime_ingress_unauthorized' } },
    });
    const recovered = JSON.parse(
      await readFile(join(directory, 'runtime-ingress-state.json'), 'utf8')
    ) as { credentials: { phase: string }[] };
    expect(recovered.credentials.every((credential) => credential.phase === 'revoked')).toBe(true);
  });

  it('keeps a restored prior snapshot usable when fence advancement is unavailable', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory);
    const snapshotPath = join(directory, 'runtime-ingress-state.json');
    const recoveryPath = `${snapshotPath}.recovery`;
    const priorSnapshot = await readFile(snapshotPath, 'utf8');
    harness.antiRollbackFence.failNextSnapshotGenerationAdvance();

    await expect(
      harness.feature.revokeRuntimeIngressCredential.execute({
        credentialId: CREDENTIAL_ID,
        expectedScope: SCOPE,
        revokedAtIso: REVOKED_AT,
        reason: 'failed-fence-advance',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'storage_unavailable' });
    expect(await readFile(snapshotPath, 'utf8')).toBe(priorSnapshot);
    const recovery = JSON.parse(await readFile(recoveryPath, 'utf8')) as {
      generation: number;
      credentials: { credentialId: string; phase: string }[];
    };
    expect(recovery).toMatchObject({
      generation: 2,
      credentials: [{ credentialId: CREDENTIAL_ID, phase: 'revoked' }],
    });
    await writeFile(snapshotPath, priorSnapshot, { mode: 0o600 });

    const restarted = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
    });
    await expect(restarted.store.loadCredential(CREDENTIAL_ID)).resolves.toMatchObject({
      status: 'found',
      credential: { phase: 'active' },
    });
    await expect(restarted.httpInput.handle(runtimeIngressHttpRequest())).resolves.toMatchObject({
      statusCode: 202,
      body: { status: 'accepted' },
    });
  });

  it('recovers a newer journal after interruption follows durable fence advancement', async () => {
    const directory = await fixtureDirectory();
    const harness = await createRuntimeIngressAdapterHarness(directory);
    const snapshotPath = join(directory, 'runtime-ingress-state.json');
    const recoveryPath = `${snapshotPath}.recovery`;
    const priorSnapshot = await readFile(snapshotPath, 'utf8');
    let journaledBeforeAdvance = false;
    harness.antiRollbackFence.afterNextSnapshotGenerationAdvance(async () => {
      const published = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
        credentials: { credentialId: string; phase: string }[];
      };
      const recovery = JSON.parse(await readFile(recoveryPath, 'utf8')) as {
        credentials: { credentialId: string; phase: string }[];
      };
      expect(
        published.credentials.some(
          (credential) => credential.credentialId === CREDENTIAL_ID && credential.phase === 'active'
        )
      ).toBe(true);
      journaledBeforeAdvance = recovery.credentials.some(
        (credential) => credential.credentialId === CREDENTIAL_ID && credential.phase === 'revoked'
      );
      throw new Error('runtime-ingress-fixture-interrupted-after-fence-advance');
    });

    await expect(
      harness.feature.revokeRuntimeIngressCredential.execute({
        credentialId: CREDENTIAL_ID,
        expectedScope: SCOPE,
        revokedAtIso: REVOKED_AT,
        reason: 'interrupted-publication',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'storage_unavailable' });
    expect(journaledBeforeAdvance).toBe(true);
    expect(await readFile(snapshotPath, 'utf8')).toBe(priorSnapshot);
    await writeFile(snapshotPath, priorSnapshot, { mode: 0o600 });

    const restarted = createRuntimeIngressFeature({
      snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: harness.relayAuthoritySource,
      clock: harness.clock,
    });
    await expect(restarted.httpInput.handle(runtimeIngressHttpRequest())).resolves.toMatchObject({
      statusCode: 401,
      body: { error: { code: 'runtime_ingress_unauthorized' } },
    });
    const recovered = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      generation: number;
      credentials: { credentialId: string; phase: string }[];
    };
    expect(recovered).toMatchObject({
      generation: 2,
      credentials: [{ credentialId: CREDENTIAL_ID, phase: 'revoked' }],
    });
  });

  it('fails closed on tampered or symlinked recovery after the main snapshot fence rejects', async () => {
    const interruptAfterFenceAdvance = async () => {
      const directory = await fixtureDirectory();
      const harness = await createRuntimeIngressAdapterHarness(directory);
      const snapshotPath = join(directory, 'runtime-ingress-state.json');
      const recoveryPath = `${snapshotPath}.recovery`;
      const priorSnapshot = await readFile(snapshotPath, 'utf8');
      harness.antiRollbackFence.afterNextSnapshotGenerationAdvance(() =>
        Promise.reject(new Error('runtime-ingress-fixture-interrupted-before-main-publication'))
      );
      await expect(
        harness.feature.revokeRuntimeIngressCredential.execute({
          credentialId: CREDENTIAL_ID,
          expectedScope: SCOPE,
          revokedAtIso: REVOKED_AT,
          reason: 'recovery-artifact-verification',
        })
      ).resolves.toEqual({ status: 'rejected', reason: 'storage_unavailable' });
      expect(await readFile(snapshotPath, 'utf8')).toBe(priorSnapshot);
      return {
        harness,
        snapshotPath,
        recoveryPath,
        priorSnapshot,
        recoverySnapshot: await readFile(recoveryPath, 'utf8'),
      };
    };

    const tampered = await interruptAfterFenceAdvance();
    const tamperedRecovery = JSON.parse(tampered.recoverySnapshot) as { generation: number };
    tamperedRecovery.generation += 1;
    const tamperedRecoveryBytes = JSON.stringify(tamperedRecovery);
    await writeFile(tampered.recoveryPath, tamperedRecoveryBytes, { mode: 0o600 });
    const tamperedRestart = createRuntimeIngressFeature({
      snapshotPath: tampered.snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: tampered.harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: tampered.harness.relayAuthoritySource,
      clock: tampered.harness.clock,
    });
    await expect(
      tamperedRestart.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });
    expect(await readFile(tampered.snapshotPath, 'utf8')).toBe(tampered.priorSnapshot);
    expect(await readFile(tampered.recoveryPath, 'utf8')).toBe(tamperedRecoveryBytes);

    const linked = await interruptAfterFenceAdvance();
    const externalPath = join(
      await fixtureDirectory(),
      'external-runtime-ingress-recovery-state.json'
    );
    await writeFile(externalPath, linked.recoverySnapshot, { mode: 0o600 });
    await unlink(linked.recoveryPath);
    await symlink(externalPath, linked.recoveryPath);
    const linkedRestart = createRuntimeIngressFeature({
      snapshotPath: linked.snapshotPath,
      keyring: KEYRING,
      antiRollbackFence: linked.harness.antiRollbackFence,
      relaySecretSource: new FixtureRelaySecretSource(),
      relayAuthoritySource: linked.harness.relayAuthoritySource,
      clock: linked.harness.clock,
    });
    await expect(
      linkedRestart.httpInput.handle(runtimeIngressHttpRequest())
    ).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: 'runtime_ingress_unavailable', retryable: true } },
    });
    expect(await readFile(linked.snapshotPath, 'utf8')).toBe(linked.priorSnapshot);
    expect(await readFile(externalPath, 'utf8')).toBe(linked.recoverySnapshot);
    expect((await lstat(linked.recoveryPath)).isSymbolicLink()).toBe(true);
  });
});
