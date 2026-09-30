import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  HostedRecentMetadataFact,
  HostedRecentMetadataRead,
  HostedRecentMetadataSource,
  HostedRecentProvider,
} from './ports';

const MAX_FILES = 512;
const MAX_DIRECTORIES = 256;
const MAX_ENTRIES = 2_048;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_READ_MS = 5_000;
// Linux O_PATH permits pinning traverse-only ancestors without granting read access.
const LINUX_O_PATH = 0o10000000;
const CLAUDE_METADATA_KEYS = new Set([
  'parentUuid',
  'isSidechain',
  'userType',
  'cwd',
  'sessionId',
  'version',
  'gitBranch',
  'type',
  'timestamp',
  'uuid',
  'isMeta',
]);
const CODEX_TOP_LEVEL_KEYS = new Set(['type', 'timestamp', 'payload']);
const CODEX_PAYLOAD_KEYS = new Set([
  'id',
  'timestamp',
  'cwd',
  'originator',
  'cli_version',
  'source',
  'model_provider',
]);

type Header = Record<string, unknown>;
type DirectoryNode = { handle: fs.FileHandle; directory: string; depth: number };

function anchoredPath(node: DirectoryNode, name?: string): string {
  const base = `/proc/self/fd/${node.handle.fd}`;
  return name === undefined ? base : path.join(base, name);
}

