import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { importCategories, snapshotHeaderSchema } from './contracts.js';
import { collectImportReferences } from './references.js';
import type {
  ImportCategory,
  SnapshotFile,
  SnapshotHeader,
  StoppedTeamSnapshot,
  StoppedTeamSource,
} from './contracts.js';

export const STOPPED_IMPORT_LIMITS = {
  files: 4096,
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
} as const;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hold = (): never => {
  throw new TeamOwnerError('hold');
};
export function safeImportPath(value: string): string {
  if (
    !value ||
    value.length > 8192 ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return hold();
  return value;
}
export function plainImportAncestors(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) hold();
  let part = parse(path).root;
  for (const name of path.slice(part.length).split('/').filter(Boolean)) {
    part = join(part, name);
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) hold();
  }
}
function boundedFd(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length !== size) return hold();
  return buffer.subarray(0, length);
}
export function readImportBytes(path: string, limit: number): Buffer {
  plainImportAncestors(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    return hold();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      return hold();
    const bytes = boundedFd(fd, opened.size),
      after = fstatSync(fd);
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      return hold();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function disposition(category: ImportCategory, path: string): SnapshotFile['disposition'] {
  const name = path.split('/').at(-1)!;
  if (
    /(^|\/)(auth\.json|credentials?[^/]*|\.env[^/]*|checkpoints?[^/]*|runtime-checkpoints)(\/|$)/i.test(
      path
    )
  )
    return 'excluded';
  if (category === 'history' || category === 'evidence') return 'archive';
  if (category === 'attachments' || category === 'task-attachments') return 'product';
  if (category === 'tasks') {
    if (path.startsWith('_internal/')) return 'archive';
    if (!path.includes('/') && name.endsWith('.json')) return 'product';
    return hold();
  }
  if (path.startsWith('.host-owner/')) return hold();
  if (
    /^(launch-|bootstrap-|stop-|runtime-|opencode-|\.opencode-runtime\/|\.member-work-sync\/)/.test(
      path
    ) ||
    /\.(sh|exe|bin|lock)$/.test(name)
  )
    return 'excluded';
  if (
    [
      'config.json',
      'team.meta.json',
      'members.meta.json',
      'kanban-state.json',
      'sentMessages.json',
      'sent-cross-team.json',
    ].includes(path)
  )
    return path === 'kanban-state.json' ? 'product' : 'archive';
  if (/^inboxes\/[^/]+\.json$/.test(path)) return 'archive';
  if (
    /^(review-decisions|members|archive)\//.test(path) ||
    path === 'comment-notification-journal.json'
  )
    return 'archive';
  return hold(); // Unknown files are censused as refusal, never silently omitted.
}
function json(file: SnapshotFile): unknown[] {
  if (file.base64 === undefined || !/\.jsonl?$/.test(file.path)) return [];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(file.base64, 'base64')
    );
    return file.path.endsWith('.jsonl')
      ? text
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown)
      : [JSON.parse(text) as unknown];
  } catch {
    return hold();
  }
}
export function snapshotJson(file: SnapshotFile): unknown {
  const values = json(file);
  if (values.length !== 1) return hold();
  return values[0];
}
function captureFiles(source: StoppedTeamSource): {
  roots: StoppedTeamSnapshot['roots'];
  files: SnapshotFile[];
  identities: unknown[];
} {
  let total = 0,
    entries = 0;
  const files: SnapshotFile[] = [],
    identities: unknown[] = [],
    roots: StoppedTeamSnapshot['roots'] = [];
  for (const root of source.roots) {
    let stat;
    try {
      plainImportAncestors(root.path);
      stat = lstatSync(root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      roots.push({
        category: root.category,
        exists: false,
        identity: digest({ absent: root.path }),
      });
      continue;
    }
    roots.push({
      category: root.category,
      exists: true,
      identity: digest({ dev: stat.dev, ino: stat.ino }),
    });
    const visit = (directory: string): void => {
      if (++entries > STOPPED_IMPORT_LIMITS.files * 2) hold();
      const before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) hold();
      const names = readdirSync(directory).sort();
      identities.push([
        root.category,
        relative(root.path, directory),
        before.dev,
        before.ino,
        before.mtimeMs,
        names,
      ]);
      for (const name of names) {
        if (++entries > STOPPED_IMPORT_LIMITS.files * 2) hold();
        const path = join(directory, name),
          info = lstatSync(path);
        if (info.isSymbolicLink()) hold();
        if (info.isDirectory()) {
          visit(path);
          continue;
        }
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > STOPPED_IMPORT_LIMITS.fileBytes ||
          files.length >= STOPPED_IMPORT_LIMITS.files
        )
          hold();
        const relativePath = safeImportPath(relative(root.path, path)),
          selected = disposition(root.category, relativePath);
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
            hold();
          const bytes = boundedFd(fd, opened.size),
            after = fstatSync(fd);
          if (
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            bytes.byteLength !== opened.size
          )
            hold();
          total += bytes.length;
          if (total > STOPPED_IMPORT_LIMITS.totalBytes) hold();
          identities.push([
            root.category,
            relativePath,
            opened.dev,
            opened.ino,
            after.ctimeMs,
            sha(bytes),
          ]);
          files.push({
            category: root.category,
            path: relativePath,
            sha256: sha(bytes),
            size: bytes.length,
            disposition: selected,
            ...(selected === 'excluded' ? {} : { base64: bytes.toString('base64') }),
          });
        } finally {
          closeSync(fd);
        }
      }
      const after = lstatSync(directory);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs)
        hold();
    };
    visit(root.path);
  }
  return { roots, files, identities };
}
function validateProduct(
  snapshot: Omit<StoppedTeamSnapshot, 'digest' | 'references' | 'blobs'>,
  source: Pick<StoppedTeamSource, 'roots'>
) {
  const tasks = new Set<string>(),
    bodies: unknown[] = [],
    taskBodies: Record<string, unknown>[] = [];
  for (const file of snapshot.files) {
    const parsed = json(file);
    bodies.push(...parsed);
    if (file.category === 'tasks' && file.disposition === 'product') {
      const task = parsed[0] as Record<string, unknown>;
      if (
        parsed.length !== 1 ||
        !task ||
        typeof task !== 'object' ||
        Array.isArray(task) ||
        typeof task.id !== 'string' ||
        !task.id ||
        file.path !== `${task.id}.json` ||
        tasks.has(task.id)
      )
        hold();
      if (
        typeof task.status !== 'string' ||
        !['pending', 'in_progress', 'completed', 'deleted'].includes(task.status.trim()) ||
        typeof task.subject !== 'string'
      )
        hold();
      if (
        task.comments !== undefined &&
        (!Array.isArray(task.comments) ||
          task.comments.some(
            (item) =>
              !item ||
              typeof item !== 'object' ||
              typeof (item as Record<string, unknown>).id !== 'string' ||
              typeof (item as Record<string, unknown>).text !== 'string'
          ))
      )
        hold();
      tasks.add(task.id as string);
      taskBodies.push(task);
    }
  }
  for (const task of taskBodies)
    for (const key of ['blockedBy', 'blocks', 'related']) {
      const values = task[key];
      if (
        values !== undefined &&
        (!Array.isArray(values) || values.some((id) => typeof id !== 'string' || !tasks.has(id)))
      )
        hold();
    }
  const blobs = new Map<string, StoppedTeamSnapshot['blobs'][number]>();
  const attachments = snapshot.files.filter(
    (file) =>
      file.disposition !== 'excluded' &&
      (file.category === 'attachments' || file.category === 'task-attachments')
  );
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 64) hold();
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id === 'string' &&
      typeof row.filename === 'string' &&
      typeof row.mimeType === 'string'
    ) {
      if (typeof row.filePath === 'string') {
        if (!isAbsolute(row.filePath) || resolve(row.filePath) !== row.filePath) hold();
        const selected = source.roots
          .filter((root) => root.category === 'attachments' || root.category === 'task-attachments')
          .flatMap((root) => {
            const path = relative(root.path, row.filePath as string);
            return attachments.filter(
              (file) => file.category === root.category && file.path === path
            );
          });
        if (selected.length !== 1) hold();
        const file = selected[0]!;
        blobs.set(row.filePath, {
          originalPath: row.filePath,
          category: file.category as 'attachments' | 'task-attachments',
          path: file.path,
        });
      } else if (
        typeof row.data !== 'string' &&
        typeof row.base64Data !== 'string' &&
        !attachments.some((file) => file.path.split('/').at(-1)?.startsWith(`${row.id}--`)) &&
        !snapshot.header.gaps.some(
          (gap) => gap.resourceId === `attachment:${row.id}` && gap.reason === 'metadata-only'
        )
      )
        hold();
    }
    Object.values(row).forEach((child) => visit(child, depth + 1));
  };
  bodies.forEach((body) => visit(body));
  return {
    references: collectImportReferences(bodies, snapshot.header.sourceTeamName, tasks),
    blobs: [...blobs.values()],
  };
}

