import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';

export type ChangeScope = 'full' | 'docs' | 'assets' | 'dmg' | 'source';
export type ChangeClassification = {
  scope: ChangeScope;
  paths: string[];
  base: string;
  head: string;
  reason: string;
};
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = '777genius/agent-teams-ai';
const image = /\.(png|jpe?g|webp|gif|ico|icns)$/i;
const displayFields = new Set([
  'background',
  'backgroundColor',
  'iconSize',
  'iconTextSize',
  'title',
  'window',
  'contents',
]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record(value)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
/** Display-only DMG edits may not change signing, targets, scripts or dependencies. */
export function isDmgDisplayOnly(before: string, after: string): boolean {
  try {
    const oldPackage = record(JSON.parse(before));
    const newPackage = record(JSON.parse(after));
    const oldBuild = record(oldPackage.build);
    const newBuild = record(newPackage.build);
    const oldDmg = record(oldBuild.dmg);
    const newDmg = record(newBuild.dmg);
    let changed = false;
    for (const key of new Set([...Object.keys(oldDmg), ...Object.keys(newDmg)])) {
      if (stable(oldDmg[key]) === stable(newDmg[key])) continue;
      changed = true;
      if (!displayFields.has(key)) return false;
      const value = newDmg[key];
      if (
        key === 'background' &&
        (typeof value !== 'string' || !/^resources\/dmg\/[A-Za-z0-9_.-]+\.png$/.test(value))
      )
        return false;
      if (key === 'window') {
        const window = record(value);
        if (
          Object.keys(window).some((field) => !['x', 'y', 'width', 'height'].includes(field)) ||
          Object.values(window).some(
            (number) =>
              typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 4096
          )
        )
          return false;
      }
      if (key === 'contents') {
        if (!Array.isArray(value) || value.length !== 2) return false;
        for (const item of value) {
          const content = record(item);
          if (
            Object.keys(content).some(
              (field) => !['x', 'y', 'type', 'path', 'name'].includes(field)
            )
          )
            return false;
          if (
            typeof content.x !== 'number' ||
            typeof content.y !== 'number' ||
            !Number.isFinite(content.x) ||
            !Number.isFinite(content.y) ||
            content.x < 0 ||
            content.y < 0 ||
            content.x > 4096 ||
            content.y > 4096
          )
            return false;
          if (content.type === 'link') {
            if (content.path !== '/Applications') return false;
          } else if (content.type !== 'file' || content.path !== undefined) return false;
          if (
            content.name !== undefined &&
            (typeof content.name !== 'string' || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(content.name))
          )
            return false;
        }
        if (value.filter((item) => record(item).type === 'link').length !== 1) return false;
      }
      if (
        ['iconSize', 'iconTextSize'].includes(key) &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 512)
      )
        return false;
      if (
        key === 'title' &&
        (typeof value !== 'string' || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(value))
      )
        return false;
      if (
        key === 'backgroundColor' &&
        (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(value))
      )
        return false;
    }
    delete oldBuild.dmg;
    delete newBuild.dmg;
    return changed && stable(oldPackage) === stable(newPackage);
  } catch {
    return false;
  }
}

export function classifyChanges(
  entries: { status: string; path: string }[],
  packageBefore?: string,
  packageAfter?: string
): { scope: ChangeScope; reason: string } {
  let scope: ChangeScope = 'docs';
  if (entries.length === 0) return { scope: 'full', reason: 'Empty diff' };
  for (const { status, path } of entries) {
    if (
      !['A', 'M', 'D'].includes(status) ||
      !/^[A-Za-z0-9_./-]+$/.test(path) ||
      path.split('/').some((part) => !part || part === '..' || part === '.')
    )
      return { scope: 'full', reason: 'Unsafe diff entry' };
    let current: ChangeScope;
    if (/^(docs\/.*\.md|README\.md|CHANGELOG\.md|CONTRIBUTING\.md)$/.test(path)) current = 'docs';
    else if (
      (path.startsWith('docs/') || path.startsWith('landing/assets/')) &&
      /\.(png|jpe?g|webp|gif)$/i.test(path) &&
      status !== 'D'
    )
      current = 'assets';
    else if (path.startsWith('resources/dmg/') && image.test(path) && status !== 'D')
      current = 'dmg';
    else if (
      path === 'package.json' &&
      status === 'M' &&
      packageBefore &&
      packageAfter &&
      isDmgDisplayOnly(packageBefore, packageAfter)
    )
      current = 'dmg';
    else if (/^src\/renderer\/components\/ui\/[A-Za-z0-9_-]+\.tsx$/.test(path) && status !== 'D')
      current = 'source';
    else return { scope: 'full', reason: `Full qualification for ${path}` };
    if (current !== 'docs') {
      if (scope !== 'docs' && scope !== current)
        return { scope: 'full', reason: 'Mixed change areas' };
      scope = current;
    }
  }
  return { scope, reason: `Verified ${scope} diff` };
}

