import * as fs from 'node:fs';

import { normalizePhysicalFault } from '../../core/application/physicalFault';

import type { PhysicalOutcome, RawReadTask } from '../../core/application/PhysicalReadScope';

export type CapturedPathOperation =
  | { readonly kind: 'stat' | 'lstat' | 'readdir'; readonly path: string }
  | { readonly kind: 'mkdir'; readonly path: string; readonly recursive: boolean }
  | { readonly kind: 'rename' | 'link'; readonly path: string; readonly destination: string }
  | { readonly kind: 'unlink'; readonly path: string };

export type PathOperationResult = fs.Stats | fs.Dirent[] | void;

export interface PathCallbacks {
  stat(
    path: string,
    callback: (error: NodeJS.ErrnoException | null, value: fs.Stats) => void
  ): void;
  lstat(
    path: string,
    callback: (error: NodeJS.ErrnoException | null, value: fs.Stats) => void
  ): void;
  readdir(
    path: string,
    options: { withFileTypes: true },
    callback: (error: NodeJS.ErrnoException | null, value: fs.Dirent[]) => void
  ): void;
  mkdir(
    path: string,
    options: { recursive: boolean },
    callback: (error: NodeJS.ErrnoException | null) => void
  ): void;
  rename(
    path: string,
    destination: string,
    callback: (error: NodeJS.ErrnoException | null) => void
  ): void;
  link(
    path: string,
    destination: string,
    callback: (error: NodeJS.ErrnoException | null) => void
  ): void;
  unlink(path: string, callback: (error: NodeJS.ErrnoException | null) => void): void;
}

interface PendingOperation {
  readonly physical: Promise<PhysicalOutcome>;
  fault?: string;
}

const closed: PhysicalOutcome = Object.freeze({ kind: 'closed' });

/** Original callback ownership for non-descriptor operations; SourceOwner supplies path authority. */
export class OwnedPathOperations {
  private retired = false;
  private suspended = false;
  private readonly pending = new Set<PendingOperation>();
  private retirement: Promise<PhysicalOutcome> | undefined;

  constructor(
    private readonly native: PathCallbacks = fs,
    private readonly capacity = process.platform === 'win32' ? 4 : 12
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('Invalid path operation capacity');
  }

  execute(input: CapturedPathOperation): RawReadTask<PathOperationResult> {
    if (this.retired) throw new Error('Path operation owner is retired');
    if (this.suspended) throw new Error('Path operation owner has unresolved physical work');
    if (this.pending.size >= this.capacity) throw new Error('Path operation capacity reached');
    // Every primitive argument is copied before dispatch. No completion consults ambient roots.
    const operation = Object.freeze({ ...input });
    let finish!: (outcome: PhysicalOutcome) => void;
    const physical = new Promise<PhysicalOutcome>((resolve) => {
      finish = resolve;
    });
    const record: PendingOperation = { physical };
    this.pending.add(record);
    let observed = false;
    const result = new Promise<PathOperationResult>((resolve, reject) => {
      const completed = (
        error: NodeJS.ErrnoException | null,
        value?: fs.Stats | fs.Dirent[]
      ): void => {
        if (observed) return;
        observed = true;
        if (error) reject(error);
        else resolve(value);
        finish(closed);
      };
      try {
        switch (operation.kind) {
          case 'stat':
            this.native.stat(operation.path, completed);
            break;
          case 'lstat':
            this.native.lstat(operation.path, completed);
            break;
          case 'readdir':
            this.native.readdir(operation.path, { withFileTypes: true }, completed);
            break;
          case 'mkdir':
            this.native.mkdir(operation.path, { recursive: operation.recursive }, (error) =>
              completed(error)
            );
            break;
          case 'rename':
            this.native.rename(operation.path, operation.destination, completed);
            break;
          case 'link':
            this.native.link(operation.path, operation.destination, completed);
            break;
          case 'unlink':
            this.native.unlink(operation.path, completed);
            break;
        }
      } catch (error) {
        const message = normalizePhysicalFault(error);
        reject(new Error(message));
        if (!observed) {
          record.fault = message;
          this.suspended = true;
          finish({ kind: 'unknown', fault: message });
        }
      }
    });
    void result.catch(() => undefined);
    void physical.then((outcome) => {
      if (outcome.kind === 'closed' && record.fault === undefined) this.pending.delete(record);
    });
    return { result, physical };
  }

  retire(): Promise<PhysicalOutcome> {
    if (this.retirement) return this.retirement;
    this.retired = true;
    this.retirement = Promise.all([...this.pending].map((record) => record.physical)).then(
      (outcomes) => outcomes.find((outcome) => outcome.kind === 'unknown') ?? closed
    );
    return this.retirement;
  }
}
