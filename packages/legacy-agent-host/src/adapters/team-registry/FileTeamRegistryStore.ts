import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { TeamOwnerError } from '../../team/contracts.js';
import { digest } from '../../team/identity.js';
import { storedTeamCreationSchema } from '../../team-registry/state.js';
import { withTeamFileFence, writeTeamJson } from '../team/ControllerAdapter.js';

import type { StoredTeamCreation, TeamRegistryStore } from '../../team-registry/state.js';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/** Lazy, bounded journal. The existing controller lock and atomic JSON primitive own publication. */
export class FileTeamRegistryStore implements TeamRegistryStore {
  readonly directory: string;
  private readonly records: string;

  constructor(
    private readonly root: string,
    private readonly assertWriter: () => void
  ) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new TeamOwnerError('invalid');
    this.directory = join(root, '.host-team-registry');
    this.records = join(this.directory, 'records');
  }

  /** Every ancestor must be a plain directory, including on subsequent calls. */
  private directories(target: string, create: boolean): boolean {
    let part = parse(target).root;
    for (const segment of target.slice(part.length).split('/').filter(Boolean)) {
      part = join(part, segment);
      try {
        const stat = lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TeamOwnerError('hold');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return false;
        this.assertWriter();
        mkdirSync(part);
      }
    }
    return true;
  }

  fenced<T>(action: () => T): T {
    this.assertWriter();
    this.directories(this.root, false);
    this.directories(this.records, true);
    return withTeamFileFence(join(this.directory, 'authority'), () => {
      this.assertWriter();
      this.directories(this.records, false);
      return action();
    });
  }

  readAll(): StoredTeamCreation[] {
    try {
      if (!this.directories(this.records, false)) return [];
      const files = readdirSync(this.records);
      // Interrupted atomic-write candidates are retained, never interpreted as outcomes.
      const records = files.filter((name) => !/^\.tmp\.[a-f0-9-]{36}$/.test(name));
      if (records.length > 256 || files.length > 512) throw new TeamOwnerError('hold');
      return records.sort().map((name) => {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new TeamOwnerError('hold');
        const record = this.read(join(this.records, name));
        if (name !== `${digest(record.commandId)}.json`) throw new TeamOwnerError('hold');
        return record;
      });
    } catch {
      throw new TeamOwnerError('hold');
    }
  }

  private read(path: string): StoredTeamCreation {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES)
      throw new TeamOwnerError('hold');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new TeamOwnerError('hold');
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      if (
        length > MAX_RECORD_BYTES ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs
      )
        throw new TeamOwnerError('hold');
      return storedTeamCreationSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
      );
    } finally {
      closeSync(fd);
    }
  }

  write(record: StoredTeamCreation): void {
    this.assertWriter();
    this.directories(this.records, false);
    const parsed = storedTeamCreationSchema.parse(record);
    if (Buffer.byteLength(JSON.stringify(parsed, null, 2)) > MAX_RECORD_BYTES)
      throw new TeamOwnerError('invalid');
    const path = join(this.records, `${digest(parsed.commandId)}.json`);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TeamOwnerError('hold');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.assertWriter();
    writeTeamJson(path, parsed);
  }
}
