import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  promises as fs,
  readSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { BigIntStats } from 'node:fs';

type FileIdentity = Readonly<
  Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mode' | 'uid' | 'mtimeNs' | 'ctimeNs'>
>;

function identity(info: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    uid: info.uid,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  });
}

function same(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function held(): never {
  throw new Error('The original Codex executable or installation changed during verification.');
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export interface CapturedCodexManagedManifest {
  readonly fingerprint: string;
  readonly binaryPath: string | null;
  assertCurrent(): void;
  matches(content: string): boolean;
}
const managedCaptures = new WeakSet<CapturedCodexManagedManifest>();

/** This private known manifest path comes from the original Main installer, never IPC input. */
export function captureCodexManagedManifest(manifestPath: string): CapturedCodexManagedManifest {
  const read = () => {
    let descriptor: number;
    try {
      descriptor = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > 64n * 1024n) held();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const after = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(manifestPath, { bigint: true });
      if (
        length !== Number(before.size) ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        !same(before, after) ||
        !same(after, named)
      )
        held();
      const content = bytes.subarray(0, length).toString('utf8');
      const value: unknown = JSON.parse(content);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('schemaVersion' in value) ||
        value.schemaVersion !== 1 ||
        !('binaryPath' in value) ||
        typeof value.binaryPath !== 'string' ||
        !path.isAbsolute(value.binaryPath) ||
        value.binaryPath.includes('\0') ||
        value.binaryPath.length > 8192 ||
        ['rootVersion', 'platformVersion', 'platformTarget', 'integrity', 'installedAt'].some(
          (key) => typeof Reflect.get(value, key) !== 'string'
        )
      )
        held();
      return { identity: identity(after), content, binaryPath: value.binaryPath };
    } finally {
      closeSync(descriptor);
    }
  };
  const original = read();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        manifestPath,
        content: original?.content ?? null,
        identity: original ? Object.values(original.identity).map(String) : null,
      })
    )
    .digest('hex');
  const captured = Object.freeze({
    fingerprint,
    binaryPath: original?.binaryPath ?? null,
    assertCurrent() {
      const current = read();
      if (
        original === null
          ? current !== null
          : current === null ||
            current.content !== original.content ||
            !same(current.identity, original.identity)
      )
        held();
    },
    matches(content: string) {
      this.assertCurrent();
      return original?.content === content;
    },
  });
  managedCaptures.add(captured);
  return captured;
}

export function assertCapturedCodexManagedManifest(value: CapturedCodexManagedManifest): void {
  if (!managedCaptures.has(value)) held();
  value.assertCurrent();
}

export interface CapturedCodexInvocation {
  readonly executable: Readonly<{ path: string; sha256: string }>;
  readonly invocationPath: string;
  readonly processPath: string;
  readonly indirect: boolean;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  assertCurrent(): Promise<void>;
}

