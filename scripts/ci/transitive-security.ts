// Temporary source backports, with honest upstream versions and pinned provenance.
// Remove each patch and exception together after adopting a fixed upstream release.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
type BehaviorProbe = typeof import('./transitive-security-probe');
// Node's native stripping requires the .ts URL; the erased type import keeps
// this compatible with the application's existing bundler typecheck settings.
const { verifyBracesBehavior, verifyCacheBehavior } = (await import(
  new URL('./transitive-security-probe.ts', import.meta.url).href
)) as BehaviorProbe;

interface Backport {
  name: string;
  version: string;
  main: string;
  advisory: string;
  patch: string;
  files: { path: string; original: string; patched: string }[];
}
export const BACKPORTS = JSON.parse(
  readFileSync(new URL('./transitive-security-manifest.json', import.meta.url), 'utf8')
) as Backport[];
const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '../..');
const sha = (source: string | Buffer) => createHash('sha256').update(source).digest('hex');
const specFor = (name: string): Backport => {
  const spec = BACKPORTS.find((item) => item.name === name);
  if (!spec) throw new Error(`Unsupported security backport: ${name}`);
  return spec;
};
function assertMetadata(root: string, spec: Backport): void {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    metadata.name !== spec.name ||
    metadata.version !== spec.version ||
    metadata.main !== spec.main
  ) {
    throw new Error(`Unsupported ${spec.name} package at ${root}`);
  }
}

export function verifyBackport(name: string, root: string): void {
  const spec = specFor(name);
  assertMetadata(root, spec);
  for (const file of spec.files) {
    if (sha(readFileSync(join(root, file.path))) !== file.patched) {
      throw new Error(`Missing or unexpected ${name} security patch: ${file.path}`);
    }
  }
  // A fresh process proves the installed bytes instead of an already cached module.
  const probe = spawnSync(process.execPath, [script, '--probe', name, root], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `${name} regression verification failed: ${probe.error?.message ?? probe.stderr}`
    );
  }
}

// Apply only exact unified-diff hunks to known source bytes. No external patch binary
// is needed in the Windows/macOS npm postinstall path.
function applyHunks(source: string, patch: string): string {
  const lines = patch.split('\n');
  const sourceLines = source.split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[index]);
    if (!header) continue;
    const position = Number(header[1]) - 1 + offset;
    const before: string[] = [],
      after: string[] = [];
    for (index++; index < lines.length && /^[ +-]/.test(lines[index]); index++) {
      const line = lines[index];
      if (line[0] !== '+') before.push(line.slice(1));
      if (line[0] !== '-') after.push(line.slice(1));
    }
    index--;
    if (
      !before.length ||
      sourceLines.slice(position, position + before.length).join('\n') !== before.join('\n')
    ) {
      throw new Error('Security patch hunk does not match the pinned source');
    }
    sourceLines.splice(position, before.length, ...after);
    offset += after.length - before.length;
  }
  return sourceLines.join('\n');
}

export function applyBackport(name: string, root: string): boolean {
  const spec = specFor(name);
  assertMetadata(root, spec);
  const patch = readFileSync(join(repository, spec.patch), 'utf8');
  const updates: { target: string; source: string }[] = [];
  for (const file of spec.files) {
    const target = join(root, file.path);
    const source = readFileSync(target, 'utf8');
    if (sha(source) === file.patched) continue;
    if (sha(source) !== file.original) throw new Error(`Unexpected ${name} source: ${file.path}`);
    const section = patch
      .split('diff --git ')
      .find((part) => part.startsWith(`a/${file.path} b/${file.path}\n`));
    if (!section) throw new Error(`Missing security patch file: ${file.path}`);
    const updated = applyHunks(source, section);
    if (sha(updated) !== file.patched)
      throw new Error(`Security backport hash mismatch: ${file.path}`);
    updates.push({ target, source: updated });
  }
  // Preflight every file before making changes. An unknown version/source fails closed.
  for (const { target, source } of updates) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, source, { flag: 'wx', mode: statSync(target).mode & 0o777 });
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  verifyBackport(name, root);
  return updates.length > 0;
}

export function installedBackportPackages(
  name: string,
  cwd: string,
  { npm, nodes = [] }: { npm?: boolean; nodes?: string[] } = {}
): string[] {
  specFor(name);
  const userAgent = process.env.npm_config_user_agent ?? '';
  npm ??= userAgent.startsWith('npm/');
  let workspace = resolve(cwd);
  if (!npm) {
    while (!existsSync(join(workspace, 'pnpm-workspace.yaml'))) {
      const parent = dirname(workspace);
      if (parent === workspace) throw new Error(`Missing pnpm workspace: ${cwd}`);
      workspace = parent;
    }
  }
  const base = join(workspace, 'node_modules');
  const targets = new Set<string>();
  const add = (candidate: string, required = false) => {
    if (!existsSync(candidate)) {
      if (required) throw new Error(`Missing installed ${name}: ${candidate}`);
      return;
    }
    const target = realpathSync(candidate);
    if (!target.startsWith(realpathSync(base) + sep))
      throw new Error(`Installed ${name} escaped node_modules`);
    targets.add(target);
  };
  add(join(base, name));
  const store = join(base, npm ? '.store' : '.pnpm');
  if (existsSync(store))
    for (const entry of readdirSync(store)) {
      if (entry.startsWith(`${name}@`)) add(join(store, entry, 'node_modules', name), true);
    }
  if (npm) {
    const lock = JSON.parse(readFileSync(join(workspace, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    for (const path of [...Object.keys(lock.packages), ...nodes])
      if (path.endsWith(`node_modules/${name}`)) {
        if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
          throw new Error('Unsafe npm install path');
        add(join(workspace, path), true);
      }
  }
  return [...targets];
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === '--probe' && process.argv.length === 5) {
      const [, , , name, root] = process.argv;
      if (name === 'braces') verifyBracesBehavior(resolve(root));
      else if (name === 'http-cache-semantics') verifyCacheBehavior(resolve(root));
      else throw new Error(`Unsupported probe: ${name}`);
    } else {
      if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--apply'))
        throw new Error('Usage: transitive-security.ts [--apply]');
      for (const spec of BACKPORTS) {
        const targets = installedBackportPackages(spec.name, process.cwd());
        for (const target of targets)
          (process.argv[2] === '--apply' ? applyBackport : verifyBackport)(spec.name, target);
        console.log(`Verified ${spec.name} security backport in ${targets.length} package(s)`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