/** Local git is authoritative; no paginated/truncated GitHub changed-files list. */
export function collectChangeScope(
  env: Record<string, string | undefined>,
  cwd = process.cwd()
): ChangeClassification {
  const fallback: ChangeClassification = {
    scope: 'full',
    paths: [],
    base: '',
    head: '',
    reason: 'Unproven event or git diff',
  };
  try {
    if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_EVENT_NAME !== 'pull_request')
      return fallback;
    const event = record(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')));
    const pr = record(event.pull_request);
    if (Array.isArray(pr.labels) && pr.labels.some((label) => record(label).name === 'ci:full'))
      return fallback;
    const base = record(pr.base);
    const head = record(pr.head);
    if (
      record(event.repository).full_name !== REPOSITORY ||
      record(base.repo).full_name !== REPOSITORY ||
      pr.state !== 'open' ||
      typeof pr.draft !== 'boolean' ||
      !Number.isSafeInteger(pr.number) ||
      Number(pr.number) <= 0 ||
      event.number !== pr.number ||
      !['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft'].includes(
        String(event.action)
      )
    )
      return fallback;
    if (
      typeof base.sha !== 'string' ||
      typeof head.sha !== 'string' ||
      !SHA.test(base.sha) ||
      !SHA.test(head.sha) ||
      !SHA.test(env.GITHUB_SHA ?? '')
    )
      return fallback;
    if (
      (event.action === 'ready_for_review' && pr.draft) ||
      (event.action === 'converted_to_draft' && !pr.draft)
    )
      return fallback;
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    if (git(['rev-parse', 'HEAD']).trim() !== env.GITHUB_SHA) return fallback;
    // Checkout must be the immutable PR merge commit with the event base/head parents.
    const parents = git(['show', '-s', '--format=%P', env.GITHUB_SHA!]).trim().split(' ');
    if (parents.length !== 2 || parents[0] !== base.sha || parents[1] !== head.sha) return fallback;
    const raw = git([
      'diff',
      '--name-status',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      `${base.sha}...${head.sha}`,
    ]);
    const tokens = raw.split('\0');
    if (tokens.pop() !== '' || tokens.length % 2 !== 0) return fallback;
    const entries = [];
    for (let i = 0; i < tokens.length; i += 2)
      entries.push({ status: tokens[i], path: tokens[i + 1] });
    // Explicit rename detection fails closed, including moves between safe areas.
    const renamed = git([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      `${base.sha}...${head.sha}`,
    ]);
    if (/(^|\0)[RC]\d+\0/.test(renamed)) return fallback;
    for (const entry of entries) {
      const mode = git([
        'ls-tree',
        '--format=%(objectmode)',
        entry.status === 'D' ? base.sha : head.sha,
        '--',
        entry.path,
      ]).trim();
      if (mode !== '100644' && mode !== '100755') return fallback;
      if (entry.status === 'M') {
        const previousMode = git([
          'ls-tree',
          '--format=%(objectmode)',
          base.sha,
          '--',
          entry.path,
        ]).trim();
        if (previousMode !== mode) return fallback;
      }
    }
    let before: string | undefined;
    let after: string | undefined;
    if (entries.some((entry) => entry.path === 'package.json')) {
      before = git(['show', `${base.sha}:package.json`]);
      after = git(['show', `${head.sha}:package.json`]);
    }
    const result = classifyChanges(entries, before, after);
    return { ...result, paths: entries.map((entry) => entry.path), base: base.sha, head: head.sha };
  } catch {
    return fallback;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = collectChangeScope(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
  console.log(result.reason);
}
