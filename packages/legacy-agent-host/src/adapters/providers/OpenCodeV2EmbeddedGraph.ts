import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface OpenCodeV2EmbeddedSelection {
  directory: string;
  manifestSha256: string;
  version: '2.1.4';
  platform: string;
  arch: string;
}

export interface VerifiedOpenCodeV2EmbeddedGraph {
  modulePath: string;
  effectPath: string;
  requiredBunVersion: string;
  windowsJobBinding?: Readonly<{ path: string; sha256: string }>;
  /** Available only inside the actual Bun executor, after the complete delivery check. */
  configurationModules?: Readonly<{
    providerPath: string;
    nativeRewritePath: string;
    resolvePackage(specifier: string): Promise<string>;
  }>;
}

const manifestName = 'opencode-v2-engine-manifest.json';
const digestPattern = /^[a-f0-9]{64}$/;
const hold = (): never => {
  throw new Error('OpenCode V2 embedded graph unavailable');
};
type FileEntry = { path: string; bytes: number; sha256: string; executable: boolean };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return hold();
  return value as Record<string, unknown>;
};

/** Read only the regular file measured before and after the read, never a symlink. */
async function pinnedFile(file: string, expected: string, limit: number): Promise<Buffer> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit))
    return hold();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) return hold();
    const bytes = await handle.readFile();
    const after = await lstat(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.length) !== before.size ||
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      return hold();
    return bytes;
  } finally {
    await handle.close();
  }
}

/** A cheap launch-binding recheck; full graph verification still runs before importing it. */
export async function verifyOpenCodeV2EmbeddedManifest(
  selection: OpenCodeV2EmbeddedSelection
): Promise<void> {
  if (
    !digestPattern.test(selection.manifestSha256) ||
    (await realpath(selection.directory)) !== selection.directory
  )
    return hold();
  await pinnedFile(
    path.join(selection.directory, manifestName),
    selection.manifestSha256,
    16 * 1024 * 1024
  );
}

