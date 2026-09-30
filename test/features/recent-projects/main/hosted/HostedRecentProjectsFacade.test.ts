import { describe, expect, it } from 'vitest';

import { HostedRecentProjectsFacade } from '../../../../../src/features/recent-projects/main/hosted';
import { parseBootId, parseDeploymentId, parseWorkspaceId } from '../../../../../src/shared/contracts/hosted';

import type {
  HostedRecentAuthoritySnapshot,
  HostedRecentMetadataSource,
  HostedRecentRootBoundary,
} from '../../../../../src/features/recent-projects/main/hosted';

const A = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const C = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const PUBLIC_A = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const PUBLIC_C = parseWorkspaceId(`workspace_${'3'.repeat(32)}`);

function fixture() {
  let grantA = true;
  let grantC = false;
  let mountC = true;
  let failStorage = false;
  let failAuthority = false;
  let projectionCount = 0;
  let revokeOnProjection = 0;
  let unmountOnProjection = 0;
  let revision = 1;
  let readAt = 1_800_000_000_000;
  let claudeStatus: 'complete' | 'partial' | 'unavailable' = 'complete';
  let codexStatus: 'complete' | 'partial' | 'unavailable' = 'complete';
  let codexFacts: { cwd: string; observedAt: number }[] = [];
  let claudeFacts = [{ cwd: '/workspace/a', observedAt: readAt - 100 }];
  const snapshot = (): HostedRecentAuthoritySnapshot => ({
    authorityFingerprint: 'actor:session:grant', deploymentId: parseDeploymentId('deployment_test'),
    bootId: parseBootId('boot_test'), registrationRevision: revision,
    mountGeneration: 1, grantRevision: revision,
  });
  const boundary = (): HostedRecentRootBoundary => {
    const mountCAtCapture = mountC;
    return { rootFingerprint: `all-roots-including-c:${mountCAtCapture}`,
    async attribute(cwd) {
      if (cwd === '/workspace/a/denied' || cwd.startsWith('/workspace/a/denied/')) {
        return { runtimeWorkspaceId: C, registrationRevision: 1, mountGeneration: 1, mountAvailable: mountCAtCapture };
      }
      if (cwd === '/workspace/a' || cwd.startsWith('/workspace/a/')) {
        return { runtimeWorkspaceId: A, registrationRevision: 1, mountGeneration: 1, mountAvailable: true };
      }
      return null;
    },
    };
  };
  const sources: HostedRecentMetadataSource[] = [
    { provider: 'anthropic', async read(admit) {
      for (const fact of claudeFacts) await admit(fact);
      return { status: claudeStatus };
    } },
    { provider: 'codex', async read(admit) {
      for (const fact of codexFacts) await admit(fact);
      return { status: codexStatus };
    } },
  ];
  const facade = new HostedRecentProjectsFacade(
    { async current() { if (failAuthority) throw new Error('grant snapshot unavailable'); return snapshot(); } },
    { async resolve() { return boundary(); } },
    { async projectGrantedWorkspace(_snapshot, runtimeWorkspaceId) {
      projectionCount++;
      if (projectionCount === revokeOnProjection) grantA = false;
      if (projectionCount === unmountOnProjection) mountC = false;
      if (failStorage) throw new Error('private storage details');
      if (runtimeWorkspaceId === A && grantA) return { workspaceId: PUBLIC_A, label: 'Workspace 1' };
      if (runtimeWorkspaceId === C && grantC) return { workspaceId: PUBLIC_C, label: 'Workspace 3' };
      return null;
    } },
    sources,
    () => readAt
  );
  return {
    facade,
    setGrantA(value: boolean) { grantA = value; },
    setGrantC(value: boolean) { grantC = value; },
    setMountC(value: boolean) { mountC = value; },
    setStorageFailure(value: boolean) { failStorage = value; },
    setAuthorityFailure(value: boolean) { failAuthority = value; },
    revokeAtProjection(value: number) { revokeOnProjection = value; },
    unmountAtProjection(value: number) { unmountOnProjection = value; },
    setRevision(value: number) { revision = value; },
    tick(value: number) { readAt += value; },
    setClaude(status: typeof claudeStatus, facts = claudeFacts) { claudeStatus = status; claudeFacts = facts; },
    setCodex(status: typeof codexStatus, facts = codexFacts) { codexStatus = status; codexFacts = facts; },
  };
}

