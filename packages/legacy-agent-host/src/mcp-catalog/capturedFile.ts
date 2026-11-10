import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';

export class McpCatalogUnavailable extends Error {
  constructor() {
    super('Captured MCP catalog unavailable');
  }
}

function directories(target: string): void {
  if (!isAbsolute(target) || resolve(target) !== target || target.includes('\0'))
    throw new McpCatalogUnavailable();
  let current = parse(target).root;
  for (const segment of target.slice(current.length).split('/').slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpCatalogUnavailable();
  }
}

/** Exact trusted path only: bounded stable FD reads; absence is distinct from unreadable config. */
export function readCapturedMcpBytes(target: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    directories(target);
    let before;
    try {
      before = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes)
      throw new McpCatalogUnavailable();
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1
    )
      throw new McpCatalogUnavailable();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new McpCatalogUnavailable();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new McpCatalogUnavailable();
    const after = fstatSync(fd),
      pathAfter = lstatSync(target);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.nlink !== 1 ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    )
      throw new McpCatalogUnavailable();
    directories(target);
    return bytes;
  } catch {
    throw new McpCatalogUnavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