/** Static identity only. The existing resolver owns the one original execCli version probe. */
export async function captureCodexNativeSelection(
  candidate: string,
  check: () => void,
  probe?: Readonly<{
    cwd: string;
    environment: Readonly<NodeJS.ProcessEnv>;
    pathPrefix: readonly string[];
    pathBase: readonly string[];
  }>
): Promise<CapturedCodexInvocation> {
  const witnesses: { path: string; selected: string; identity: FileIdentity }[] = [];
  const missing = new Set<string>();
  const links: { path: string; canonical: string | null }[] = [];
  const checked = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    try {
      return await work();
    } finally {
      check();
    }
  };
  const inspect = async (selected: string, maximum: bigint, executable: boolean) => {
    const canonical = await checked(() => fs.realpath(selected));
    check();
    const file = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      check();
      const before = await checked(() => file.stat({ bigint: true }));
      if (
        !before.isFile() ||
        before.size < 1n ||
        before.size > maximum ||
        (executable && process.platform !== 'win32' && (before.mode & 0o111n) === 0n)
      )
        held();
      const digest = createHash('sha256');
      const chunks: Buffer[] = [];
      let length = 0;
      let script = false;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        check();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (length === 0) script = bytes[0] === 35 && bytes[1] === 33;
        length += bytes.length;
        if (BigInt(length) > before.size) held();
        digest.update(bytes);
        if (!executable) chunks.push(bytes);
        check();
      }
      const after = await checked(() => file.stat({ bigint: true }));
      const named = await checked(() => fs.lstat(canonical, { bigint: true }));
      if (
        BigInt(length) !== before.size ||
        !same(before, after) ||
        !same(after, named) ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        (await checked(() => fs.realpath(selected))) !== canonical
      )
        held();
      witnesses.push({ path: canonical, selected, identity: identity(after) });
      return {
        path: canonical,
        sha256: digest.digest('hex'),
        identity: identity(after),
        script,
        text: executable ? '' : Buffer.concat(chunks, length).toString('utf8'),
      };
    } finally {
      try {
        await file.close();
      } finally {
        check();
      }
    }
  };
  const exists = async (selected: string) => {
    try {
      await checked(() => fs.lstat(selected));
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      )
        throw error;
      missing.add(selected);
      return false;
    }
  };
  const environmentFor = (canonical: string) => {
    const delimiter = process.platform === 'win32' ? ';' : ':';
    // Original buildEnrichedEnv: managed Git → lexical/canonical launcher → original merged PATH.
    const directories = [
      ...(probe?.pathPrefix ?? []),
      path.dirname(candidate),
      path.dirname(canonical),
      ...(probe?.pathBase ?? []),
    ];
    return Object.freeze({
      ...probe?.environment,
      PATH: [...new Set(directories.filter(Boolean))].join(delimiter),
    });
  };
  const realLink = async (selected: string): Promise<string | null> => {
    try {
      return await checked(() => fs.realpath(selected));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      )
        throw error;
      return null;
    }
  };
  const originalLink = async (selected: string) => {
    const canonical = await realLink(selected);
    links.push({ path: selected, canonical });
    return canonical;
  };
  const capturePackageManager = async (root: string, script: string) => {
    const owned = async (directory: string) => {
      if (path.basename(directory) === 'packages') {
        const metadata = path.join(directory, '@openai', 'codex.json');
        if (await exists(metadata)) {
          const file = await inspect(metadata, 64n * 1024n, false);
          const value: unknown = JSON.parse(file.text);
          if (!value || typeof value !== 'object' || Array.isArray(value)) held();
          if ('name' in value && value.name === '@openai/codex') {
            const id = 'installId' in value ? value.installId || '' : '';
            if (typeof id !== 'string') held();
            const installation = id.startsWith('#')
              ? path.join(directory, '@openai/codex' + id)
              : path.join(directory, '@openai/codex', id);
            for (const modules of [
              path.join(installation, 'lib/node_modules'),
              path.join(installation, 'node_modules'),
            ])
              if ((await originalLink(path.join(modules, '@openai/codex'))) === root) return true;
          }
        }
      }
      const modules = path.join(directory, 'node_modules');
      const metadata = path.join(modules, '.modules.yaml');
      if (await exists(metadata)) {
        await inspect(metadata, 64n * 1024n, false);
        if ((await originalLink(path.join(modules, '@openai/codex'))) === root) return true;
      }
      return false;
    };
    // Preserve the wrapper's first ownership match. Its fallback uses only the frozen probe env.
    for (const start of new Set([root, path.dirname(path.resolve(script))])) {
      let directory = start;
      for (let depth = 0; depth < 128; depth += 1) {
        if (await owned(directory)) return;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        if (depth === 127) held();
        directory = parent;
      }
    }
  };
  let selected = candidate,
    processPath = candidate,
    indirect = false;
  let environment: Readonly<NodeJS.ProcessEnv> | undefined;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
    const shim = await inspect(candidate, 64n * 1024n, false);
    environment = environmentFor(shim.path);
    const launcherDirectory = path.dirname(candidate);
    const prefix = launcherDirectory.endsWith(path.sep)
      ? launcherDirectory
      : launcherDirectory + path.sep;
    const expand = (value: string) =>
      path.resolve(
        value
          .replace(/%SCRIPT_DIR%/gi, prefix)
          .replace(/%~dp0/gi, prefix)
          .replace(/%dp0%/gi, prefix)
          .replace(/\\/g, path.sep)
      );
    // Keep execCli's exact Bun → npm Node → native ordering; never reinterpret a Bun owner.
    if (/\bbun\s+"%TARGET%"\s+%\*/i.test(shim.text)) held();
    const nodeScript = /"%_prog%"\s+"([^"]+(?:\.(?:cjs|mjs|js))?)"\s+%\*/i.exec(shim.text)?.[1];
    if (nodeScript) {
      indirect = true;
      if (!probe) held();
      const options = Object.entries(environment).filter(
        ([name]) => name.toUpperCase() === 'NODE_OPTIONS'
      );
      // Loaders, conditions and symlink changes would replace the original static resolution.
      if (
        options.length > 1 ||
        !/^(?:\s*--(?:max-old-space-size|max-semi-space-size)=\d+\s*)*$/.test(options[0]?.[1] ?? '')
      )
        held();
      const script = await inspect(expand(nodeScript), 64n * 1024n, false);
      // Exact official openai/codex tagged wrapper bytes; installed bytes must match, not its name.
      // rust-v0.162.0 934600714b97f340cb5468e20e5fe560d751cbed; rust-v0.169.0 132509521e6cddf3854ec902fa78cedd352c8e30.
      const version =
        script.sha256 === '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70'
          ? '0.162.0'
          : script.sha256 === 'e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af'
            ? '0.169.0'
            : null;
      if (!version) held();
      const root = path.dirname(path.dirname(script.path));
      if (path.join(root, 'bin', 'codex.js') !== script.path) held();
      const manifest = await inspect(path.join(root, 'package.json'), 64n * 1024n, false);
      const metadata: unknown = JSON.parse(manifest.text);
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        !('name' in metadata) ||
        metadata.name !== '@openai/codex' ||
        !('type' in metadata) ||
        metadata.type !== 'module' ||
        !('version' in metadata) ||
        metadata.version !== version ||
        !('bin' in metadata) ||
        !metadata.bin ||
        typeof metadata.bin !== 'object' ||
        !('codex' in metadata.bin) ||
        metadata.bin.codex !== 'bin/codex.js'
      )
        held();
      const architecture =
        process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
      if (!architecture) held();
      const packageName = '@openai/codex-win32-' + process.arch;
      const requireFromScript = createRequire(script.path);
      let packagePath: string | undefined;
      let ancestor = path.dirname(script.path);
      for (let depth = 0; depth < 128; depth += 1) {
        // Node's local lookup precedes NODE_PATH/global fallbacks. Require that first local package.
        if (path.basename(ancestor) !== 'node_modules') {
          const directory = path.join(ancestor, 'node_modules', packageName);
          if (await exists(directory)) {
            const info = await inspect(path.join(directory, 'package.json'), 64n * 1024n, false);
            const value: unknown = JSON.parse(info.text);
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.hasOwn(value, 'exports')
            )
              held();
            check();
            const resolved = requireFromScript.resolve(packageName + '/package.json');
            check();
            if ((await checked(() => fs.realpath(resolved))) !== info.path) held();
            packagePath = path.dirname(info.path);
            break;
          }
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      // The native fallback vendor/global lookup needs a different closure; it is never guessed.
      if (!packagePath) held();
      selected = path.join(
        packagePath,
        'vendor',
        architecture + '-pc-windows-msvc',
        'bin',
        'codex.exe'
      );
      await capturePackageManager(root, expand(nodeScript));
      const localNode = path.join(launcherDirectory, 'node.exe');
      if (await exists(localNode)) {
        processPath = localNode;
        await inspect(localNode, 1024n ** 3n, true);
      } else {
        processPath = 'node';
        // NeedCurrentDirectoryForExePathW is process policy: absence makes either policy identical.
        for (const extension of ['com', 'exe'])
          if (await exists(path.join(probe.cwd, 'node.' + extension))) held();
        const entries = (environment.PATH ?? '').split(';').filter(Boolean);
        if (entries.length > 128) held();
        let interpreter: string | undefined;
        for (const entry of entries) {
          const directory = entry.replace(/^(["'])(.*)\1$/, '$2');
          if (!path.isAbsolute(directory) || /["']/.test(directory)) held();
          for (const extension of ['com', 'exe']) {
            const file = path.join(directory, 'node.' + extension);
            if (await exists(file)) {
              interpreter = file;
              break;
            }
          }
          if (interpreter) break;
        }
        if (!interpreter) held();
        await inspect(interpreter, 1024n ** 3n, true);
      }
    } else {
      const target = /(?:^|[&|])\s*"([^"]+\.(?:exe|com))"\s+%\*/im.exec(shim.text)?.[1];
      if (!target) held();
      selected = expand(target);
      processPath = selected;
    }
  }
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(selected))
    throw new Error('The selected Codex native executable cannot be established.');
  const native = await inspect(selected, 1024n ** 3n, true);
  indirect ||= native.script;
  environment ??= environmentFor(native.path);
  return Object.freeze({
    executable: Object.freeze({ path: native.path, sha256: native.sha256 }),
    invocationPath: candidate,
    processPath,
    indirect,
    environment,
    async assertCurrent() {
      for (const witness of witnesses) {
        const current = await checked(() => fs.lstat(witness.path, { bigint: true }));
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          !same(current, witness.identity) ||
          (await checked(() => fs.realpath(witness.selected))) !== witness.path
        )
          held();
      }
      for (const original of missing) if (await exists(original)) held();
      for (const original of links)
        if ((await realLink(original.path)) !== original.canonical) held();
    },
  });
}
