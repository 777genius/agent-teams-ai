import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { atomicCreateAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';

import type { TeamModelProbeIntents } from '../application/TeamModelProbeIntents';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
type Kind = 'preparation' | 'successor';

/** Immutable intent associations, not outcomes. No mutable head or replacement race. */
export class FileTeamModelProbeIntents implements TeamModelProbeIntents {
  constructor(
    private readonly directory: string,
    private readonly durabilityRoot = directory
  ) {
    if (
      !isAbsolute(directory) ||
      !isAbsolute(durabilityRoot) ||
      directory.includes('\0') ||
      durabilityRoot.includes('\0')
    )
      throw new Error('Invalid model intent directory');
    this.directory = resolve(directory);
    this.durabilityRoot = resolve(durabilityRoot);
    const path = relative(this.durabilityRoot, this.directory);
    if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path))
      throw new Error('Invalid model intent directory');
  }
  private async syncNamespace(directory: string): Promise<void> {
    // The caller's existing userData/TEST root anchors all newly created children.
    // Flush every directory entry up to that root, including on acknowledgment loss.
    for (let current = directory; ; current = dirname(current)) {
      await syncDirectoryDurably(current);
      if (relative(this.durabilityRoot, current) === '') return;
      if (dirname(current) === current) throw new Error('Model intent durability root unavailable');
    }
  }
  private location(rootId: string, kind: Kind, key: string) {
    if (!validId(rootId) || !validId(key)) throw new Error('Invalid model intent');
    const directory = join(this.directory, hash(rootId));
    return { directory, path: join(directory, `${kind}-${hash(key)}.json`) };
  }
  private async lookup(rootId: string, kind: Kind, key: string): Promise<string | null> {
    const { directory, path } = this.location(rootId, kind, key);
    let opened = false;
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      opened = true;
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 4096 || (before.mode & 0o077) !== 0)
          throw new Error('Invalid model intent');
        const bytes = Buffer.alloc(4097);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat();
        if (length > 4096 || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error('Invalid model intent');
        const raw = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
        ) as Record<string, unknown>;
        if (
          !raw ||
          Array.isArray(raw) ||
          raw.schemaVersion !== 1 ||
          raw.rootId !== rootId ||
          raw.kind !== kind ||
          raw.key !== key ||
          !validId(raw.commandId) ||
          Object.keys(raw).some(
            (field) =>
              !['schemaVersion', 'rootId', 'kind', 'key', 'commandId', 'digest'].includes(field)
          ) ||
          raw.digest !==
            hash(JSON.stringify({ schemaVersion: 1, rootId, kind, key, commandId: raw.commandId }))
        )
          throw new Error('Invalid model intent');
        // A previous writer may have lost the acknowledgment after publication.
        // Confirm directory durability before treating the retained ID as admitted.
        await this.syncNamespace(directory);
        return raw.commandId;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!opened && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Model intent unavailable');
    }
  }
  private async publish(
    rootId: string,
    kind: Kind,
    key: string,
    commandId: string
  ): Promise<string> {
    if (!validId(commandId)) throw new Error('Invalid model intent');
    const location = this.location(rootId, kind, key);
    if (!(await stat(this.durabilityRoot)).isDirectory())
      throw new Error('Model intent root unavailable');
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    const body = { schemaVersion: 1, rootId, kind, key, commandId };
    try {
      await atomicCreateAsync(
        location.path,
        JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) }) + '\n',
        { mode: 0o600 }
      );
      await this.syncNamespace(location.directory);
      return commandId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('Model intent unavailable');
      const winner = await this.lookup(rootId, kind, key);
      if (!winner) throw new Error('Model intent unavailable');
      return winner;
    }
  }
  async read(rootId: string, preparationId: string) {
    const retained = await this.lookup(rootId, 'preparation', preparationId);
    if (retained) return { commandId: retained, retained: true };
    let commandId = rootId;
    const seen = new Set<string>();
    // A captured launch selection has a finite retry history; corrupt/cyclic
    // metadata must not leave Main in an unbounded directory walk.
    for (let depth = 0; depth < 1024; depth += 1) {
      if (seen.has(commandId)) throw new Error('Model intent cycle');
      seen.add(commandId);
      const next = await this.lookup(rootId, 'successor', commandId);
      if (!next) return { commandId, retained: false };
      commandId = next;
    }
    throw new Error('Model intent history unavailable');
  }
  async admit(
    rootId: string,
    preparationId: string,
    previousCommandId: string,
    renew: boolean
  ): Promise<string> {
    const retained = await this.lookup(rootId, 'preparation', preparationId);
    if (retained) return retained;
    const candidate = renew
      ? await this.publish(rootId, 'successor', previousCommandId, `team-preflight-${randomUUID()}`)
      : previousCommandId;
    // Every render/reload of this preparation returns this same original ID,
    // even if a later preparation has already advanced to another check.
    return this.publish(rootId, 'preparation', preparationId, candidate);
  }
}
