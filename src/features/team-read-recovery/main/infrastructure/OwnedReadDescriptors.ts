import * as fs from 'node:fs';

import { normalizePhysicalFault } from '../../core/application/physicalFault';

import { intrinsicByteLength } from './intrinsicByteLength';

import type { PhysicalOutcome, RawReadTask } from '../../core/application/PhysicalReadScope';

/** Narrow native port; production defaults are original callback operations. */
export interface DescriptorCallbacks {
  open(
    path: string,
    flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void;
  openWithMode?(
    path: string,
    flags: number,
    mode: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void;
  read(
    fd: number,
    buffer: Buffer,
    offset: number,
    bytes: number,
    position: number,
    callback: (error: NodeJS.ErrnoException | null, count: number) => void
  ): void;
  fstat(fd: number, callback: (error: NodeJS.ErrnoException | null, value: fs.Stats) => void): void;
  write(
    fd: number,
    buffer: Buffer,
    offset: number,
    bytes: number,
    position: number,
    callback: (error: NodeJS.ErrnoException | null, count: number) => void
  ): void;
  fsync(fd: number, callback: (error: NodeJS.ErrnoException | null) => void): void;
  close(fd: number, callback: (error: NodeJS.ErrnoException | null) => void): void;
}

const nativeCallbacks: DescriptorCallbacks = {
  ...fs,
  openWithMode: (path, flags, mode, callback) => fs.open(path, flags, mode, callback),
};

const closed: PhysicalOutcome = Object.freeze({ kind: 'closed' });

export interface DescriptorLimits {
  readonly maxOpenFiles: number;
  readonly maxReadsPerFile: number;
}

export interface DescriptorAcquisition extends RawReadTask<OwnedReadDescriptor> {
  close(): Promise<PhysicalOutcome>;
}

interface Acquisition {
  cancelled?: boolean;
  readonly lease: number;
  readonly physical: Promise<PhysicalOutcome>;
  descriptor?: OwnedReadDescriptor;
  fault?: string;
}

/** No numeric fd or payload is exposed by diagnostic lease records. */
export class OwnedReadDescriptor {
  readonly physical: Promise<PhysicalOutcome>;
  readonly #fd: number;
  private settle!: (outcome: PhysicalOutcome) => void;
  private closing = false;
  private closeStarted = false;
  private reads = 0;
  private uncertain = false;

  constructor(
    fd: number,
    private readonly native: DescriptorCallbacks,
    private readonly maxReads: number,
    private readonly onUnknown: (message: string) => void,
    private readonly onClosed: () => void
  ) {
    this.#fd = fd;
    this.physical = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  read(position: number, bytes: number): RawReadTask<Uint8Array> {
    if (this.closing) throw new Error('Descriptor is closing');
    if (this.reads >= this.maxReads) throw new Error('Descriptor read capacity reached');
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 1024 * 1024
    )
      throw new Error('Invalid read range');
    // Capacity is checked before allocating an outstanding native buffer.
    const buffer = Buffer.alloc(bytes);
    return this.startOperation<Uint8Array>((completed) => {
      this.native.read(this.#fd, buffer, 0, bytes, position, (error, count) =>
        completed(error, buffer.subarray(0, count))
      );
    });
  }

  stat(): RawReadTask<fs.Stats> {
    return this.startOperation<fs.Stats>((completed) => this.native.fstat(this.#fd, completed));
  }

  write(position: number, data: Uint8Array): RawReadTask<number> {
    if (this.closing) throw new Error('Descriptor is closing');
    if (this.reads >= this.maxReads) throw new Error('Descriptor read capacity reached');
    const byteLength = intrinsicByteLength(data);
    if (!Number.isSafeInteger(position) || position < 0 || byteLength > 1024 * 1024)
      throw new Error('Invalid write range');
    // Copy before asynchronous dispatch; callers may mutate or transfer their buffer afterwards.
    const buffer = Buffer.copyBytesFrom(data, 0, byteLength);
    return this.startOperation<number>((completed) =>
      this.native.write(this.#fd, buffer, 0, buffer.byteLength, position, completed)
    );
  }

  sync(): RawReadTask<void> {
    return this.startOperation<void>((completed) =>
      this.native.fsync(this.#fd, (error) => completed(error, undefined))
    );
  }

  private startOperation<T>(
    dispatch: (completed: (error: NodeJS.ErrnoException | null, value: T) => void) => void
  ): RawReadTask<T> {
    if (this.closing) throw new Error('Descriptor is closing');
    if (this.reads >= this.maxReads) throw new Error('Descriptor read capacity reached');
    // The per-file cap covers reads, metadata, writes and durability operations.
    this.reads++;
    let finish!: (outcome: PhysicalOutcome) => void;
    const physical = new Promise<PhysicalOutcome>((resolve) => {
      finish = resolve;
    });
    let observed = false;
    const result = new Promise<T>((resolve, reject) => {
      const completed = (error: NodeJS.ErrnoException | null, value: T): void => {
        if (observed) return;
        observed = true;
        if (error) reject(error);
        else resolve(value);
        this.reads--;
        finish(closed);
        this.tryClose();
      };
      try {
        dispatch(completed);
      } catch (error) {
        const message = normalizePhysicalFault(error);
        reject(new Error(message));
        if (!observed) {
          // Throw does not prove non-dispatch. Only an original callback releases capacity.
          finish({ kind: 'unknown', fault: message });
          this.markUnknown(message);
        }
      }
    });
    void result.catch(() => undefined);
    return { result, physical };
  }

  close(): Promise<PhysicalOutcome> {
    this.closing = true;
    this.tryClose();
    return this.physical;
  }

  private markUnknown(message: string): void {
    this.uncertain = true;
    this.closing = true;
    this.settle({ kind: 'unknown', fault: message });
    this.onUnknown(message);
  }

  private tryClose(): void {
    if (!this.closing || this.closeStarted || this.reads !== 0) return;
    this.closeStarted = true;
    let observed = false;
    const completed = (error: NodeJS.ErrnoException | null): void => {
      if (observed) return;
      observed = true;
      if (error) this.markUnknown(normalizePhysicalFault(error));
      else {
        this.onClosed();
        if (!this.uncertain) this.settle(closed);
      }
    };
    try {
      this.native.close(this.#fd, completed);
    } catch (error) {
      if (!observed) this.markUnknown(normalizePhysicalFault(error));
    }
    // Never retry: even a throwing close may have dispatched and the fd may be reused.
  }
}

/** Retains uncertain acquisitions and their exact lease identity until owner disposal. */
export class OwnedReadDescriptors {
  private retired = false;
  private suspended = false;
  private nextLease = 0;
  private readonly acquisitions = new Set<Acquisition>();
  private retirement: Promise<PhysicalOutcome> | undefined;
  private readonly limits: DescriptorLimits;

  constructor(
    private readonly native: DescriptorCallbacks = nativeCallbacks,
    limits: DescriptorLimits = {
      maxOpenFiles: process.platform === 'win32' ? 4 : 12,
      maxReadsPerFile: 1,
    }
  ) {
    if (
      !Number.isSafeInteger(limits.maxOpenFiles) ||
      limits.maxOpenFiles < 1 ||
      !Number.isSafeInteger(limits.maxReadsPerFile) ||
      limits.maxReadsPerFile < 1
    ) {
      throw new Error('Invalid descriptor capacity');
    }
    this.limits = Object.freeze({ ...limits });
  }

  unresolvedLeases(): readonly { lease: number; fault: string }[] {
    return [...this.acquisitions].flatMap((record) =>
      record.fault === undefined ? [] : [{ lease: record.lease, fault: record.fault }]
    );
  }

  open(path: string, flags: number = fs.constants.O_RDONLY, mode?: number): DescriptorAcquisition {
    if (!Number.isSafeInteger(flags) || flags < 0) throw new Error('Invalid descriptor flags');
    if (mode !== undefined) {
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777)
        throw new Error('Invalid descriptor mode');
      if (!this.native.openWithMode) throw new Error('Native descriptor mode port is unavailable');
    }
    if (this.retired) throw new Error('Descriptor owner is retired');
    if (this.suspended) throw new Error('Descriptor owner has unresolved physical work');
    if (this.acquisitions.size >= this.limits.maxOpenFiles)
      throw new Error('Descriptor acquisition capacity reached');
    let finish!: (outcome: PhysicalOutcome) => void;
    const physical = new Promise<PhysicalOutcome>((resolve) => {
      finish = resolve;
    });
    const record: Acquisition = { lease: ++this.nextLease, physical };
    this.acquisitions.add(record);
    let observed = false;
    const markUnknown = (message: string): void => {
      record.fault ??= message;
      this.suspended = true;
      finish({ kind: 'unknown', fault: record.fault });
      // Stop scheduling all affected leases; original callbacks still own cleanup.
      for (const acquisition of this.acquisitions) void acquisition.descriptor?.close();
    };
    const result = new Promise<OwnedReadDescriptor>((resolve, reject) => {
      const completed = (error: NodeJS.ErrnoException | null, fd: number): void => {
        if (observed) return;
        observed = true;
        if (error) {
          reject(error);
          finish(closed);
          return;
        }
        const descriptor = new OwnedReadDescriptor(
          fd,
          this.native,
          this.limits.maxReadsPerFile,
          markUnknown,
          () => {
            delete record.descriptor;
          }
        );
        record.descriptor = descriptor;
        void descriptor.physical.then((outcome) => {
          if (outcome.kind === 'unknown') markUnknown(outcome.fault);
          else finish(closed);
        });
        if (this.retired || this.suspended || record.cancelled) {
          reject(new Error('Descriptor owner retired during open'));
          void descriptor.close();
        } else resolve(descriptor);
      };
      try {
        if (mode === undefined) this.native.open(path, flags, completed);
        else this.native.openWithMode!(path, flags, mode, completed);
      } catch (error) {
        const message = normalizePhysicalFault(error);
        reject(new Error(message));
        if (!observed) markUnknown(message);
      }
    });
    void result.catch(() => undefined);
    void physical.then((outcome) => {
      if (outcome.kind === 'closed' && record.fault === undefined) this.acquisitions.delete(record);
    });
    return {
      result,
      physical,
      close: () => {
        record.cancelled = true;
        void record.descriptor?.close();
        return physical;
      },
    };
  }

  retire(): Promise<PhysicalOutcome> {
    if (this.retirement) return this.retirement;
    this.retired = true;
    for (const record of this.acquisitions) void record.descriptor?.close();
    this.retirement = Promise.all([...this.acquisitions].map((record) => record.physical)).then(
      (outcomes) => outcomes.find((outcome) => outcome.kind === 'unknown') ?? closed
    );
    return this.retirement;
  }
}
