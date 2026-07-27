import type * as fs from 'node:fs';

export interface DurablePathIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export interface DurableFileIdentity extends DurablePathIdentity {
  size: number;
}

export function getDurablePathIdentity(
  stats: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs'>
): DurablePathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

export function isSameDurablePathIdentity(
  left: DurablePathIdentity,
  right: DurablePathIdentity
): boolean {
  return (
    left.dev === right.dev &&
    hasTrustworthyDurablePathIdentity(left) &&
    hasTrustworthyDurablePathIdentity(right) &&
    left.ino === right.ino
  );
}

export function hasTrustworthyDurablePathIdentity(identity: DurablePathIdentity): boolean {
  return Number.isSafeInteger(identity.ino) && identity.ino > 0;
}

export function getDurableFileIdentity(
  stats: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs' | 'size'>
): DurableFileIdentity {
  return {
    ...getDurablePathIdentity(stats),
    size: stats.size,
  };
}

export function isSameDurableFileIdentity(
  left: DurableFileIdentity,
  right: DurableFileIdentity
): boolean {
  return (
    isSameDurablePathIdentity(left, right) &&
    left.birthtimeMs === right.birthtimeMs &&
    left.size === right.size
  );
}
