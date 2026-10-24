import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from '../team/identity.js';
import { getGitWorkspacePaths, getGitStatusPathEntries } from './GitChangePathProvider.js';
import type { ClaudeCaptureValue } from '@agent-teams/provider-implementations/claude';
import type { EvidenceWorkspace } from './bindTaskToolEvidence.js';
import type { FileImage, WorkspaceSnapshot } from './captureContracts.js';
import { createHash } from 'node:crypto';

export const SNAPSHOT_LIMITS = Object.freeze({
  files: 80,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
});
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};
export async function validateEvidenceWorkspace(workspace: EvidenceWorkspace): Promise<void> {
  const info = await lstat(workspace.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(workspace.path)) !== workspace.path ||
    digest({ dev: info.dev, ino: info.ino }) !== workspace.identity
  )
    throw new Error('workspace-changed');
}
async function image(root: string, file: string): Promise<FileImage> {
  if (!inside(root, file)) return { reason: 'outside-workspace' };
  let cursor = root;
  const parts = relative(root, file).split(sep);
  try {
    for (const part of parts) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return { reason: 'symlink' };
      if (cursor !== file && !info.isDirectory()) return { reason: 'not-directory' };
      if (info.isDirectory()) {
        try { await lstat(join(cursor, '.git')); return { reason: 'nested-workspace' }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { reason: 'read-error' }; }
      }
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > SNAPSHOT_LIMITS.fileBytes)
        return { exists: true, reason: 'unsupported-file' };
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) return { exists: true, reason: 'external-change' };
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      const named = await lstat(file);
      if (
        bytes.length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.dev !== named.dev ||
        before.ino !== named.ino
      )
        return { exists: true, reason: 'external-change' };
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
        return { exists: true, sha256, reason: 'binary' };
      return { exists: true, sha256, content: bytes };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { exists: false }
      : { reason: 'read-error' };
  }
}
function directPaths(input: ClaudeCaptureValue): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const fields = input as Record<string, ClaudeCaptureValue>;
  return ['file_path', 'notebook_path'].flatMap((key) =>
    typeof fields[key] === 'string' ? [fields[key] as string] : []
  );
}
export async function snapshotWorkspace(options: {
  workspace: EvidenceWorkspace;
  toolName: string;
  input: ClaudeCaptureValue;
  prior?: WorkspaceSnapshot;
  guard(): void;
}): Promise<WorkspaceSnapshot> {
  options.guard();
  await validateEvidenceWorkspace(options.workspace);
  options.guard();
  const warnings: string[] = [];
  const root = options.workspace.path;
  const request = { gitRoot: root, timeoutMs: 1000, maxBytes: 1024 * 1024, maxPaths: SNAPSHOT_LIMITS.files };
  const census = await getGitWorkspacePaths(request);
  options.guard();
  const status = await getGitStatusPathEntries(request);
  options.guard();
  warnings.push(...census.warnings, ...status.warnings);
  const paths = new Set([...census.paths, ...status.paths].map((file) => resolve(root, file)));
  for (const file of directPaths(options.input)) paths.add(resolve(root, file));
  for (const file of options.prior?.files.keys() ?? []) paths.add(file);
  for (const file of paths) {
    if (!inside(root, file)) { warnings.push('outside-workspace'); paths.delete(file); }
    else if (relative(root, file).split(sep).some((part) =>
      part === '.git' || part === '.board-task-changes' || part === '.board-task-change-freshness')) {
      warnings.push('metadata-path'); paths.delete(file);
    }
  }
  if (options.input && typeof options.input === 'object' && !Array.isArray(options.input) &&
    (options.input as Record<string, ClaudeCaptureValue>).run_in_background === true)
    warnings.push('background-tool');
  const files = new Map<string, FileImage>();
  let bytes = 0;
  for (const file of [...paths].slice(0, SNAPSHOT_LIMITS.files)) {
    options.guard();
    const value = await image(options.workspace.path, file);
    options.guard();
    bytes += value.content?.length ?? 0;
    if (bytes > SNAPSHOT_LIMITS.totalBytes) {
      warnings.push('byte-cap');
      break;
    }
    files.set(file, value);
    if (value.reason) warnings.push(value.reason);
  }
  if (paths.size > SNAPSHOT_LIMITS.files) warnings.push('path-cap');
  await validateEvidenceWorkspace(options.workspace);
  options.guard();
  return { files, warnings: [...new Set(warnings)], complete: warnings.length === 0 };
}
