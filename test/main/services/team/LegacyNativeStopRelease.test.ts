// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeReleaseDigest } from '../../../../src/main/services/team/provisioning/LegacyNativeStopCensus';
import * as nativeCensus from '../../../../src/main/services/team/provisioning/LegacyNativeStopCensus';
import {
  captureLegacyNativeStopPublication,
  captureTrackedLegacyNativeStopPublication,
} from '../../../../src/main/services/team/provisioning/LegacyNativeStopPublication';
import {
  captureLegacyNativeStop,
  isCurrentLegacyNativeStopRelease,
  type LegacyNativeStopRelease,
  type LegacyNativeStopRun,
  readLegacyNativeStopRelease,
  selectLegacyNativeStopReleaseProof,
} from '../../../../src/main/services/team/provisioning/LegacyNativeStopRelease';
import { applyConfigPostLaunchMaterialization } from '../../../../src/main/services/team/provisioning/TeamProvisioningConfigMaterialization';
import {
  captureCliProcessStop,
  readVerifiedCliProcessRelease,
  recordOwnedUnixProcessGroup,
  recordVerifiedCliProcessRelease,
} from '../../../../src/main/utils/cliProcessCustody';

import type { TeamLaunchStopAuthority } from '../../../../src/main/services/team/TeamLaunchStateStore';
import type { ChildProcess } from 'node:child_process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-m16-native-release-')));
  roots.push(root);
  const teamName = 'TEST-native-team',
    teamDir = join(root, teamName),
    runId = 'TEST-run';
  mkdirSync(teamDir);
  const child = { pid: 44101 } as ChildProcess;
  const identity = {
    pid: child.pid!,
    parentPid: 1,
    processGroupId: child.pid!,
    startIdentity: 'TEST-captured-birth',
  };
  recordOwnedUnixProcessGroup(child, identity);
  const write = (file: string, value: unknown) =>
    writeFileSync(join(teamDir, file), JSON.stringify(value));
  write('config.json', {
    name: teamName,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: 'TEST-session',
    members: [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        agentId: `team-lead@${teamName}`,
        providerId: 'anthropic',
      },
    ],
  });
  write('members.meta.json', { version: 1, members: [] });
  write('team.meta.json', { version: 1, cwd: '/TEST/workspace', createdAt: 1 });
  write('launch-state.json', {
    version: 2,
    teamName,
    publicationRunId: runId,
    leadSessionId: 'TEST-session',
    expectedMembers: [],
    members: {},
  });
  write('launch-freshness.json', { version: 1, teamName, kind: 'launch', runId });
  const run: LegacyNativeStopRun = {
    teamName,
    runId,
    child,
    detectedSessionId: 'TEST-session',
    expectedMembers: [],
    allEffectiveMembers: [],
    mixedSecondaryLanes: [],
    request: { providerId: 'anthropic', members: [] },
  };
  let current = true;
  const capture = () => captureLegacyNativeStop(root, run, () => current);
  const publish = (proof: LegacyNativeStopRelease) => {
    write('launch-stopped.json', {
      version: 1,
      teamName,
      stopId: 'TEST-stop',
      nativeRelease: proof,
    });
    write('launch-freshness.json', {
      version: 1,
      teamName,
      kind: 'stop',
      stopId: 'TEST-stop',
      stoppedRunId: runId,
      nativeReleaseOwnerIncarnation: proof.process.ownerIncarnation,
      nativeReleaseDigest: nativeReleaseDigest(proof),
    });
  };
  return {
    root,
    teamName,
    teamDir,
    child,
    identity,
    run,
    write,
    capture,
    publish,
    revoke: () => {
      current = false;
    },
  };
}