/** Verify the entire immutable delivery and resolve Effect from the selected server itself. */
export async function verifyOpenCodeV2EmbeddedGraph(
  selection: OpenCodeV2EmbeddedSelection,
  signal?: AbortSignal
): Promise<VerifiedOpenCodeV2EmbeddedGraph> {
  signal?.throwIfAborted();
  if (
    selection.version !== '2.1.4' ||
    selection.platform !== process.platform ||
    selection.arch !== process.arch ||
    !path.isAbsolute(selection.directory) ||
    !digestPattern.test(selection.manifestSha256) ||
    (await realpath(selection.directory)) !== selection.directory
  )
    return hold();
  const manifestPath = path.join(selection.directory, manifestName);
  const manifest = record(
    JSON.parse(
      (await pinnedFile(manifestPath, selection.manifestSha256, 16 * 1024 * 1024)).toString('utf8')
    ) as unknown
  );
  // These exact executor versions belong to the app's pinned delivery tuples.
  // The selected manifest hash, not the user's CLI dist-tag, binds this choice.
  const requiredBunVersion =
    selection.platform === 'linux' && selection.arch === 'x64'
      ? '1.3.11'
      : selection.platform === 'darwin' && ['arm64', 'x64'].includes(selection.arch)
        ? '1.4.4'
        : selection.platform === 'win32' && ['arm64', 'x64'].includes(selection.arch)
          ? '1.4.3'
          : undefined;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== selection.platform ||
    manifest.arch !== selection.arch ||
    requiredBunVersion === undefined ||
    manifest.requiredBunVersion !== requiredBunVersion ||
    !Array.isArray(manifest.engineVersions) ||
    !manifest.engineVersions.includes(selection.version) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 100_000
  )
    return hold();
  const entries = new Map<string, FileEntry>();
  const directories = new Set<string>();
  let totalBytes = 0;
  for (const value of manifest.files) {
    const file = record(value);
    if (
      typeof file.path !== 'string' ||
      file.path.length > 8192 ||
      !file.path.startsWith('local-cli/') ||
      /[\\:\0]/.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > 64 * 1024 * 1024 ||
      typeof file.sha256 !== 'string' ||
      !digestPattern.test(file.sha256) ||
      typeof file.executable !== 'boolean' ||
      entries.has(file.path)
    )
      return hold();
    entries.set(file.path, file as FileEntry);
    totalBytes += Number(file.bytes);
    if (totalBytes > 2 * 1024 * 1024 * 1024) return hold();
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  let observed = 0;
  async function walk(relative: string): Promise<void> {
    signal?.throwIfAborted();
    for (const child of await readdir(path.join(selection.directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      if (child.isSymbolicLink()) return hold();
      if (child.isDirectory()) {
        if (!directories.has(name)) return hold();
        await walk(name);
      } else if (child.isFile()) {
        if (name !== manifestName && !entries.has(name)) return hold();
        if (name !== manifestName) observed++;
      } else return hold();
    }
  }
  await walk('');
  if (observed !== entries.size) return hold();
  const remaining = entries.values();
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      for (let next = remaining.next(); !next.done; next = remaining.next()) {
        signal?.throwIfAborted();
        const entry = next.value;
        const filename = path.join(selection.directory, entry.path);
        if ((await realpath(filename)) !== filename) return hold();
        const bytes = await pinnedFile(filename, entry.sha256, entry.bytes);
        const info = await lstat(filename);
        if (
          bytes.length !== entry.bytes ||
          (process.platform !== 'win32' && Boolean(info.mode & 0o111) !== entry.executable)
        )
          return hold();
      }
    })
  );
  signal?.throwIfAborted();

  const checkedEntry = async (entry: string): Promise<string> => {
    const canonical = await realpath(entry);
    const relative = path.relative(selection.directory, canonical).split(path.sep).join('/');
    if (canonical !== entry || !entries.has(relative)) return hold();
    return canonical;
  };
  const packageAt = async (
    entry: string,
    name: string,
    version?: string
  ): Promise<Record<string, unknown>> => {
    let directory = path.dirname(entry);
    for (let depth = 0; depth < 8; depth++, directory = path.dirname(directory)) {
      const file = path.join(directory, 'package.json');
      const relative = path.relative(selection.directory, file).split(path.sep).join('/');
      const selected = entries.get(relative);
      if (!selected) continue;
      const info = record(
        JSON.parse(
          (await pinnedFile(file, selected.sha256, selected.bytes)).toString('utf8')
        ) as unknown
      );
      if (info.name === undefined && info.version === undefined) continue;
      if (info.name !== name || (version !== undefined && info.version !== version)) return hold();
      return info;
    }
    return hold();
  };
  const modulePath = await checkedEntry(
    path.join(selection.directory, 'local-cli/node_modules/@opencode/server-v2.1.4/dist/process.js')
  );
  const server = await packageAt(modulePath, '@opencode/server', selection.version);
  const effectVersion = record(server.dependencies).effect;
  if (effectVersion !== '4.0.1') return hold();
  const bun = (
    globalThis as unknown as {
      Bun?: { resolveSync(specifier: string, from: string): string };
    }
  ).Bun;
  if (process.versions.bun && typeof bun?.resolveSync !== 'function') return hold();
  const resolveFrom = (entry: string, specifier: string) =>
    process.versions.bun
      ? bun!.resolveSync(specifier, path.dirname(entry))
      : createRequire(entry).resolve(specifier);
  const effectPath = await checkedEntry(resolveFrom(modulePath, 'effect'));
  await packageAt(effectPath, 'effect', effectVersion);
  const verifyDependency = async (
    from: string,
    name: string,
    subpath: string,
    version?: string
  ) => {
    const entry = await checkedEntry(resolveFrom(from, `${name}/${subpath}`));
    await packageAt(entry, name, version);
    if ((await checkedEntry(resolveFrom(entry, 'effect'))) !== effectPath) return hold();
    return entry;
  };
  // The Node parent verifies every delivered byte. Import-only package exports
  // are resolved by the actual Bun executor, immediately before its first import.
  let configurationModules: VerifiedOpenCodeV2EmbeddedGraph['configurationModules'];
  if (process.versions.bun) {
    for (const [name, subpath] of [
      ['core', 'bus'],
      ['protocol', 'groups/pty'],
      ['schema', 'installation-event'],
      ['util', 'effect/layer-node'],
      ['simulation', 'backend'],
    ] as const) {
      const entry = await verifyDependency(
        modulePath,
        `@opencode/${name}`,
        subpath,
        selection.version
      );
      if (name === 'core') {
        await verifyDependency(entry, '@opencode/ai', 'route/client', selection.version);
        await verifyDependency(entry, 'drizzle-orm', 'effect-core');
      }
    }
    await verifyDependency(modulePath, '@effect/platform-node', 'NodeHttpServer', effectVersion);
    await verifyDependency(modulePath, '@effect/platform-node-shared', 'NodeStream', effectVersion);
    const providerPath = await verifyDependency(modulePath, '@opencode/core', 'provider', selection.version);
    const nativeRewritePath = await verifyDependency(modulePath, '@opencode/core', 'aisdk-native', selection.version);
    configurationModules = Object.freeze({ providerPath, nativeRewritePath,
      async resolvePackage(specifier: string) {
        if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(specifier) ||
            specifier.split('/').some(part => part === '.' || part === '..')) return hold();
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        const entry = await checkedEntry(resolveFrom(providerPath, specifier));
        await packageAt(entry, packageName, packageName === '@opencode/ai' ? selection.version : undefined);
        return entry;
      },
    });
  }
  let windowsJobBinding: VerifiedOpenCodeV2EmbeddedGraph['windowsJobBinding'];
  if (selection.platform === 'win32') {
    const packageName = `@yuuang/ffi-rs-win32-${selection.arch}-msvc`;
    const relative = `local-cli/node_modules/${packageName}/ffi-rs.win32-${selection.arch}-msvc.node`;
    const selected = entries.get(relative);
    if (!selected) return hold();
    const bindingPath = await checkedEntry(path.join(selection.directory, relative));
    await packageAt(bindingPath, packageName, '1.3.7');
    windowsJobBinding = Object.freeze({ path: bindingPath, sha256: selected.sha256 });
  }
  await verifyOpenCodeV2EmbeddedManifest(selection);
  signal?.throwIfAborted();
  return { modulePath, effectPath, requiredBunVersion, ...(windowsJobBinding ? { windowsJobBinding } : {}),
    ...(configurationModules ? { configurationModules } : {}) };
}