describe('HostedRecentProjectsFacade', () => {
  it('assigns denied nested C before grant, leaving parent A unchanged', async () => {
    const f = fixture();
    const baseline = await f.facade.list();
    f.tick(11_000);
    f.setClaude('complete', [
      { cwd: '/workspace/a', observedAt: 1_799_999_999_900 },
      { cwd: '/workspace/a/denied/repo', observedAt: 1_800_000_010_900 },
    ]);
    f.setCodex('complete', [{ cwd: '/workspace/a/denied/repo', observedAt: 1_800_000_010_950 }]);
    const withDeniedC = await f.facade.list();
    expect(withDeniedC).toMatchObject({ kind: 'recent-projects', completeness: 'complete' });
    if (baseline.kind !== 'recent-projects' || withDeniedC.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(withDeniedC.projects.map((row) => ({
      workspaceId: row.workspaceId,
      sources: row.sources.map((source) => ({ provider: source.provider, observedAt: source.observedAt })),
    }))).toEqual(baseline.projects.map((row) => ({
      workspaceId: row.workspaceId,
      sources: row.sources.map((source) => ({ provider: source.provider, observedAt: source.observedAt })),
    })));
    f.setGrantC(true);
    f.setRevision(2);
    const withGrantedC = await f.facade.list();
    if (withGrantedC.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(withGrantedC.projects.map((row) => row.workspaceId)).toEqual([PUBLIC_C, PUBLIC_A]);
    f.tick(11_000);
    f.setMountC(false);
    const withUnavailableC = await f.facade.list();
    if (withUnavailableC.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(withUnavailableC.projects.map((row) => row.workspaceId)).toEqual([PUBLIC_A]);
  });

  it('revalidates grant before a cache hit and before a delayed response', async () => {
    const f = fixture();
    expect((await f.facade.list()).kind).toBe('recent-projects');
    f.setGrantA(false);
    const cacheHit = await f.facade.list();
    expect(cacheHit).toMatchObject({ kind: 'recent-projects', projects: [] });
    const delayed = fixture();
    delayed.revokeAtProjection(2);
    expect(await delayed.facade.list()).toMatchObject({ kind: 'recent-projects', projects: [] });
    const remount = fixture();
    remount.unmountAtProjection(2);
    expect(await remount.facade.list()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'authority_changed' });
  });

  it('keeps provider freshness and confirmedAt on partial stale fallback', async () => {
    const f = fixture();
    f.setCodex('complete', [{ cwd: '/workspace/a', observedAt: 1_799_999_999_950 }]);
    const first = await f.facade.list();
    if (first.kind !== 'recent-projects') throw new Error('unexpected result');
    f.tick(11_000);
    f.setClaude('complete', [{ cwd: '/workspace/a', observedAt: 1_800_000_010_000 }]);
    f.setCodex('unavailable', []);
    const second = await f.facade.list();
    expect(second).toMatchObject({ kind: 'recent-projects', completeness: 'partial' });
    if (second.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(second.projects[0]?.sources).toEqual([
      { provider: 'anthropic', observedAt: 1_800_000_010_000, confirmedAt: 1_800_000_011_000, freshness: 'fresh' },
      { provider: 'codex', observedAt: 1_799_999_999_950, confirmedAt: first.readAt, freshness: 'stale' },
    ]);
    f.tick(11_000);
    f.setClaude('unavailable', []);
    const lastKnown = await f.facade.list();
    if (lastKnown.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(lastKnown.completeness).toBe('partial');
    expect(lastKnown.projects[0]?.sources.map((source) => source.freshness)).toEqual(['stale', 'stale']);
    expect(lastKnown.projects[0]?.sources.map((source) => source.confirmedAt)).toEqual([
      second.readAt, first.readAt,
    ]);
  });

  it('keeps stale Claude when Codex alone refreshes', async () => {
    const f = fixture();
    const first = await f.facade.list();
    if (first.kind !== 'recent-projects') throw new Error('unexpected result');
    f.tick(11_000);
    f.setClaude('partial', []);
    f.setCodex('complete', [{ cwd: '/workspace/a', observedAt: 1_800_000_010_900 }]);
    const second = await f.facade.list();
    expect(second).toMatchObject({ kind: 'recent-projects', completeness: 'partial' });
    if (second.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(second.projects[0]?.sources).toEqual([
      { provider: 'anthropic', observedAt: 1_799_999_999_900, confirmedAt: first.readAt, freshness: 'stale' },
      { provider: 'codex', observedAt: 1_800_000_010_900, confirmedAt: second.readAt, freshness: 'fresh' },
    ]);
  });

  it('keeps the newer cached fact when a partial scan sees only older activity', async () => {
    const f = fixture();
    const first = await f.facade.list();
    if (first.kind !== 'recent-projects') throw new Error('unexpected result');
    f.tick(11_000);
    f.setClaude('partial', [{ cwd: '/workspace/a', observedAt: first.readAt - 200 }]);
    const second = await f.facade.list();
    if (second.kind !== 'recent-projects') throw new Error('unexpected result');
    expect(second.completeness).toBe('partial');
    expect(second.projects[0]?.sources).toEqual([{
      provider: 'anthropic', observedAt: first.readAt - 100,
      confirmedAt: first.readAt, freshness: 'stale',
    }]);
  });

  it('does not let an older request overwrite a newer response cache after revalidation', async () => {
    let release: (() => void) | undefined;
    let signalHeld: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let currentCalls = 0;
    let sourceReads = 0;
    const snapshot: HostedRecentAuthoritySnapshot = {
      authorityFingerprint: 'actor:session:grant', deploymentId: parseDeploymentId('deployment_test'),
      bootId: parseBootId('boot_test'), registrationRevision: 1, mountGeneration: 1, grantRevision: 1,
    };
    const boundary: HostedRecentRootBoundary = { rootFingerprint: 'root',
      async attribute(cwd) {
        return cwd === '/workspace/a'
          ? { runtimeWorkspaceId: A, registrationRevision: 1, mountGeneration: 1, mountAvailable: true }
          : null;
      },
    };
    const facade = new HostedRecentProjectsFacade(
      { async current() {
        if (++currentCalls === 2) { signalHeld?.(); await gate; }
        return snapshot;
      } },
      { async resolve() { return boundary; } },
      { async projectGrantedWorkspace() { return { workspaceId: PUBLIC_A, label: 'Workspace 1' }; } },
      [{ provider: 'anthropic', async read(admit) {
        await admit({ cwd: '/workspace/a', observedAt: ++sourceReads === 1 ? 100 : 200 });
        return { status: 'complete' };
      } }, { provider: 'codex', async read() { return { status: 'complete' }; } }],
      () => 300
    );
    const older = facade.list();
    await held;
    const newer = await facade.list();
    release?.();
    const rejected = await older;
    const cached = await facade.list();
    expect(newer).toMatchObject({ kind: 'recent-projects', projects: [{ sources: [{ observedAt: 200 }] }] });
    expect(rejected).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'authority_changed' });
    expect(cached).toMatchObject({ kind: 'recent-projects', projects: [{ sources: [{ observedAt: 200 }] }] });
    expect(sourceReads).toBe(2);
  });

  it('reports storage failure and empty unavailable sources without claiming complete empty', async () => {
    const f = fixture();
    expect((await f.facade.list()).kind).toBe('recent-projects');
    f.setStorageFailure(true);
    expect(await f.facade.list()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
    f.setStorageFailure(false);
    f.setClaude('unavailable', []);
    f.setCodex('unavailable', []);
    expect(await f.facade.list()).toMatchObject({ kind: 'recent-projects', completeness: 'partial', projects: [] });
    f.setAuthorityFailure(true);
    expect(await f.facade.list()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
  });
});