async function openDirectory(directory: string, pathOnly = false): Promise<fs.FileHandle> {
  const handle = await fs.open(
    directory,
    (pathOnly ? LINUX_O_PATH : constants.O_RDONLY) | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    if (!(await handle.stat()).isDirectory())
      throw new TypeError('hosted-recent-directory-changed');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openMount(mount: string): Promise<DirectoryNode> {
  let directory = path.parse(mount).root;
  let handle = await openDirectory(directory, true);
  try {
    for (const part of path
      .resolve(mount)
      .slice(directory.length)
      .split(path.sep)
      .filter(Boolean)) {
      const parent: DirectoryNode = { handle, directory, depth: 0 };
      const next = await openDirectory(anchoredPath(parent, part), true);
      await handle.close();
      handle = next;
      directory = path.join(directory, part);
    }
    return { handle, directory, depth: 0 };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function record(value: unknown): Header | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Header)
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    return milliseconds >= 0 ? milliseconds : null;
  }
  if (typeof value !== 'string' || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

async function openMetadataFile(
  file: string,
  expected: { dev: number; ino: number }
): Promise<fs.FileHandle> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new TypeError('hosted-recent-metadata-file-changed');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readHeader(
  file: string,
  expected: { dev: number; ino: number }
): Promise<Header | null> {
  const handle = await openMetadataFile(file, expected);
  const byte = Buffer.alloc(1);
  let prefix = '';
  const containers: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  let keyStart = -1;
  let preceding = '';
  let terminated = false;
  try {
    for (let offset = 0; offset < MAX_HEADER_BYTES; offset++) {
      const { bytesRead } = await handle.read(byte, 0, 1, offset);
      if (bytesRead === 0 || byte[0] === 10) {
        terminated = true;
        break;
      }
      const character = String.fromCharCode(byte[0]);
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          if (keyStart >= 0) {
            const key = JSON.parse(prefix.slice(keyStart) + '"') as string;
            const depth = containers.length;
            if (
              (depth === 1 && !CODEX_TOP_LEVEL_KEYS.has(key)) ||
              (depth === 2 && !CODEX_PAYLOAD_KEYS.has(key))
            ) {
              const closing = [...containers]
                .reverse()
                .map((item) => (item === '{' ? '}' : ']'))
                .join('');
              const metadata = prefix.slice(0, keyStart).replace(/,\s*$/, '') + closing;
              return record(JSON.parse(Buffer.from(metadata, 'latin1').toString('utf8')));
            }
            keyStart = -1;
          }
        }
      } else if (character === '"') {
        inString = true;
        if (containers.at(-1) === '{' && (preceding === '{' || preceding === ','))
          keyStart = prefix.length;
      } else if (character === '{' || character === '[') {
        containers.push(character);
      } else if (character === '}' || character === ']') {
        containers.pop();
      }
      if (!/\s/.test(character)) preceding = character;
      prefix += character;
    }
    return terminated ? record(JSON.parse(Buffer.from(prefix, 'latin1').toString('utf8'))) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Claude JSONL is a transcript. Read only the top-level metadata prefix and stop
 * before any content-bearing field; never fetch a byte of the message value.
 */
async function readClaudeHeader(
  file: string,
  expected: { dev: number; ino: number }
): Promise<Header | null> {
  const handle = await openMetadataFile(file, expected);
  const byte = Buffer.alloc(1);
  let prefix = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyStart = -1;
  let key = '';
  let preceding = '';
  let terminated = false;
  try {
    for (let offset = 0; offset < MAX_HEADER_BYTES; offset++) {
      const { bytesRead } = await handle.read(byte, 0, 1, offset);
      if (bytesRead === 0 || byte[0] === 10) {
        terminated = true;
        break;
      }
      const character = String.fromCharCode(byte[0]);
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          if (keyStart >= 0) {
            key = JSON.parse(prefix.slice(keyStart, prefix.length) + '"') as string;
            if (!CLAUDE_METADATA_KEYS.has(key)) {
              const metadata = prefix.slice(0, keyStart).replace(/,\s*$/, '') + '}';
              return record(JSON.parse(Buffer.from(metadata, 'latin1').toString('utf8')));
            }
            keyStart = -1;
          }
        }
      } else if (character === '"') {
        inString = true;
        if (depth === 1 && (preceding === '{' || preceding === ',')) keyStart = prefix.length;
      } else if (character === '{' || character === '[') {
        depth++;
      } else if (character === '}' || character === ']') {
        depth--;
      }
      if (!/\s/.test(character)) preceding = character;
      prefix += character;
    }
    return terminated ? record(JSON.parse(Buffer.from(prefix, 'latin1').toString('utf8'))) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function factFromHeader(
  provider: HostedRecentProvider,
  header: Header,
  mtimeMs: number
): HostedRecentMetadataFact | null {
  const source = provider === 'codex' ? record(header.payload) : header;
  if (provider === 'codex' && header.type !== 'session_meta') return null;
  if (provider === 'codex' && source?.source !== 'cli' && source?.source !== 'vscode') return null;
  if (
    provider === 'anthropic' &&
    header.type !== 'user' &&
    header.type !== 'assistant' &&
    header.type !== 'system'
  )
    return null;
  const cwd = source?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 4096) return null;
  const observedAt =
    provider === 'codex'
      ? timestamp(source?.timestamp ?? header.timestamp)
      : Number.isFinite(mtimeMs) && mtimeMs >= 0
        ? mtimeMs
        : null;
  if (observedAt === null) return null;
  return { cwd, observedAt };
}

/** Metadata traversal is rooted solely at explicit RO subtree mounts. */
export class HostedRecentMetadataReader implements HostedRecentMetadataSource {
  readonly provider: HostedRecentProvider;
  readonly #mounts: readonly string[];

  constructor(provider: HostedRecentProvider, mounts: readonly string[]) {
    this.provider = provider;
    this.#mounts = mounts;
  }

  async read(
    admit: (fact: HostedRecentMetadataFact) => Promise<void>
  ): Promise<HostedRecentMetadataRead> {
    if (
      process.platform !== 'linux' ||
      this.#mounts.length === 0 ||
      (this.provider === 'codex' && this.#mounts.length !== 2)
    ) {
      return { status: 'unavailable' };
    }
    let status: HostedRecentMetadataRead['status'] = 'complete';
    let visitedFiles = 0;
    let visitedDirectories = 0;
    let visitedEntries = 0;
    const deadline = Date.now() + MAX_READ_MS;
    const queue: DirectoryNode[] = [];
    for (const mount of this.#mounts) {
      if (!path.isAbsolute(mount) || mount.includes('\0')) {
        await Promise.all(queue.map((node) => node.handle.close()));
        return { status: 'unavailable' };
      }
      try {
        queue.push(await openMount(mount));
      } catch {
        await Promise.all(queue.map((node) => node.handle.close()));
        return { status: 'unavailable' };
      }
    }
    try {
      while (queue.length > 0) {
        if (++visitedDirectories > MAX_DIRECTORIES || Date.now() > deadline)
          return { status: 'partial' };
        const current = queue.shift();
        if (!current) break;
        try {
          const directory = await fs.opendir(anchoredPath(current));
          for await (const entry of directory) {
            if (++visitedEntries > MAX_ENTRIES || Date.now() > deadline)
              return { status: 'partial' };
            // Each child is opened relative to the pinned parent on Linux.
            if (entry.isSymbolicLink()) {
              status = 'partial';
              continue;
            }
            const child = anchoredPath(current, entry.name);
            if (entry.isDirectory()) {
              const maxDepth = this.provider === 'anthropic' ? 1 : 4;
              if (current.depth < maxDepth) {
                if (queue.length + visitedDirectories >= MAX_DIRECTORIES)
                  return { status: 'partial' };
                try {
                  queue.push({
                    handle: await openDirectory(child),
                    directory: path.join(current.directory, entry.name),
                    depth: current.depth + 1,
                  });
                } catch {
                  status = 'partial';
                }
              } else status = 'partial';
              continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            if (++visitedFiles > MAX_FILES) return { status: 'partial' };
            let fact: HostedRecentMetadataFact | null = null;
            try {
              const stat = await fs.lstat(child);
              if (!stat.isFile()) {
                status = 'partial';
                continue;
              }
              const header =
                this.provider === 'anthropic'
                  ? await readClaudeHeader(child, stat)
                  : await readHeader(child, stat);
              fact = header ? factFromHeader(this.provider, header, stat.mtimeMs) : null;
            } catch {
              status = 'partial';
            }
            if (fact) await admit(fact);
            else status = 'partial';
          }
        } catch {
          status = 'partial';
        } finally {
          await current.handle.close();
        }
      }
    } finally {
      await Promise.all(queue.map((node) => node.handle.close()));
    }
    return { status };
  }
}