function hasSourceConfiguration(header: SnapshotHeader, files: readonly SnapshotFile[]): boolean {
  const has = (name: string) =>
    files.some((file) => file.category === 'team' && file.path === name);
  return header.sourceKind === 'saved-draft'
    ? !has('config.json') && has('team.meta.json') && has('members.meta.json')
    : has('config.json');
}

/** No source writes/repair/cleanup; native and operation closure come only from the trusted source port. */
export async function exportStoppedTeam(source: StoppedTeamSource): Promise<StoppedTeamSnapshot> {
  try {
    return await source.fenced(async () => {
      if (
        source.roots.length !== importCategories.length ||
        importCategories.some(
          (category) => source.roots.filter((root) => root.category === category).length !== 1
        )
      )
        hold();
      const header = snapshotHeaderSchema.parse(await source.describe());
      if (
        header.members.filter((row) => row.role === 'lead').length !== 1 ||
        new Set(header.members.map((row) => row.memberId)).size !== header.members.length ||
        new Set(header.members.map((row) => row.name.toLowerCase())).size !==
          header.members.length ||
        header.members.some((row) => row.name.toLowerCase() === 'user')
      )
        hold();
      const first = captureFiles(source);
      if (
        !hasSourceConfiguration(header, first.files) ||
        !first.roots.find((root) => root.category === 'tasks')?.exists
      )
        hold();
      for (const root of first.roots)
        if (
          !root.exists &&
          !header.gaps.some(
            (gap) =>
              gap.category === root.category &&
              gap.resourceId === 'root' &&
              gap.reason === 'already-missing'
          )
        )
          hold();
      const body = {
        schemaVersion: 1 as const,
        header,
        roots: first.roots,
        files: first.files,
      };
      const product = validateProduct(body, source);
      const after = snapshotHeaderSchema.parse(await source.describe()),
        second = captureFiles(source);
      if (digest(header) !== digest(after) || digest(first) !== digest(second)) hold();
      const complete = { ...body, ...product };
      return { ...complete, digest: digest(complete) };
    });
  } catch (error) {
    if (error instanceof TeamOwnerError) throw error;
    return hold();
  }
}

