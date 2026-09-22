import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';

import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { TeamIdentityPublicationGateway } from '../../contracts/teamIdentityStorageContracts';
import type { HostedAuthStorageBackend } from './createHostedAuthStorageBackend';

async function databaseIdentity(databasePath: string): Promise<string> {
  if (!path.isAbsolute(databasePath) || path.resolve(databasePath) !== databasePath) {
    throw new Error('canonical-database-path-invalid');
  }
  let component = path.parse(databasePath).root;
  const evidence: string[] = [];
  const parts = databasePath.slice(component.length).split(path.sep);
  for (const [index, part] of parts.entries()) {
    component = path.join(component, part);
    const stat = await lstat(component, { bigint: true });
    const file = index === parts.length - 1;
    if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) ||
        await realpath(component) !== component) throw new Error('canonical-database-alias-refused');
    evidence.push(`${stat.dev}:${stat.ino}`);
  }
  return evidence.join('/');
}

export interface HostedTeamIdentityPublicationBackend {
  readonly gateway: TeamIdentityPublicationGateway;
  readonly sharedWorker: boolean;
  readSnapshot(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/** Called once by startup, before canonical read admission. Never provisions missing roots/files. */
export async function createHostedTeamIdentityPublicationBackend(input: {
  readonly appDataRoot: string;
  readonly drafts: Pick<HostedAuthStorageBackend, 'databasePath' | 'initialize' | 'identityPublication'> &
    Partial<Pick<HostedAuthStorageBackend, 'captureIdentitySnapshot'>>;
}): Promise<HostedTeamIdentityPublicationBackend> {
  const databasePath = path.join(input.appDataRoot, 'storage', 'app.db');
  const initialCanonical = await databaseIdentity(databasePath);
  const draftConnectionIdentity = await input.drafts.initialize(databasePath === input.drafts.databasePath);
  const initialDraft = await databaseIdentity(input.drafts.databasePath);
  if (draftConnectionIdentity !== initialDraft.split('/').at(-1)) {
    throw new Error('canonical-draft-worker-identity-mismatch');
  }
  const sharedWorker = databasePath === input.drafts.databasePath && initialCanonical === initialDraft;
  if (!sharedWorker && initialCanonical.split('/').at(-1) === initialDraft.split('/').at(-1)) {
    throw new Error('canonical-database-alias-refused');
  }
  const client = sharedWorker ? null : new InternalStorageWorkerClient({ databasePath, mode: 'team-identity-publication' });
  const source = client?.identityPublication ?? input.drafts.identityPublication;
  let closed = false;
  const guard = async <T>(effect: () => Promise<T>): Promise<T> => {
    if (closed || await databaseIdentity(databasePath) !== initialCanonical ||
        (sharedWorker && await databaseIdentity(input.drafts.databasePath) !== initialDraft)) {
      throw new Error('canonical-database-replaced');
    }
    const result = await effect();
    if (await databaseIdentity(databasePath) !== initialCanonical) throw new Error('canonical-database-replaced');
    return result;
  };
  try {
    await guard(async () => {
      if (client && (await client.ping()).connectionFileIdentity !== initialCanonical.split('/').at(-1)) {
        throw new Error('canonical-worker-identity-mismatch');
      }
      await source.listTeamIdentities();
    });
  } catch (error) { await client?.close(); throw error; }
  return Object.freeze({
    sharedWorker,
    readSnapshot: () => guard(() => {
      if (client) return client.captureIdentitySnapshot();
      if (!input.drafts.captureIdentitySnapshot) throw new Error('canonical-snapshot-port-unavailable');
      return input.drafts.captureIdentitySnapshot();
    }),
    gateway: Object.freeze({
      listTeamIdentities: () => guard(() => source.listTeamIdentities()),
      getTeamIdentity: (teamId) => guard(() => source.getTeamIdentity(teamId)),
      reserveTeamIdentity: (value) => guard(() => source.reserveTeamIdentity(value)),
      prepareReservedTeamAdoption: (value) => guard(() => source.prepareReservedTeamAdoption(value)),
      recordTeamIdentityFilePublished: (value) => guard(() => source.recordTeamIdentityFilePublished(value)),
      commitTeamAdoption: (value) => guard(() => source.commitTeamAdoption(value)),
      tombstoneTeamIdentity: (value) => guard(() => source.tombstoneTeamIdentity(value)),
    } satisfies TeamIdentityPublicationGateway),
    dispose: async () => { if (!closed) { closed = true; await client?.close(); } },
  });
}