function materializeCurrentSoloConfig(f: ReturnType<typeof fixture>): Record<string, unknown> {
  const config = JSON.parse(readFileSync(join(f.teamDir, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  applyConfigPostLaunchMaterialization({
    teamName: f.teamName,
    config,
    projectPath: '/TEST/workspace',
    newSessionId: 'TEST-session',
    sessionHistory: [],
    language: 'en',
    launchState: { providerId: 'anthropic', model: 'claude-sonnet-4-6', members: [] },
  });
  f.write('config.json', config);
  return config;
}

describe('native Stop first-refusal observation', () => {
  const options = (f: ReturnType<typeof fixture>) => ({
    teamsBasePath: f.root, run: f.run, current: () => true,
    beginStop: async (): Promise<TeamLaunchStopAuthority> => ({ teamName: f.teamName,
      stopIntent: 1, freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: f.run.runId } }),
    publishStopped: vi.fn(async () => true),
  });
  const diagnostic = (f: ReturnType<typeof fixture>, stage: string, reason = 'rejected') => ({
    schemaVersion: 1, targetDigest: nativeReleaseDigest({ teamName: f.teamName, runId: f.run.runId }),
    stage, reason,
  });

  it('records the actual missing process proof once without extra authority or census reads', async () => {
    const f = fixture(), order: string[] = [], base = options(f);
    const current = vi.fn(() => { order.push('owner'); return true; });
    const isCurrentAttempt = vi.fn(() => { order.push('attempt'); return true; });
    const onRefusal = vi.fn(() => { order.push('observer'); });
    const census = vi.spyOn(nativeCensus, 'readLegacyNativeCensus');
    try {
      const attempt = captureLegacyNativeStopPublication({ ...base, current, isCurrentAttempt, onRefusal })!;
      current.mockClear(); isCurrentAttempt.mockClear(); census.mockClear(); order.length = 0;
      const completed = attempt.complete();
      expect(attempt.complete()).toBe(completed);
      await expect(completed).resolves.toBe(false);
      expect(order).toEqual(['owner', 'attempt', 'owner', 'observer']);
      expect(current).toHaveBeenCalledTimes(2); expect(isCurrentAttempt).toHaveBeenCalledTimes(1);
      expect(census).not.toHaveBeenCalled(); expect(base.publishStopped).not.toHaveBeenCalled();
      expect(onRefusal).toHaveBeenCalledExactlyOnceWith(diagnostic(f, 'proof-process-release'));
    } finally { census.mockRestore(); }
  });

  it.each([
    { fault: 'admission-error', stage: 'admission', reason: 'exception' },
    { fault: 'owner', stage: 'completion-owner', reason: 'rejected' },
    { fault: 'freshness', stage: 'completion-freshness', reason: 'rejected' },
    { fault: 'marker', stage: 'proof-census', reason: 'backup-identity' },
    { fault: 'drained', stage: 'completion-work-sync', reason: 'exception' },
    { fault: 'pending', stage: 'completion-work-sync', reason: 'work-sync-pending' },
    { fault: 'readback', stage: 'publication', reason: 'rejected' },
    { fault: 'late-owner', stage: 'publication-owner', reason: 'rejected' },
    { fault: 'publish-error', stage: 'publication', reason: 'exception' },
  ])('reports the observed $fault boundary without disclosing private values', async ({ fault, stage, reason }) => {
    const f = fixture(), base = options(f);
    let current = true;
    const onRefusal = vi.fn(() => { if (fault === 'publish-error') throw new Error('TEST observer failed'); });
    const attempt = captureLegacyNativeStopPublication({ ...base, current: () => current, onRefusal,
      ...(fault === 'admission-error' ? { beginStop: async () => { throw new Error('TEST-private-admission'); } } : {}),
      ...(fault === 'freshness' ? { beginStop: async () => ({ ...(await base.beginStop()),
        freshness: { version: 1 as const, teamName: f.teamName, kind: 'launch' as const, runId: 'TEST-private-successor' } }) } : {}),
      ...(['drained', 'pending'].includes(fault) ? { captureSourceFence: () => ({ drain: async () => {}, release: () => {},
        assertDrained: () => { throw new Error(fault === 'pending' ? 'Legacy source has pending WorkSync maintenance' :
          '/TEST/private/token=not-for-diagnostics'); } }) } : {}),
      publishStopped: async () => {
        if (fault === 'publish-error') throw new Error('/TEST/private/token=not-for-diagnostics');
        if (fault === 'late-owner') current = false;
        return fault !== 'readback';
      },
    })!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    if (fault === 'owner') current = false;
    if (fault === 'marker') {
      const config = JSON.parse(readFileSync(join(f.teamDir, 'config.json'), 'utf8'));
      f.write('config.json', { ...config, _backupIdentityId: 'TEST-private-marker' });
    }
    await expect(attempt.complete()).resolves.toBe(false);
    await expect(attempt.complete()).resolves.toBe(false);
    expect(onRefusal).toHaveBeenCalledExactlyOnceWith(diagnostic(f, stage, reason));
    const wire = JSON.stringify(onRefusal.mock.calls);
    for (const secret of [f.teamName, f.run.runId, 'TEST-session', f.root, 'not-for-diagnostics',
      'TEST-private-marker', 'TEST-private-successor']) expect(wire).not.toContain(secret);
  });

  it.each(['code', 'message'])('does not invoke an error %s accessor at the diagnostic boundary', async (property) => {
    const f = fixture(), onRefusal = vi.fn();
    let accesses = 0;
    const failure = new Error('TEST-private-error-text');
    Object.defineProperty(failure, property, { get() {
      accesses++; throw new Error('TEST-private-getter-text');
    } });
    const attempt = captureLegacyNativeStopPublication({ ...options(f), onRefusal,
      publishStopped: async () => { throw failure; } })!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    await expect(attempt.complete()).resolves.toBe(false);
    expect(accesses).toBe(0);
    expect(onRefusal).toHaveBeenCalledExactlyOnceWith(diagnostic(f, 'publication', 'exception'));
  });

  it('keeps the original successful predicate order and emits no refusal', async () => {
    const f = fixture(), order: string[] = [], base = options(f), onRefusal = vi.fn();
    const readCensus = nativeCensus.readLegacyNativeCensus;
    const census = vi.spyOn(nativeCensus, 'readLegacyNativeCensus').mockImplementation((...args) => {
      order.push('census'); return readCensus(...args);
    });
    const current = vi.fn(() => { order.push('owner'); return true; });
    const isCurrentAttempt = vi.fn(() => { order.push('attempt'); return true; });
    const publishStopped = vi.fn(async () => { order.push('publish'); return true; });
    try {
      const attempt = captureLegacyNativeStopPublication({ ...base, current, isCurrentAttempt, publishStopped, onRefusal })!;
      recordVerifiedCliProcessRelease(f.child, [f.identity]);
      current.mockClear(); isCurrentAttempt.mockClear(); census.mockClear(); order.length = 0;
      await expect(attempt.complete()).resolves.toBe(true);
      expect(order).toEqual(['owner', 'attempt', 'owner', 'census', 'owner', 'publish', 'owner', 'attempt']);
      expect(current).toHaveBeenCalledTimes(4); expect(isCurrentAttempt).toHaveBeenCalledTimes(2);
      expect(census).toHaveBeenCalledTimes(1); expect(publishStopped).toHaveBeenCalledTimes(1);
      expect(onRefusal).not.toHaveBeenCalled();
    } finally { census.mockRestore(); }
  });

  it('binds observations to each explicit attempt while reusing the original pending capture', async () => {
    const f = fixture(), base = options(f), firstObserver = vi.fn(), retryObserver = vi.fn();
    const first = captureLegacyNativeStopPublication({ ...base, onRefusal: firstObserver })!;
    await expect(first.complete()).resolves.toBe(false);
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    rmSync(join(f.teamDir, 'launch-state.json'));
    const retry = captureLegacyNativeStopPublication({ ...base, onRefusal: retryObserver,
      publishStopped: async () => false })!;
    await expect(retry.complete()).resolves.toBe(false);
    expect(firstObserver).toHaveBeenCalledExactlyOnceWith(diagnostic(f, 'proof-process-release'));
    expect(retryObserver).toHaveBeenCalledExactlyOnceWith(diagnostic(f, 'publication'));
    const successObserver = vi.fn();
    const finalAttempt = captureLegacyNativeStopPublication({ ...base, onRefusal: successObserver })!;
    await expect(finalAttempt.complete()).resolves.toBe(true);
    expect(successObserver).not.toHaveBeenCalled();
    expect(captureLegacyNativeStopPublication({ ...base, run: { ...f.run } })).toBeNull();
  });
});

describe('bounded old Desktop native release proof (no native process execution)', () => {
  const changeMarker = (f: ReturnType<typeof fixture>, marker: unknown) => {
    const config = JSON.parse(readFileSync(join(f.teamDir, 'config.json'), 'utf8'));
    if (marker === undefined) delete config._backupIdentityId;
    else config._backupIdentityId = marker;
    f.write('config.json', config);
  };

  it('qualifies the current post-launch solo config only after its exact owned Stop release', () => {
    const f = fixture();
    const config = materializeCurrentSoloConfig(f);
    expect(config).toMatchObject({
      sessionHistory: ['TEST-session'],
      language: 'en',
      projectPathHistory: ['/TEST/workspace'],
    });
    const attempt = f.capture();
    expect(attempt).not.toBeNull();
    expect(attempt!.complete()).toBeNull();
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt!.complete();
    expect(proof).not.toBeNull();
    f.publish(proof!);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toEqual(proof);

    f.write('config.json', { ...config, sessionHistory: ['TEST-session', 'TEST-foreign-session'] });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
  });

  it.each([
    { name: 'foreign session history', patch: { sessionHistory: ['TEST-foreign-session'] } },
    { name: 'mixed session history', patch: { sessionHistory: ['TEST-session', 'TEST-foreign'] } },
    { name: 'non-array session history', patch: { sessionHistory: { sessionId: 'TEST-session' } } },
    { name: 'non-text language', patch: { language: 7 } },
    { name: 'null language', patch: { language: null } },
    { name: 'non-array path history', patch: { projectPathHistory: '/TEST/workspace' } },
    { name: 'non-text path history', patch: { projectPathHistory: ['/TEST/workspace', null] } },
    { name: 'nested native path data', patch: { projectPathHistory: [{ pid: 44101 }] } },
  ])('refuses current solo config with $name', ({ patch }) => {
    const f = fixture();
    const config = materializeCurrentSoloConfig(f);
    f.write('config.json', { ...config, ...patch });
    expect(f.capture()).toBeNull();
  });

  it('keeps unqualified work-sync artifacts outside a current solo Stop proof', () => {
    const f = fixture();
    materializeCurrentSoloConfig(f);
    const attempt = f.capture();
    expect(attempt).not.toBeNull();
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt!.complete();
    expect(proof).not.toBeNull();
    f.publish(proof!);
    mkdirSync(join(f.teamDir, '.member-work-sync'));
    f.write('.member-work-sync/sqlite-fallback-replica.json', { schemaVersion: 1, state: 'clean' });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    expect(attempt!.complete()).toBeNull();
  });
  it('keeps the original absent-marker digest bytes and private proof shape unchanged', () => {
    const f = fixture(),
      attempt = f.capture()!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt.complete()!;
    expect(proof.census).toEqual({
      directory: expect.any(Object),
      nativeDigest: '3a92d6b165366406f7999a902f33f6469825c3ac2797a532f078d08c69c58865',
    });
    f.publish(proof);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toEqual(proof);
  });
  it('pins an exact opaque non-UUID backup marker in capture and cold proof digest', () => {
    const f = fixture();
    changeMarker(f, 'opaque backup identity: original');
    const bytes = readFileSync(join(f.teamDir, 'config.json'));
    const attempt = f.capture()!;
    expect(attempt).not.toBeNull();
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt.complete()!;
    expect(proof.census.nativeDigest).not.toBe(
      '3a92d6b165366406f7999a902f33f6469825c3ac2797a532f078d08c69c58865'
    );
    f.publish(proof);
    expect(isCurrentLegacyNativeStopRelease(f.teamDir, proof, true)).toBe(true);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toEqual(proof);
    expect(readFileSync(join(f.teamDir, 'config.json'))).toEqual(bytes);
  });
  it.each([null, 7, {}, [], '', ' ', ' padded', 'padded '])(
    'refuses an invalid present backup marker %j without normalization',
    (marker) => {
      const f = fixture();
      changeMarker(f, marker);
      expect(f.capture()).toBeNull();
    }
  );
  it.each([
    [undefined, 'new opaque identity'],
    ['original opaque identity', 'replacement identity'],
    ['original opaque identity', undefined],
  ])('refuses backup marker replacement before complete (%j -> %j)', (original, replacement) => {
    const f = fixture();
    changeMarker(f, original);
    const attempt = f.capture()!;
    expect(attempt).not.toBeNull();
    changeMarker(f, replacement);
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    expect(attempt.complete()).toBeNull();
  });
  it.each([
    [undefined, 'new opaque identity'],
    ['original opaque identity', 'replacement identity'],
    ['original opaque identity', undefined],
  ])(
    'invalidates a published proof on backup marker replacement (%j -> %j)',
    (original, replacement) => {
      const f = fixture();
      changeMarker(f, original);
      const attempt = f.capture()!;
      recordVerifiedCliProcessRelease(f.child, [f.identity]);
      const proof = attempt.complete()!;
      f.publish(proof);
      expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toEqual(proof);
      changeMarker(f, replacement);
      expect(isCurrentLegacyNativeStopRelease(f.teamDir, proof, true)).toBe(false);
      expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    }
  );
  it('refuses marker replacement between original config capture and initial census', () => {
    const f = fixture();
    changeMarker(f, 'original identity');
    const originalRead = nativeCensus.readLegacyNativeCensus;
    const spy = vi
      .spyOn(nativeCensus, 'readLegacyNativeCensus')
      .mockImplementationOnce((...args) => {
        changeMarker(f, 'replacement identity');
        return originalRead(...args);
      });
    try {
      expect(f.capture()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('does not admit another spelling or arbitrary config metadata with the marker', () => {
    const f = fixture();
    changeMarker(f, 'original identity');
    const config = JSON.parse(readFileSync(join(f.teamDir, 'config.json'), 'utf8'));
    f.write('config.json', { ...config, _backupidentityid: 'other' });
    expect(f.capture()).toBeNull();
  });

  it('permits final old-run map cleanup but never lets a late successor child inherit its proof', async () => {
    for (const replacement of [false, true]) {
      const f = fixture(),
        runs = new Map([[f.run.runId, f.run]]);
      const publishStopped = vi.fn(async () => true);
      const attempt = captureTrackedLegacyNativeStopPublication(f.teamName, {
        getTeamsBasePath: () => f.root,
        getTrackedRunId: () => (runs.has('TEST-run') ? 'TEST-run' : null),
        runs,
        hasOtherRuntimeOwner: () => false,
        beginStop: async () => ({
          teamName: f.teamName,
          stopIntent: 1,
          freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-run' },
        }),
        publishStopped,
      })!;
      recordVerifiedCliProcessRelease(f.child, [f.identity]);
      const completed = attempt.complete();
      if (replacement) f.run.child = { pid: 44102 } as ChildProcess;
      else runs.delete('TEST-run');
      await completed;
      expect(publishStopped).toHaveBeenCalledTimes(replacement ? 0 : 1);
    }
  });
  it('captures before the admission await and publishes once only after strict stop and final authority', async () => {
    const f = fixture();
    let resolve!: (authority: TeamLaunchStopAuthority) => void;
    const admission = new Promise<TeamLaunchStopAuthority>((done) => {
      resolve = done;
    });
    const beginStop = vi.fn(() => admission),
      publishStopped = vi.fn<
        (
          teamName: string,
          authority: TeamLaunchStopAuthority,
          proof: LegacyNativeStopRelease
        ) => Promise<boolean>
      >(async () => true);
    const attempt = captureLegacyNativeStopPublication({
      teamsBasePath: f.root,
      run: f.run,
      current: () => true,
      beginStop,
      publishStopped,
    })!;
    expect(beginStop).toHaveBeenCalledExactlyOnceWith(f.teamName);
    const completed = attempt.complete();
    expect(attempt.complete()).toBe(completed);
    await Promise.resolve();
    expect(publishStopped).not.toHaveBeenCalled();
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    resolve({
      teamName: f.teamName,
      stopIntent: 1,
      freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-run' },
    });
    await completed;
    expect(publishStopped).toHaveBeenCalledTimes(1);
    expect(publishStopped.mock.calls[0]![2]).toMatchObject({
      target: { runId: 'TEST-run', sessionId: 'TEST-session' },
    });
  });
  it('suppresses late publication on owner revocation or changed original admission', async () => {
    const f = fixture();
    let current = true;
    const publishStopped = vi.fn(async () => true);
    const attempt = captureLegacyNativeStopPublication({
      teamsBasePath: f.root,
      run: f.run,
      current: () => current,
      beginStop: async () => ({
        teamName: f.teamName,
        stopIntent: 1,
        freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-successor' },
      }),
      publishStopped,
    })!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    await attempt.complete();
    expect(publishStopped).not.toHaveBeenCalled();
    const revoked = captureLegacyNativeStopPublication({
      teamsBasePath: f.root,
      run: f.run,
      current: () => current,
      beginStop: async () => ({
        teamName: f.teamName,
        stopIntent: 2,
        freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-run' },
      }),
      publishStopped,
    })!;
    current = false;
    await revoked.complete();
    expect(publishStopped).not.toHaveBeenCalled();
  });
  it('retains the original capture across partial stopped publication without re-adopting a run', async () => {
    const f = fixture();
    const options = {
      teamsBasePath: f.root,
      run: f.run,
      current: () => true,
      beginStop: async (): Promise<TeamLaunchStopAuthority> => ({
        teamName: f.teamName,
        stopIntent: 1,
        freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-run' },
      }),
      publishStopped: async () => false,
    };
    const first = captureLegacyNativeStopPublication(options)!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    expect(await first.complete()).toBe(false);
    rmSync(join(f.teamDir, 'launch-state.json'));
    f.write('launch-freshness.json', {
      version: 1,
      teamName: f.teamName,
      kind: 'stop',
      stopId: 'TEST-partial-stop',
      stoppedRunId: 'TEST-run',
    });
    const publishStopped = vi.fn(async () => true);
    const retry = captureLegacyNativeStopPublication({
      ...options,
      beginStop: async () => ({
        teamName: f.teamName,
        stopIntent: 2,
        freshness: {
          version: 1,
          teamName: f.teamName,
          kind: 'stop',
          stopId: 'TEST-partial-stop',
          stoppedRunId: 'TEST-run',
        },
      }),
      publishStopped,
    })!;
    expect(await retry.complete()).toBe(true);
    expect(publishStopped.mock.calls).toHaveLength(1);
    const copiedRun = { ...f.run };
    expect(captureLegacyNativeStopPublication({ ...options, run: copiedRun })).toBeNull();
  });
  it('returns unconfirmed release when publication is unavailable', async () => {
    const f = fixture(),
      unavailable = vi.fn();
    const attempt = captureLegacyNativeStopPublication({
      teamsBasePath: f.root,
      run: f.run,
      current: () => true,
      beginStop: async () => ({
        teamName: f.teamName,
        stopIntent: 1,
        freshness: { version: 1, teamName: f.teamName, kind: 'launch', runId: 'TEST-run' },
      }),
      publishStopped: async () => {
        throw new Error('TEST-unavailable');
      },
      unavailable,
    })!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    await expect(attempt.complete()).resolves.toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
  });
  it('requires original owner capture plus the exact strict-stop acknowledgement, not a serialized capability', () => {
    const f = fixture(),
      attempt = f.capture()!;
    expect(attempt).not.toBeNull();
    expect(attempt.complete()).toBeNull();
    const captured = captureCliProcessStop(f.child)!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    expect(readVerifiedCliProcessRelease({ ...captured })).toBeNull();
    expect(attempt.complete()).toMatchObject({
      target: { runId: 'TEST-run', sessionId: 'TEST-session', rootPid: f.child.pid },
      process: { rootStartIdentity: f.identity.startIdentity },
    });
    const proof = attempt.complete()!;
    expect(isCurrentLegacyNativeStopRelease(f.teamDir, proof, true)).toBe(true);
    expect(isCurrentLegacyNativeStopRelease(f.teamDir, structuredClone(proof), true)).toBe(false);
    recordOwnedUnixProcessGroup(f.child, { ...f.identity, startIdentity: 'TEST-successor-birth' });
    expect(readVerifiedCliProcessRelease(captured)).toBeNull();
    expect(attempt.complete()).toBeNull();
  });
  it('captures immutable bindings before awaits and fences revoked ownership', () => {
    const f = fixture(),
      attempt = f.capture()!;
    f.run.detectedSessionId = 'TEST-mutated-session';
    f.run.runId = 'TEST-mutated-run';
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    expect(attempt.complete()!.target).toMatchObject({
      runId: 'TEST-run',
      sessionId: 'TEST-session',
    });
    f.revoke();
    expect(attempt.complete()).toBeNull();
  });
  it('never upgrades absent capture, non-owned groups or uncovered member/provider/pane inventories', () => {
    const f = fixture();
    for (const patch of [
      { child: { pid: 44102 } as ChildProcess },
      { expectedMembers: ['alice'] },
      { allEffectiveMembers: [{}] },
      { mixedSecondaryLanes: [{}] },
      { request: { providerId: 'opencode', members: [] } },
    ])
      expect(captureLegacyNativeStop(f.root, { ...f.run, ...patch }, () => true)).toBeNull();
    const config = JSON.parse(readFileSync(join(f.teamDir, 'config.json'), 'utf8'));
    config.members[0].tmuxPaneId = '%TEST-pane';
    f.write('config.json', config);
    expect(f.capture()).toBeNull();
  });
  it('reads a complete cold proof only with exact original stop/freshness/incarnation and native census', () => {
    const f = fixture(),
      attempt = f.capture()!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt.complete()!;
    const live = selectLegacyNativeStopReleaseProof({
      teamDir: f.teamDir,
      teamName: f.teamName,
      freshness: { kind: 'launch', runId: 'TEST-run' },
      provided: proof,
    });
    expect(live).not.toBeNull();
    expect(() => live!.assertCurrent()).not.toThrow();
    expect(
      selectLegacyNativeStopReleaseProof({
        teamDir: f.teamDir,
        teamName: f.teamName,
        freshness: { kind: 'launch', runId: 'TEST-run' },
        provided: structuredClone(proof),
      })
    ).toBeNull();
    f.publish(proof);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toEqual(proof);
    expect(
      selectLegacyNativeStopReleaseProof({
        teamDir: f.teamDir,
        teamName: f.teamName,
        freshness: { kind: 'stop', stoppedRunId: 'TEST-run' },
      })
    ).not.toBeNull();
    const savedFreshness = JSON.parse(
      readFileSync(join(f.teamDir, 'launch-freshness.json'), 'utf8')
    );
    f.write('launch-freshness.json', {
      ...savedFreshness,
      nativeReleaseOwnerIncarnation: 'TEST-other-incarnation',
    });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    f.publish(proof);
    f.write('launch-freshness.json', {
      version: 1,
      teamName: f.teamName,
      kind: 'launch',
      runId: 'TEST-successor',
    });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    f.publish(proof);
    f.write('launch-stopped.json', {
      version: 1,
      teamName: f.teamName,
      stopId: 'TEST-other-stop',
      nativeRelease: proof,
    });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    f.publish(proof);
    f.write('bootstrap-state.json', { sessionId: 'TEST-foreign-session' });
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    expect(() => live!.assertCurrent()).toThrow('Native stop release authority changed');
  });
  it('cannot bless a same-name Team replacement or native artifact changes after stop', () => {
    const f = fixture(),
      attempt = f.capture()!;
    recordVerifiedCliProcessRelease(f.child, [f.identity]);
    const proof = attempt.complete()!;
    f.publish(proof);
    renameSync(f.teamDir, `${f.teamDir}-original`);
    mkdirSync(f.teamDir);
    expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toBeNull();
    expect(attempt.complete()).toBeNull();
  });
});
