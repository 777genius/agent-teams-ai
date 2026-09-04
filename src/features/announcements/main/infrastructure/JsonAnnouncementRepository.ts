import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';

import { normalizeAnnouncementState } from '../../core/domain';

import type { AnnouncementState } from '../../contracts';
import type { AnnouncementRepository } from '../../core/application/ports';

const durableWrite = (file: string, value: unknown): Promise<void> =>
  atomicWriteAsync(file, JSON.stringify(value), {
    mode: 0o600,
    durability: 'strict',
    syncDirectory: true,
  });

export class JsonAnnouncementRepository implements AnnouncementRepository {
  private state: AnnouncementState | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly write = durableWrite
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
  initialize(initial: AnnouncementState): Promise<AnnouncementState> {
    return this.enqueue(async () => {
      this.state = null;
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await syncDirectoryDurably(path.dirname(this.directory));
      await syncDirectoryDurably(path.dirname(path.dirname(this.directory)));
      const read = async (name: string): Promise<unknown | undefined> => {
        try {
          return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')) as unknown;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      };
      const state = await read('state.json');
      const marker = await read('initialized.json');
      if (
        marker !== undefined &&
        (typeof marker !== 'object' ||
          marker === null ||
          (marker as { schemaVersion?: unknown }).schemaVersion !== 1)
      )
        throw new Error('state_unavailable');
      if (state === undefined && marker !== undefined) throw new Error('state_unavailable');
      const normalized =
        state === undefined
          ? normalizeAnnouncementState(initial)
          : normalizeAnnouncementState(state);
      if (state === undefined)
        await this.write(path.join(this.directory, 'state.json'), normalized);
      if (marker === undefined)
        await this.write(path.join(this.directory, 'initialized.json'), { schemaVersion: 1 });
      this.state = normalized;
      return structuredClone(normalized);
    });
  }
  update(change: (current: AnnouncementState) => AnnouncementState): Promise<AnnouncementState> {
    return this.enqueue(async () => {
      if (!this.state) throw new Error('state_unavailable');
      const next = normalizeAnnouncementState(change(structuredClone(this.state)));
      try {
        await this.write(path.join(this.directory, 'state.json'), next);
      } catch (error) {
        this.state = null;
        throw error;
      }
      this.state = next;
      return structuredClone(next);
    });
  }
  async drain(): Promise<void> {
    await this.tail;
  }
}
