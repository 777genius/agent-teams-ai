// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTeamIdentityRecord } from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import { createHostedBoundTeamReadDispatcher } from '@main/composition/hosted/hostedBoundTeamReadDispatcher';
import { parseBootId, parseDeploymentId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'c'.repeat(32)}`);
const A = parseWorkspaceId(`workspace_${'d'.repeat(32)}`);
const B = parseWorkspaceId(`workspace_${'e'.repeat(32)}`);
const roots: string[] = [];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-bound-team-read-'));
  roots.push(root);
  const rootA = join(root, 'a');
  const rootB = join(root, 'b');
  mkdirSync(rootA);
  mkdirSync(rootB);
  const binding = (workspaceId: typeof A, name: string, path: string, generation = 1) => {
    const registration = new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: `registration-${name}`,
      workspaceId,
      displayName: name,
      registrationRevision: 1,
      declaredRootHash: hash(path),
      enabled: true,
    });
    return new WorkspaceMountBinding({
      registration,
      bootId: BOOT_ID,
      mountGeneration: generation,
      ...(generation === 1 ? {} : { previousMountGeneration: generation - 1 }),
      declaredRootHash: registration.declaredRootHash,
      observedAt: 1_800_000_000_000,
      health: 'read-only',
      allowedOperations: [],
    });
  };
  const owner = binding(A, 'a', rootA);
  const other = binding(B, 'b', rootB);
  const current = new Map([[A, owner], [B, other]]);
  let identity = parseTeamIdentityRecord({
    teamId: TEAM_ID,
    state: 'active',
    legacyKey: 'sandbox-team',
    directoryFingerprint: hash('sandbox-team'),
    workspaceBinding: { workspaceId: B, generation: 1 },
    adoptionIntentId: `adoption_${'f'.repeat(32)}`,
    identityChecksum: hash('identity'),
    createdAt: '2027-01-01T00:00:00.000Z',
    activatedAt: '2027-01-01T00:00:01.000Z',
    tombstonedAt: null,
  });
  const dependencies = {
    runtimeInstance: createRuntimeInstanceContext({
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      claudeRoot: { kind: 'claude' as const, reference: join(root, 'claude') },
      appDataRoot: { kind: 'app-data' as const, reference: join(root, 'app-data') },
      workspaceRoots: [
        { kind: 'workspace' as const, reference: rootA },
        { kind: 'workspace' as const, reference: rootB },
      ],
      tempRoot: { kind: 'temp' as const, reference: join(root, 'temp') },
      logsRoot: { kind: 'logs' as const, reference: join(root, 'logs') },
    }),
    mountBinding: owner,
    teamIdentities: {
      listTeamIdentities: () => Promise.resolve([identity]),
      getTeamIdentity: () => Promise.resolve(identity),
    },
    admittedReadBindings: [owner, other],
    currentReadBinding: (workspaceId: string) => current.get(workspaceId as typeof A) ?? null,
  };
  return {
    owner,
    other,
    current,
    dependencies,
    setWorkspace(workspaceId: typeof A) {
      identity = parseTeamIdentityRecord({
        ...identity,
        workspaceBinding: { workspaceId, generation: 2 },
      });
    },
    remountB() {
      current.set(B, binding(B, 'b', rootB, 2));
    },
  };
}

describe('hosted bound team read dispatch', () => {
  it('selects B only from an admitted current binding and never routes B to A', async () => {
    const f = fixture();
    const dispatcher = createHostedBoundTeamReadDispatcher(f.dependencies);
    const found = await dispatcher.target(TEAM_ID);
    expect(found.kind).toBe('found');
    if (found.kind !== 'found') return;
    expect(found.target.binding).toBe(f.other);
    expect(await found.target.stillCurrent()).toBe(true);
    const ownerOnly = createHostedBoundTeamReadDispatcher({
      runtimeInstance: f.dependencies.runtimeInstance,
      mountBinding: f.owner,
      teamIdentities: f.dependencies.teamIdentities,
    });
    expect(await ownerOnly.target(TEAM_ID)).toEqual({ kind: 'unavailable' });
  });

  it('invalidates an in-flight target after grant loss, remount, or identity rebinding', async () => {
    const f = fixture();
    const dispatcher = createHostedBoundTeamReadDispatcher(f.dependencies);
    const first = await dispatcher.target(TEAM_ID);
    expect(first.kind).toBe('found');
    if (first.kind !== 'found') return;
    f.current.delete(B);
    expect(await first.target.stillCurrent()).toBe(false);
    expect(await dispatcher.target(TEAM_ID)).toEqual({ kind: 'unavailable' });
    f.current.set(B, f.other);
    const second = await dispatcher.target(TEAM_ID);
    expect(second.kind).toBe('found');
    if (second.kind !== 'found') return;
    f.remountB();
    expect(await second.target.stillCurrent()).toBe(false);
    f.current.set(B, f.other);
    const third = await dispatcher.target(TEAM_ID);
    expect(third.kind).toBe('found');
    if (third.kind !== 'found') return;
    f.setWorkspace(A);
    expect(await third.target.stillCurrent()).toBe(false);
    const rebound = await dispatcher.target(TEAM_ID);
    expect(rebound.kind).toBe('found');
    if (rebound.kind === 'found') expect(rebound.target.binding).toBe(f.owner);
  });
});
