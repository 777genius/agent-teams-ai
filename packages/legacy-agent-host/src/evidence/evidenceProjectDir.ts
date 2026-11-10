import { isAbsolute, join, resolve } from 'node:path';
import { safeSegment } from '../team/identity.js';

/** Canonical private evidence root, shared by trusted Host writer/reader composition only. */
export function evidenceProjectDir(ownerStorageRoot: string, teamName: string): string {
  if (!isAbsolute(ownerStorageRoot) || resolve(ownerStorageRoot) !== ownerStorageRoot)
    throw new Error('Invalid evidence storage root');
  return join(ownerStorageRoot, 'teams', safeSegment(teamName), '.host-evidence');
}
