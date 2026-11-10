import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

interface PackageJson {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
export interface CandidatePackage {
  name: string;
  version: string;
  path: string;
  files: { path: string; sha256: string; executable: boolean }[];
  dependencies: Record<string, string>;
  missingOptional: string[];
}
export async function candidateDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
/** Node's actual installed resolution, including pnpm peer-specific instances. No sibling fallback. */
async function dependencyRoot(parent: string, name: string): Promise<string | null> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name))
    throw new Error('Invalid dependency name');
  const require = createRequire(join(parent, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    try {
      const root = await realpath(candidate);
      const manifest = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8')
      ) as PackageJson;
      if (manifest.name !== name) throw new Error('Installed package identity mismatch');
      return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}
async function copyPackage(source: string, destination: string, publishedRoots: string[] | null) {
  const files: CandidatePackage['files'] = [];
  async function walk(directory: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const original = join(directory, entry.name),
        copied = join(target, entry.name);
      const path = relative(source, original).split(sep).join('/');
      // Workspace Host/ledger/controller are compiled before this finite staging step.
      if (publishedRoots && !publishedRoots.includes(path.split('/')[0]!)) continue;
      if (entry.isSymbolicLink())
        throw new Error('Runtime package contains unsupported payload symlink');
      const actual = await realpath(original);
      if (!inside(source, actual)) throw new Error('Package contains an escaping file link');
      const stat = await lstat(actual);
      if (stat.isDirectory()) await walk(actual, copied);
      else if (stat.isFile()) {
        await copyFile(actual, copied);
        await chmod(copied, stat.mode & 0o777);
        files.push({
          path,
          sha256: await candidateDigest(copied),
          executable: (stat.mode & 0o111) !== 0,
        });
      } else throw new Error('Unsupported package entry');
    }
  }
  await walk(source, destination);
  return files;
}
/** Materialize only the Host's installed runtime dependency graph. All links stay relative inside output. */
export async function stageCandidateClosure(
  repository: string,
  destination: string
): Promise<CandidatePackage[]> {
  const repo = await realpath(repository),
    root = await realpath(join(repo, 'packages/legacy-agent-host'));
  const queued = [root],
    indices = new Map([[root, '0000']]);
  const packages: CandidatePackage[] = [];
  for (let index = 0; index < queued.length; index++) {
    if (index >= 512) throw new Error('Unexpected Host dependency graph size');
    const source = queued[index]!,
      key = indices.get(source)!;
    if (!inside(repo, source))
      throw new Error('Host dependency escapes installed repository closure');
    const manifest = JSON.parse(
      await readFile(join(source, 'package.json'), 'utf8')
    ) as PackageJson;
    if (!manifest.name || !manifest.version) throw new Error('Invalid runtime package');
    const folder = join(destination, 'packages', key);
    const files = await copyPackage(
      source,
      folder,
      source.includes(`${sep}node_modules${sep}`)
        ? null
        : [...(manifest.files ?? ['dist']), 'package.json', 'README.md', 'LICENSE']
    );
    const dependencies: Record<string, string> = {},
      missingOptional: string[] = [];
    const required = { ...manifest.peerDependencies, ...manifest.dependencies };
    const all = { ...required, ...manifest.optionalDependencies };
    for (const name of Object.keys(all).sort()) {
      const child = await dependencyRoot(source, name);
      if (!child) {
        if (
          manifest.optionalDependencies?.[name] ||
          manifest.peerDependenciesMeta?.[name]?.optional
        ) {
          missingOptional.push(name);
          continue;
        }
        throw new Error(`Missing installed dependency: ${manifest.name} -> ${name}`);
      }
      if (!indices.has(child)) {
        indices.set(child, String(queued.length).padStart(4, '0'));
        queued.push(child);
      }
      const childKey = indices.get(child)!;
      dependencies[name] = childKey;
      const link = join(folder, 'node_modules', name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), join(destination, 'packages', childKey)), link, 'dir');
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      path: `packages/${key}`,
      files,
      dependencies,
      missingOptional,
    });
  }
  return packages;
}
