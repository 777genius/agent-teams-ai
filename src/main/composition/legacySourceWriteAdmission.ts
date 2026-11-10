import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { assertSafeTeamName } from '@agent-teams/legacy-agent-host/lifecycle';

import { readLegacyNativeStopRelease } from '../services/team/provisioning/LegacyNativeStopRelease';
import { withTeamLaunchStatePublicationLock } from '../services/team/TeamLaunchStateStore';

interface DirectoryIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}
export type {
  AdmittedLegacySourceWrite,
  LegacySourceWriteAdmission,
  LegacySourceWriteAdmissionPolicy,
} from '@agent-teams/legacy-agent-host/lifecycle';
import type {
  AdmittedLegacySourceWrite,
  LegacySourceWriteAdmissionPolicy,
} from '@agent-teams/legacy-agent-host/lifecycle';
interface PublicationOwner {
  admission: AdmittedLegacySourceWrite;
  active: boolean;
  pending: Set<Promise<unknown>>;
  failures: unknown[];
}
interface SourceScope {
  admission: AdmittedLegacySourceWrite;
  publication?: PublicationOwner;
}

function directory(path: string): DirectoryIdentity | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Legacy source directory is unavailable');
    return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
const same = (left: DirectoryIdentity | null, right: DirectoryIdentity | null) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Per-composition restriction scope; no archive registry, repair, or ownership transfer. */
export function createLegacySourceWriteAdmissionPolicy(options: {
  teamsRoot: string;
  selectedHost: boolean;
  isCurrentOwner(): boolean;
  withIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  settleInterrupted?(error: unknown): Promise<void>;
}): LegacySourceWriteAdmissionPolicy {
  const { teamsRoot, selectedHost, isCurrentOwner } = options;
  if (!isAbsolute(teamsRoot) || resolve(teamsRoot) !== teamsRoot)
    throw new Error('Legacy source root must be an exact physical path');
  const scopes = new AsyncLocalStorage<SourceScope>();
  const sourceKey = (teamName: string) => {
    assertSafeTeamName(teamName);
    return join(teamsRoot, teamName);
  };
  const assertPhysicalRoot = () => {
    if (directory(teamsRoot) && realpathSync(teamsRoot) !== teamsRoot)
      throw new Error('Legacy source root changed');
  };
  return {
    capture(teamName) {
      const key = sourceKey(teamName);
      const inherited = scopes.getStore()?.admission;
      if (inherited) {
        if (inherited.sourceKey !== key) throw new Error('Legacy source admission differs');
        inherited.assertCurrent();
        return inherited;
      }
      if (selectedHost && !isCurrentOwner()) throw new Error('Legacy source owner changed');
      if (selectedHost) assertPhysicalRoot();
      const rootIdentity = selectedHost ? directory(teamsRoot) : null;
      const original = selectedHost ? directory(key) : null;
      const assertOwnerCurrent = () => {
        if (!selectedHost) return;
        if (!isCurrentOwner()) throw new Error('Legacy source owner changed');
        assertPhysicalRoot();
        if (!same(rootIdentity, directory(teamsRoot)))
          throw new Error('Legacy source root changed');
      };
      if (selectedHost && original && readLegacyNativeStopRelease(key, teamName)) {
        if (!same(rootIdentity, directory(teamsRoot)) || !same(original, directory(key)))
          throw new Error('Legacy source directory changed');
        return { kind: 'read-only', sourceKey: key, assertOwnerCurrent };
      }
      const admission: AdmittedLegacySourceWrite = {
        kind: 'admitted',
        sourceKey: key,
        assertOwnerCurrent,
        assertCurrent() {
          if (!selectedHost) return;
          assertOwnerCurrent();
          if (!same(original, directory(key))) throw new Error('Legacy source directory changed');
          if (original && readLegacyNativeStopRelease(key, teamName))
            throw new Error('Legacy source is read-only');
        },
        run(operation) {
          const inherited = scopes.getStore();
          if (inherited && inherited.admission !== admission)
            throw new Error('Legacy source admission differs');
          admission.assertCurrent();
          return scopes.run(inherited ?? { admission }, operation);
        },
        publish(operation) {
          const inherited = scopes.getStore();
          if (inherited?.admission !== admission)
            throw new Error('Missing original legacy source admission');
          admission.assertCurrent();
          if (!selectedHost) return operation();
          if (inherited.publication) {
            if (!inherited.publication.active || inherited.publication.admission !== admission)
              throw new Error('Legacy source publication ownership expired');
            const publication = inherited.publication;
            const physical = Promise.resolve()
              .then(() => {
                admission.assertCurrent();
                return operation();
              })
              .catch(async (error: unknown) => {
                await options.settleInterrupted?.(error);
                throw error;
              });
            publication.pending.add(physical);
            void physical.then(
              () => publication.pending.delete(physical),
              (error: unknown) => {
                publication.pending.delete(physical);
                publication.failures.push(error);
              }
            );
            return physical;
          }
          return options.withIdentityFence(teamName, () =>
            withTeamLaunchStatePublicationLock(teamName, async () => {
              admission.assertCurrent();
              const publication: PublicationOwner = {
                admission,
                active: true,
                pending: new Set(),
                failures: [],
              };
              try {
                const result = await scopes.run({ admission, publication }, operation);
                while (publication.pending.size) await Promise.allSettled([...publication.pending]);
                if (publication.failures.length) throw publication.failures[0];
                return result;
              } catch (error) {
                await options.settleInterrupted?.(error);
                throw error;
              } finally {
                // Nested local publications may have been deliberately detached by a caller.
                // Keep the queue until their physical lifetimes settle, including failure paths.
                while (publication.pending.size) await Promise.allSettled([...publication.pending]);
                publication.active = false;
              }
            })
          );
        },
      };
      admission.assertCurrent();
      return Object.freeze(admission);
    },
    bindExecution(teamName) {
      const admission = scopes.getStore()?.admission;
      if (!admission || admission.sourceKey !== sourceKey(teamName))
        throw new Error('Missing original legacy source admission');
      // A queued entry transports its original restriction, never its producer's lock ownership.
      // Validation belongs inside the queue's existing async error/cleanup boundary.
      return Object.freeze({
        assertCurrent: admission.assertCurrent,
        run: <T>(operation: () => T): T => scopes.run({ admission }, operation),
      });
    },
    current(teamName) {
      const admission = scopes.getStore()?.admission;
      if (!admission || admission.sourceKey !== sourceKey(teamName))
        throw new Error('Missing original legacy source admission');
      admission.assertCurrent();
      return admission;
    },
  };
}
