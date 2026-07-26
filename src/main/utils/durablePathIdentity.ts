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
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
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
  if (!isSameDurablePathIdentity(left, right)) return false;
  return left.ino !== 0 && right.ino !== 0
    ? true
    : left.birthtimeMs === right.birthtimeMs && left.size === right.size;
}
