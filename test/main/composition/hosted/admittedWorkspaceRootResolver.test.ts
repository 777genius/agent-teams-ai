import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry';
import { AdmittedWorkspaceRootResolver } from '@main/composition/hosted/admittedWorkspaceRootResolver';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

const bootId = `boot_${'b'.repeat(32)}`;
const deploymentId = `deployment_${'a'.repeat(32)}`;
const scratch: string[] = [];

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(process.cwd(), '.hosted-root-resolver-'));
  scratch.push(base);
  const a = join(base, 'A');
  const b = join(base, 'B');
  const c = join(a, 'C');
  for (const root of [a, b, c]) mkdirSync(root, { recursive: true });
  const roots = { a, b, c };
  const registrations = Object.entries(roots).map(([key, root], index) =>
    new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: key,
      workspaceId: `workspace_${String(index + 1).repeat(32)}` as never,
      displayName: key,
      registrationRevision: 1,
      declaredRootHash: createHash('sha256').update(root, 'utf8').digest('hex'),
      enabled: true,
    })
  );
  const bindings = registrations.map(
    (registration) =>
      new WorkspaceMountBinding({
        registration,
        bootId: bootId as never,
        mountGeneration: 1,
        declaredRootHash: registration.declaredRootHash,
        observedAt: 1,
        health: 'healthy',
        allowedOperations: [],
      })
  );
  const snapshot: WorkspaceRegistryStartupSnapshot = {
    registry: new WorkspaceRegistrationRegistry(registrations),
    bindings,
  };
  const runtime = createRuntimeInstanceContext({
    deploymentId,
    bootId,
    claudeRoot: { kind: 'claude', reference: base },
    appDataRoot: { kind: 'app-data', reference: base },
    workspaceRoots: [b, c, a].map((reference) => ({ kind: 'workspace', reference })),
    tempRoot: { kind: 'temp', reference: base },
    logsRoot: { kind: 'logs', reference: base },
  });
  return { roots, registrations, bindings, snapshot, runtime };
}

describe('admitted workspace root resolver', () => {
  it('attributes only the deepest exact granted mounted binding before reading a fact', async () => {
    const { roots, bindings, snapshot, runtime } = fixture();
    const resolver = new AdmittedWorkspaceRootResolver(snapshot, runtime);
    const grant = vi.fn(async (id: string) => id === bindings[0].workspaceId);
    expect(await resolver.resolveGrantedWorkspaceId(roots.a, bindings[0], grant)).toBe(
      bindings[0].workspaceId
    );
    expect(await resolver.resolveGrantedWorkspaceId(roots.b, bindings[0], grant)).toBeNull();
    expect(await resolver.resolveGrantedWorkspaceId(roots.c, bindings[0], grant)).toBeNull();
    expect(grant).toHaveBeenCalledTimes(1);
    expect(await resolver.resolveGrantedWorkspaceId(roots.c, bindings[2], grant)).toBeNull();
    expect(grant).toHaveBeenCalledWith(bindings[2].workspaceId);
    const alias = join(roots.a, '..', 'alias');
    symlinkSync(roots.a, alias);
    expect(await resolver.resolveGrantedWorkspaceId(alias, bindings[0], grant)).toBeNull();
  });

  it('keeps a disabled tombstone as an exclusion boundary without its mount', async () => {
    const { roots, registrations, bindings, runtime } = fixture();
    const disabled = new WorkspaceRegistration({ ...registrations[2].toValue(), enabled: false });
    const snapshot: WorkspaceRegistryStartupSnapshot = {
      registry: new WorkspaceRegistrationRegistry([registrations[0], registrations[1], disabled]),
      bindings: bindings.slice(0, 2),
    };
    rmSync(roots.c, { recursive: true });
    const resolver = new AdmittedWorkspaceRootResolver(snapshot, runtime);
    mkdirSync(roots.c);
    const grant = vi.fn(() => true);
    expect(await resolver.resolveGrantedWorkspaceId(roots.c, bindings[0], grant)).toBeNull();
    expect(grant).not.toHaveBeenCalled();
  });

  it('rejects incomplete, ambiguous, or unmounted root maps without exposing paths', () => {
    const { roots, registrations, bindings, snapshot, runtime } = fixture();
    const missing = createRuntimeInstanceContext({
      ...runtime,
      workspaceRoots: runtime.workspaceRoots.slice(0, 2),
    });
    expect(() => new AdmittedWorkspaceRootResolver(snapshot, missing)).toThrow(
      'hosted-workspace-root-map-unavailable'
    );
    const duplicate = createRuntimeInstanceContext({
      ...runtime,
      workspaceRoots: [...runtime.workspaceRoots, runtime.workspaceRoots[0]],
    });
    expect(() => new AdmittedWorkspaceRootResolver(snapshot, duplicate)).toThrow(
      'hosted-workspace-root-map-unavailable'
    );
    const mismatched = new WorkspaceRegistration({
      ...registrations[0].toValue(),
      declaredRootHash: 'f'.repeat(64),
    });
    expect(
      () =>
        new AdmittedWorkspaceRootResolver(
          {
            registry: new WorkspaceRegistrationRegistry([
              mismatched,
              registrations[1],
              registrations[2],
            ]),
            bindings,
          },
          runtime
        )
    ).toThrow('hosted-workspace-root-map-unavailable');
    rmSync(roots.b, { recursive: true });
    expect(() => new AdmittedWorkspaceRootResolver(snapshot, runtime)).toThrow(
      'hosted-workspace-root-map-unavailable'
    );
  });
});
