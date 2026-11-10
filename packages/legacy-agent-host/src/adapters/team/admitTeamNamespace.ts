import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';

import { TeamOwnerError } from '../../team/contracts.js';
import { digest, safeSegment } from '../../team/identity.js';

import type { TeamBinding } from '../../team/contracts.js';

const MAX_STATE_BYTES = 1024 * 1024;

/** Admission is read-only: rejection must not leave a new directory or lock in legacy data. */
function directoriesOnly(target: string): void {
  let part = parse(target).root;
  for (const segment of target.slice(part.length).split('/').filter(Boolean)) {
    part = join(part, segment);
    try {
      const stat = lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TeamOwnerError('hold');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function ownershipState(path: string): Record<string, unknown> | undefined {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STATE_BYTES)
    throw new TeamOwnerError('hold');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new TeamOwnerError('hold');
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length > MAX_STATE_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new TeamOwnerError('hold');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TeamOwnerError('hold');
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/**
 * Authoritative per-Team anti-adoption boundary, before TeamOwnerStore can mkdir.
 * Existing schema-1 Host state is the ownership proof, including ready:false
 * interrupted bootstrap. A missing marker never grants ownership of product data.
 * Other Team namespaces are not read or claimed by this factory; selecting an
 * isolated profile root remains trusted host composition's separate responsibility.
 */
export function admitTeamNamespace(root: string, binding: TeamBinding): void {
  if (!isAbsolute(root) || resolve(root) !== root) throw new TeamOwnerError('invalid');
  for (const value of Object.values(binding)) safeSegment(value);
  const team = join(root, 'teams', safeSegment(binding.teamName));
  const tasks = join(root, 'tasks', binding.teamName);
  const owner = join(team, '.host-owner');
  try {
    directoriesOnly(owner);
    directoriesOnly(tasks);
    const state = ownershipState(join(owner, 'state.json'));
    if (state) {
      if (
        state.schemaVersion !== 1 ||
        typeof state.ready !== 'boolean' ||
        !Array.isArray(state.members) ||
        !Array.isArray(state.grants)
      )
        throw new TeamOwnerError('hold');
      if (digest(state.binding) !== digest(binding)) throw new TeamOwnerError('conflict');
      return;
    }
    // An empty preconstructed store is useful in fault-injection fixtures. Its
    // mere directory is not an ownership marker for pre-existing product records.
    if (
      entries(team).some((entry) => entry !== '.host-owner') ||
      entries(tasks).length ||
      entries(owner).length
    )
      throw new TeamOwnerError('conflict');
  } catch (error) {
    if (error instanceof TeamOwnerError) throw error;
    throw new TeamOwnerError('hold');
  }
}
