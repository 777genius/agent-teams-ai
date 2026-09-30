export interface AtomicCreateResult {
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
  /** Transaction-owned hardlink that pins the published inode until commit/rollback. */
  pinPath?: string;
}
