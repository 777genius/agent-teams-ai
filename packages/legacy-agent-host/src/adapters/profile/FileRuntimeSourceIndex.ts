import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { runtimeDigest } from '../../runtime/identity.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import {
  runtimeSourceCandidateSchema,
  runtimeSourceGrantSchema,
} from '../../composition/runtimeSourceContracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeSourceRecordSchema = z
  .object({
    revision: hash,
    previousRevision: hash,
    commandId: z.string().min(1).max(256),
    grant: runtimeSourceGrantSchema,
    candidate: runtimeSourceCandidateSchema,
  })
  .strict();
export type RuntimeSourceRecord = z.infer<typeof runtimeSourceRecordSchema>;
const indexSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(runtimeSourceRecordSchema).max(1024),
    current: z
      .array(
        z.object({ sourceId: hash, revision: hash, commandId: z.string().min(1).max(256) }).strict()
      )
      .max(256),
  })
  .strict();
type SourceIndex = z.infer<typeof indexSchema>;
const maximumBytes = 8 * 1024 * 1024;
const held = (): never => {
  throw new ManagementCommandError('held');
};

/** Base selections and pointers only; the existing management journal owns command outcomes. */
export class FileRuntimeSourceIndex {
  private readonly directory: string;
  private readonly identity: { dev: number; ino: number };
  private observedDigest: string | undefined;

  constructor(
    root: string,
    private readonly assertWriter: () => void
  ) {
    assertWriter();
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) held();
    this.directory = join(root, 'runtime-sources');
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(this.directory) !== this.directory
    )
      held();
    this.identity = { dev: stat.dev, ino: stat.ino };
  }

  read(): SourceIndex {
    this.check();
    const path = join(this.directory, 'index.json');
    let before;
    try {
      before = lstatSync(path);
    } catch (error) {
      this.check();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.observedDigest === undefined)
        return { schemaVersion: 1, records: [], current: [] };
      return held();
    }
    let fd: number | undefined;
    try {
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > maximumBytes ||
        (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
      )
        held();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        held();
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        bytes.length > maximumBytes ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        held();
      const { digest, ...body } = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      ) as Record<string, unknown>;
      if (digest !== runtimeDigest(body) || (this.observedDigest !== undefined && digest !== this.observedDigest)) held();
      const parsed = indexSchema.parse(body);
      if (
        new Set(parsed.records.map((row) => row.revision)).size !== parsed.records.length ||
        new Set(parsed.records.map((row) => row.commandId)).size !== parsed.records.length ||
        new Set(parsed.current.map((row) => row.sourceId)).size !== parsed.current.length
      )
        held();
      for (const record of parsed.records) {
        const { revision, ...selection } = record;
        if (revision !== runtimeDigest(selection)) held();
      }
      for (const pointer of parsed.current) {
        const record = parsed.records.find((row) => row.revision === pointer.revision);
        if (
          !record ||
          record.grant.targetId !== pointer.sourceId ||
          record.commandId !== pointer.commandId
        )
          held();
      }
      this.check();
      this.observedDigest = runtimeDigest(body);
      return parsed;
    } catch {
      return held();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  publish(record: RuntimeSourceRecord, seedRevision: string): void {
    const index = this.read();
    if (
      index.records.some(
        (row) => row.revision === record.revision || row.commandId === record.commandId
      )
    )
      held();
    const prior = index.current.find((row) => row.sourceId === record.grant.targetId);
    if ((prior?.revision ?? seedRevision) !== record.previousRevision)
      throw new ManagementCommandError('conflict');
    const next = indexSchema.parse({
      schemaVersion: 1,
      records: [...index.records, runtimeSourceRecordSchema.parse(record)],
      current: [
        ...index.current.filter((row) => row.sourceId !== record.grant.targetId),
        { sourceId: record.grant.targetId, revision: record.revision, commandId: record.commandId },
      ],
    });
    const bytes = JSON.stringify({ ...next, digest: runtimeDigest(next) });
    if (Buffer.byteLength(bytes) > maximumBytes) held();
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.check();
      if (runtimeDigest(this.read()) !== runtimeDigest(index)) held();
      renameSync(temporary, join(this.directory, 'index.json'));
      this.observedDigest = runtimeDigest(next);
      if (process.platform !== 'win32') {
        const directory = openSync(
          this.directory,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
      this.check();
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* Unpublished temporary files carry no source authority. */
      }
    }
  }

  private check(): void {
    this.assertWriter();
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      realpathSync(this.directory) !== this.directory
    )
      held();
  }
}
