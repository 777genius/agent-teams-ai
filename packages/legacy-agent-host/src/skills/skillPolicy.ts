import { isAbsolute, join, posix } from 'node:path';

import { managementDigest } from '../management/identity.js';

/** Existing Skills import limits and managed-file policy, independent of SDK/Electron. */
export const SKILL_IMPORT_LIMITS = { files: 200, bytes: 10 * 1024 * 1024 } as const;
export const SKILL_NAMES = ['SKILL.md', 'Skill.md', 'skill.md'] as const;
export interface SkillBytes {
  relativePath: string;
  base64: string;
  isBinary: boolean;
}
export interface SkillImportBundle {
  binding: string;
  digest: string;
  files: SkillBytes[];
  hiddenEntriesSkipped: number;
}
export interface SkillReviewFileChange {
  relativePath: string;
  absolutePath: string;
  action: 'create' | 'update' | 'delete';
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
}
export interface SkillReviewPreview {
  planId: string;
  targetSkillDir: string;
  changes: SkillReviewFileChange[];
  warnings: string[];
  summary: { created: number; updated: number; deleted: number; binary: number };
}
export const skillDigest = managementDigest;
export function assertSkillTransportBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    throw new Error(
      'Skill preview/import exceeds the encoded 32 MiB transport budget. No files were changed.'
    );
}
export function skillRelativePath(value: string): string {
  if (
    !value ||
    value.length > 8192 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/u.test(part)) ||
    posix.normalize(value) !== value
  )
    throw new Error('Invalid relative skill path');
  return value;
}
export function skillFolder(value: string): string {
  skillRelativePath(value);
  if (value.includes('/') || value.length > 255) throw new Error('Invalid folder name');
  return value;
}
export function skillBytes(file: SkillBytes): Buffer {
  skillRelativePath(file.relativePath);
  const bytes = Buffer.from(file.base64, 'base64');
  if (bytes.toString('base64') !== file.base64) throw new Error('Invalid skill bytes');
  return bytes;
}
export function validateSkillBundle(bundle: SkillImportBundle): void {
  if (
    !/^[a-f0-9]{64}$/u.test(bundle.binding) ||
    !/^[a-f0-9]{64}$/u.test(bundle.digest) ||
    !Number.isSafeInteger(bundle.hiddenEntriesSkipped) ||
    bundle.hiddenEntriesSkipped < 0 ||
    bundle.files.length > SKILL_IMPORT_LIMITS.files ||
    new Set(bundle.files.map((file) => file.relativePath)).size !== bundle.files.length ||
    !SKILL_NAMES.some((name) => bundle.files.some((file) => file.relativePath === name)) ||
    bundle.files.reduce((size, file) => size + skillBytes(file).length, 0) >
      SKILL_IMPORT_LIMITS.bytes ||
    skillDigest({ files: bundle.files, hiddenEntriesSkipped: bundle.hiddenEntriesSkipped }) !==
      bundle.digest
  )
    throw new Error('Original skill import bundle changed');
}
const text = (file: SkillBytes | undefined): string | null =>
  !file || file.isBinary ? null : Buffer.from(file.base64, 'base64').toString('utf8');
const managed = (name: string): boolean =>
  SKILL_NAMES.includes(name as (typeof SKILL_NAMES)[number]) ||
  ['scripts/', 'references/', 'assets/'].some((prefix) => name.startsWith(prefix));

/** Same create/update/delete semantics as SkillPlanService; hashes include every binary byte. */
export function planSkillFiles(options: {
  targetSkillDir: string;
  targetIdentity: string;
  current: readonly SkillBytes[];
  desired: readonly SkillBytes[];
  mode: 'upsert' | 'import';
  sourceBinding?: string;
  hiddenEntriesSkipped?: number;
}): { preview: SkillReviewPreview; files: SkillBytes[] } {
  const current = new Map(options.current.map((file) => [file.relativePath, file]));
  const desired = new Map(
    options.desired.map((file) => [skillRelativePath(file.relativePath), file])
  );
  if (desired.size !== options.desired.length) throw new Error('Duplicate skill file');
  if (!SKILL_NAMES.some((name) => desired.has(name))) throw new Error('Missing valid skill file');
  const changes: SkillReviewFileChange[] = [];
  for (const [name, file] of desired) {
    skillBytes(file);
    changes.push({
      relativePath: name,
      absolutePath: join(options.targetSkillDir, name),
      action: current.has(name) ? 'update' : 'create',
      oldContent: text(current.get(name)),
      newContent: text(file),
      isBinary: file.isBinary,
    });
  }
  // The original policy owns only the first detected SKILL file and three managed folders.
  const detected = SKILL_NAMES.find((name) => current.has(name));
  for (const [name, file] of current)
    if (
      !desired.has(name) &&
      managed(name) &&
      (!SKILL_NAMES.includes(name as (typeof SKILL_NAMES)[number]) || name === detected)
    )
      changes.push({
        relativePath: name,
        absolutePath: join(options.targetSkillDir, name),
        action: 'delete',
        oldContent: text(file),
        newContent: null,
        isBinary: file.isBinary,
      });
  changes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const summary = { created: 0, updated: 0, deleted: 0, binary: 0 };
  for (const change of changes) {
    summary[`${change.action}d`]++;
    if (change.isBinary) summary.binary++;
  }
  const warnings: string[] = [];
  if (options.hiddenEntriesSkipped)
    warnings.push('Hidden files and folders were skipped during import.');
  if (summary.deleted)
    warnings.push(
      summary.deleted === 1
        ? '1 managed file will be removed to match this reviewed plan.'
        : `${summary.deleted} managed files will be removed to match this reviewed plan.`
    );
  if (summary.updated)
    warnings.push(
      summary.updated === 1
        ? '1 existing file will be overwritten.'
        : `${summary.updated} existing files will be overwritten.`
    );
  if (summary.binary)
    warnings.push(
      summary.binary === 1
        ? '1 binary file will be copied as-is.'
        : `${summary.binary} binary files will be copied as-is.`
    );
  if (
    options.mode === 'import' &&
    options.desired.some((file) => file.relativePath.startsWith('scripts/'))
  )
    warnings.push('This import includes scripts. Review them carefully before importing.');
  if (
    options.current.some((file) => !managed(file.relativePath) && !desired.has(file.relativePath))
  )
    warnings.push(
      options.mode === 'import'
        ? 'Existing files outside the imported plan will be kept as-is.'
        : 'Existing files outside the managed skill set will be kept as-is.'
    );
  const files = new Map(current);
  for (const change of changes) if (change.action === 'delete') files.delete(change.relativePath);
  for (const [name, file] of desired) files.set(name, file);
  const preview = {
    targetSkillDir: options.targetSkillDir,
    changes,
    warnings,
    summary,
    planId: skillDigest({ ...options, changes, warnings }),
  };
  return {
    preview,
    files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}
