import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RuntimePayloadEntry = [relativePath: string, kindOrSha256: string];
export const RUNTIME_PAYLOAD_RECEIPT_NAME = '.archive-payload.json';

function createPayloadIoScope() {
  let active = 0;
  const waiting: (() => void)[] = [];
  let failed = false;
  let firstFailure: unknown;
  function fail(error: unknown): unknown {
    if (!failed) {
      failed = true;
      firstFailure = error;
    }
    return firstFailure;
  }
  async function io<T>(operation: () => Promise<T>): Promise<T> {
    if (failed) throw firstFailure;
    if (active >= 32) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      if (failed) throw firstFailure;
      return await operation();
    } catch (error: unknown) {
      throw fail(error);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  async function settle<T>(operations: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(operations);
    if (results.some((result) => result.status === 'rejected')) throw firstFailure;
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }
  return { io, fail, settle };
}

/** Full copy-integrity inventory, preserving the original sorted depth-first receipt order. */
export async function inventoryRuntimePayload(root: string): Promise<RuntimePayloadEntry[]> {
  // Bound open files and stream buffers even for very large companion trees.
  const scope = createPayloadIoScope();
  async function visit(relative = ''): Promise<RuntimePayloadEntry[]> {
    const names = (await scope.io(() => fs.promises.readdir(path.join(root, relative)))).sort();
    const results = await scope.settle(
      names
        .filter((name) => relative || name !== RUNTIME_PAYLOAD_RECEIPT_NAME)
        .map(async (name): Promise<RuntimePayloadEntry[]> => {
          const key = relative ? `${relative}/${name}` : name;
          const file = path.join(root, key);
          const stat = await scope.io(() => fs.promises.lstat(file));
          if (stat.isDirectory()) {
            const entry: RuntimePayloadEntry = [key, 'directory'];
            return [entry, ...(await visit(key))];
          }
          if (!stat.isFile())
            throw scope.fail(new Error(`Unsupported runtime archive entry: ${key}`));
          const digest = await scope.io(async () => {
            const hash = createHash('sha256');
            for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 }))
              hash.update(chunk);
            return hash.digest('hex');
          });
          return [[key, digest]];
        })
    );
    return results.flat();
  }
  return visit();
}

/** Copy inventoried entries; keep the private root writable (0700), preserving child modes. */
export async function copyRuntimePayload(
  source: string,
  stage: string,
  entries: readonly RuntimePayloadEntry[]
): Promise<void> {
  const children = new Map<string, RuntimePayloadEntry[]>();
  for (const entry of entries) {
    const parent = path.posix.dirname(entry[0]);
    const key = parent === '.' ? '' : parent;
    const group = children.get(key) ?? [];
    group.push(entry);
    children.set(key, group);
  }
  const scope = createPayloadIoScope();
  await scope.io(async () => {
    const stat = await fs.promises.lstat(source);
    if (!stat.isDirectory()) throw new Error('Unsupported runtime archive source directory');
    await fs.promises.mkdir(stage, { mode: 0o700 });
  });
  async function copy(entry: RuntimePayloadEntry): Promise<void> {
    const [key, kind] = entry;
    const from = path.join(source, key);
    const to = path.join(stage, key);
    const mode = await scope.io(async () => {
      const stat = await fs.promises.lstat(from);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
        throw new Error(`Runtime payload entry changed kind while copying: ${key}`);
      if (kind === 'directory') await fs.promises.mkdir(to, { mode: 0o700 });
      else {
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(to, stat.mode & 0o7777);
      }
      return stat.mode & 0o7777;
    });
    if (kind === 'directory') {
      // Do not hold an I/O permit while waiting for descendants.
      await scope.settle((children.get(key) ?? []).map(copy));
      await scope.io(() => fs.promises.chmod(to, mode));
    }
  }
  // Keep stage ownership until every admitted copy has settled on error as well.
  await scope.settle((children.get('') ?? []).map(copy));
}
