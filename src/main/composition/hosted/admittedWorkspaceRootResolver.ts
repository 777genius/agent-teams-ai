import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

import { admitHostedReadRoot } from '../../standaloneHostedReadRoot';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
import type { WorkspaceId } from '@shared/contracts/hosted';

interface Boundary {
  readonly root: string;
  readonly registration: WorkspaceRegistration;
}

function hashRoot(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('hex');
}

/** Never turn an invalid signed root into a path-bearing error. */
export function matchSignedWorkspaceRoot(
  runtimeInstance: RuntimeInstanceContext,
  declaredRootHash: string
): string | null {
  if (!/^[0-9a-f]{64}$/.test(declaredRootHash)) return null;
  try {
    const roots = new Set<string>();
    let match: string | null = null;
    for (const reference of runtimeInstance.workspaceRoots) {
      const root = admitHostedReadRoot(reference.reference);
      if (roots.has(root)) return null;
      roots.add(root);
      if (hashRoot(root) === declaredRootHash) {
        if (match !== null) return null;
        match = root;
      }
    }
    return match;
  } catch {
    return null;
  }
}

/** Server-only full registry map. Grants are checked only after deepest-root attribution. */
export class AdmittedWorkspaceRootResolver {
  readonly #boundaries: readonly Boundary[];
  readonly #usableBindings: ReadonlyMap<WorkspaceId, WorkspaceMountBinding>;

  constructor(snapshot: WorkspaceRegistryStartupSnapshot, runtimeInstance: RuntimeInstanceContext) {
    const rootsByHash = new Map<string, string>();
    for (const reference of runtimeInstance.workspaceRoots) {
      let root: string;
      try {
        root = admitHostedReadRoot(reference.reference);
      } catch {
        throw new TypeError('hosted-workspace-root-map-unavailable');
      }
      const hash = hashRoot(root);
      if (rootsByHash.has(hash)) throw new TypeError('hosted-workspace-root-map-unavailable');
      rootsByHash.set(hash, root);
    }

    const registrations = snapshot.registry.values();
    if (rootsByHash.size !== registrations.length) {
      throw new TypeError('hosted-workspace-root-map-unavailable');
    }
    const mountedBindings = new Map<WorkspaceId, WorkspaceMountBinding>();
    for (const binding of snapshot.bindings) {
      if (mountedBindings.has(binding.workspaceId) || binding.bootId !== runtimeInstance.bootId) {
        throw new TypeError('hosted-workspace-root-map-unavailable');
      }
      mountedBindings.set(binding.workspaceId, binding);
    }

    this.#boundaries = Object.freeze(
      registrations.map((registration): Boundary => {
        const root = rootsByHash.get(registration.declaredRootHash);
        const binding = mountedBindings.get(registration.workspaceId) ?? null;
        if (
          root === undefined ||
          (registration.enabled &&
            (binding === null || binding.declaredRootHash !== registration.declaredRootHash)) ||
          (!registration.enabled && binding !== null)
        ) {
          throw new TypeError('hosted-workspace-root-map-unavailable');
        }
        // A disabled/tombstone boundary still excludes facts but needs no active mount.
        if (registration.enabled) {
          try {
            if (realpathSync.native(root) !== root || !statSync(root).isDirectory()) {
              throw new TypeError('hosted-workspace-root-map-unavailable');
            }
          } catch {
            throw new TypeError('hosted-workspace-root-map-unavailable');
          }
        }
        return Object.freeze({ root, registration });
      })
    );
    if (
      mountedBindings.size !== registrations.filter((registration) => registration.enabled).length
    ) {
      throw new TypeError('hosted-workspace-root-map-unavailable');
    }
    this.#usableBindings = new Map(
      [...mountedBindings].filter(([, binding]) => binding.health !== 'unavailable')
    );
  }

  /** Returns an ID only for a currently mounted exact binding with a live grant. */
  async resolveGrantedWorkspaceId(
    cwd: string,
    currentBinding: WorkspaceMountBinding,
    hasGrant: (workspaceId: WorkspaceId) => boolean | Promise<boolean>
  ): Promise<WorkspaceId | null> {
    let canonicalCwd: string;
    try {
      admitHostedReadRoot(cwd);
      canonicalCwd = realpathSync.native(cwd);
      if (canonicalCwd !== cwd || !statSync(canonicalCwd).isDirectory()) return null;
    } catch {
      return null;
    }
    let deepest: Boundary | null = null;
    for (const boundary of this.#boundaries) {
      if (
        (canonicalCwd === boundary.root || canonicalCwd.startsWith(boundary.root + sep)) &&
        (deepest === null || boundary.root.length > deepest.root.length)
      ) {
        deepest = boundary;
      }
    }
    if (
      deepest === null ||
      !deepest.registration.enabled ||
      this.#usableBindings.get(deepest.registration.workspaceId) !== currentBinding
    ) {
      return null;
    }
    try {
      return (await hasGrant(currentBinding.workspaceId)) ? currentBinding.workspaceId : null;
    } catch {
      return null;
    }
  }
}