/** Host rechecks every detached byte rather than trusting a caller's snapshot hash. */
function validateDetachedSnapshot(raw: StoppedTeamSnapshot): StoppedTeamSnapshot {
  const { digest: expected, ...body } = raw;
  if (
    raw.schemaVersion !== 1 ||
    digest(body) !== expected ||
    raw.files.length > STOPPED_IMPORT_LIMITS.files
  )
    hold();
  if (digest(snapshotHeaderSchema.parse(raw.header)) !== digest(raw.header)) hold();
  if (
    raw.header.members.filter((row) => row.role === 'lead').length !== 1 ||
    new Set(raw.header.members.map((row) => row.memberId)).size !== raw.header.members.length ||
    new Set(raw.header.members.map((row) => row.name.toLowerCase())).size !==
      raw.header.members.length ||
    raw.header.members.some((row) => row.name.toLowerCase() === 'user')
  )
    hold();
  if (
    raw.roots.length !== importCategories.length ||
    importCategories.some(
      (category) => raw.roots.filter((root) => root.category === category).length !== 1
    ) ||
    raw.roots.some(
      (root) => typeof root.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(root.identity)
    )
  )
    hold();
  if (
    !raw.roots.find((root) => root.category === 'team')?.exists ||
    !raw.roots.find((root) => root.category === 'tasks')?.exists ||
    !hasSourceConfiguration(raw.header, raw.files)
  )
    hold();
  for (const root of raw.roots)
    if (
      !root.exists &&
      !raw.header.gaps.some(
        (gap) =>
          gap.category === root.category &&
          gap.resourceId === 'root' &&
          gap.reason === 'already-missing'
      )
    )
      hold();
  let total = 0;
  const seen = new Set<string>();
  for (const file of raw.files) {
    safeImportPath(file.path);
    const key = `${file.category}/${file.path}`;
    if (
      !importCategories.includes(file.category) ||
      !raw.roots.find((root) => root.category === file.category)?.exists ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(key) ||
      file.disposition !== disposition(file.category, file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > STOPPED_IMPORT_LIMITS.fileBytes
    )
      hold();
    seen.add(key);
    total += file.size;
    if (total > STOPPED_IMPORT_LIMITS.totalBytes) hold();
    if (file.disposition === 'excluded') {
      if (file.base64 !== undefined) hold();
    } else if (
      typeof file.base64 !== 'string' ||
      file.base64.length !== Math.ceil(file.size / 3) * 4 ||
      Buffer.from(file.base64, 'base64').toString('base64') !== file.base64 ||
      Buffer.from(file.base64, 'base64').length !== file.size ||
      sha(Buffer.from(file.base64, 'base64')) !== file.sha256
    )
      hold();
    json(file);
  }
  const roots = importCategories.map((category) => {
    const mappings = raw.blobs.filter((blob) => blob.category === category);
    const inferred = mappings.map((blob) => {
      safeImportPath(blob.path);
      if (
        !isAbsolute(blob.originalPath) ||
        resolve(blob.originalPath) !== blob.originalPath ||
        !blob.originalPath.endsWith(`/${blob.path}`)
      )
        return hold();
      return blob.originalPath.slice(0, -blob.path.length - 1);
    });
    if (new Set(inferred).size > 1) hold();
    return { category, path: inferred[0] ?? `/__host_import_without_source_reads__/${category}` };
  });
  const product = validateProduct(raw, { roots });
  if (
    digest(product.references) !== digest(raw.references) ||
    digest(product.blobs) !== digest(raw.blobs)
  )
    hold();
  return structuredClone(raw);
}

export function validateStoppedSnapshot(raw: StoppedTeamSnapshot): StoppedTeamSnapshot {
  try {
    return validateDetachedSnapshot(raw);
  } catch {
    return hold();
  }
}
