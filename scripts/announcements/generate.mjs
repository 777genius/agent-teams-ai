import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(`Announcements: ${message}`);
};
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function date(value, field) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    fail(`${field} must be an ISO timestamp with timezone`);
  const ms = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (
    !Number.isFinite(ms) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(value.slice(11, 13)) > 23
  )
    fail(`${field} is invalid`);
  return new Date(ms).toISOString();
}

export function normalizeMetadata(value, folder) {
  if (!plain(value) || !SLUG.test(value.id) || value.id !== folder) fail(`invalid id in ${folder}`);
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.trim().length > 200 ||
    /[<>]/.test(value.title)
  )
    fail(`${folder}: invalid title`);
  if (!['draft', 'published', 'archived', 'withdrawn'].includes(value.status))
    fail(`${folder}: invalid status`);
  const publishedAt = date(value.publishedAt, `${folder}.publishedAt`);
  const validUntil =
    value.validUntil === undefined
      ? new Date(Date.parse(publishedAt) + 14 * 86400000).toISOString()
      : date(value.validUntil, `${folder}.validUntil`);
  if (Date.parse(validUntil) <= Date.parse(publishedAt))
    fail(`${folder}: validUntil must follow publishedAt`);
  const showToNewUsers = value.showToNewUsers === undefined ? true : value.showToNewUsers;
  const minUsageMinutes = value.minUsageMinutes === undefined ? 30 : value.minUsageMinutes;
  if (typeof showToNewUsers !== 'boolean') fail(`${folder}: showToNewUsers must be boolean`);
  if (
    !Number.isSafeInteger(minUsageMinutes) ||
    minUsageMinutes < 0 ||
    !Number.isSafeInteger(minUsageMinutes * 60000)
  )
    fail(`${folder}: invalid minUsageMinutes`);
  const heroImage =
    value.heroImage === undefined
      ? undefined
      : localImagePath(value.heroImage, `${folder}.heroImage`);
  return {
    id: value.id,
    title: value.title.trim(),
    publishedAt,
    validUntil,
    status: value.status,
    showToNewUsers,
    minUsageMinutes,
    ...(heroImage ? { heroImage } : {}),
  };
}

async function safeStat(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink()) fail(`symlink forbidden: ${file}`);
  if (!(directory ? info.isDirectory() : info.isFile())) fail(`unexpected file type: ${file}`);
}

function portable(name) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    fail(`nonportable filename: ${name}`);
}

function localImagePath(value, field) {
  if (typeof value !== 'string' || !value.startsWith('assets/') || !IMAGE.test(value))
    fail(`${field} must name a local image under assets/`);
  const segments = value.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..'))
    fail(`${field} must name a local image under assets/`);
  for (const segment of segments) portable(segment);
  return value;
}

async function entries(dir) {
  await safeStat(dir, true);
  const names = (await readdir(dir)).sort(compare);
  const seen = new Set();
  for (const name of names) {
    portable(name);
    if (seen.has(name.toLowerCase())) fail(`case-colliding filename: ${name}`);
    seen.add(name.toLowerCase());
  }
  return names;
}

async function bytes(file, limit) {
  await safeStat(file);
  if ((await lstat(file)).size > limit) fail(`size limit exceeded: ${file}`);
  return readFile(file);
}

async function json(file) {
  try {
    return JSON.parse((await bytes(file, 512 * 1024)).toString('utf8'));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}

async function assets(dir, prefix = 'assets') {
  const result = new Map();
  for (const name of await entries(dir)) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) fail(`symlink forbidden: ${full}`);
    if (info.isDirectory()) {
      for (const [key, data] of await assets(full, `${prefix}/${name}`)) result.set(key, data);
    } else {
      if (!IMAGE.test(name)) fail(`unsupported image: ${full}`);
      result.set(`${prefix}/${name}`, await bytes(full, 5 * 1024 * 1024));
    }
  }
  return result;
}

function validateImages(body, files, id) {
  const references = new Map();
  for (const match of body.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm))
    references.set(match[1].trim().toLowerCase(), match[2]);
  const targets = [];
  for (const match of body.matchAll(
    /!\[([^\]]*)\](?:\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+['"][^\n]*?['"])?\s*\)|\[([^\]]*)\])?/g
  )) {
    const target =
      match[2] ?? match[3] ?? references.get((match[4] || match[1]).trim().toLowerCase());
    if (!target) fail(`${id}: unresolved image reference`);
    targets.push(target);
  }
  for (const target of targets) {
    if (
      !target.startsWith('assets/') ||
      target.includes('\\') ||
      target.split('/').some((part) => part === '..' || part === '.') ||
      !files.has(target)
    )
      fail(`${id}: image must name an existing local asset: ${target}`);
  }
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function validateImmutable({ repoDir, sourceDir, baseRef, metadata }) {
  if (!baseRef || !/^[a-zA-Z0-9_./~-]+$/.test(baseRef)) fail('an available Git base is required');
  const base = git(repoDir, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
  const relative = path.relative(repoDir, sourceDir).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
    fail('source must be inside Git repository');
  const files = git(repoDir, ['ls-tree', '-r', '--name-only', '-z', base, '--', relative])
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    if (!file.endsWith('/meta.json')) continue;
    const folder = path.posix.basename(path.posix.dirname(file));
    const old = normalizeMetadata(JSON.parse(git(repoDir, ['show', `${base}:${file}`])), folder);
    if (old.status === 'draft') continue;
    const current = metadata.get(old.id);
    if (!current) fail(`previously published ${old.id} cannot be deleted; use withdrawn`);
    if (current.status === 'draft') fail(`${old.id} cannot return to draft; use withdrawn`);
    for (const field of ['id', 'publishedAt', 'showToNewUsers'])
      if (old[field] !== current[field]) fail(`${old.id}: immutable ${field} changed`);
  }
}

export async function generateAnnouncements({
  sourceDir = path.join(ROOT, 'landing/content/announcements'),
  outputDir = path.join(ROOT, 'landing/public/announcements'),
  baseRef,
  repoDir = ROOT,
  checkOnly = false,
} = {}) {
  sourceDir = path.resolve(sourceDir);
  outputDir = path.resolve(outputDir);
  if (
    outputDir === sourceDir ||
    sourceDir.startsWith(`${outputDir}${path.sep}`) ||
    outputDir.startsWith(`${sourceDir}${path.sep}`)
  )
    fail('source and output must be separate');
  const config = await json(path.join(sourceDir, 'feed.config.json'));
  if (!plain(config) || typeof config.autoShowEnabled !== 'boolean')
    fail('feed.config.json requires autoShowEnabled boolean');
  const metadata = new Map();
  const outputFiles = new Map();
  const items = [];
  for (const folder of await entries(sourceDir)) {
    if (folder === 'feed.config.json') continue;
    const dir = path.join(sourceDir, folder);
    const names = await entries(dir);
    if (names.some((name) => !['meta.json', 'body.md', 'assets'].includes(name)))
      fail(`${folder}: unexpected source file`);
    const meta = normalizeMetadata(await json(path.join(dir, 'meta.json')), folder);
    if (metadata.has(meta.id)) fail(`duplicate id: ${meta.id}`);
    metadata.set(meta.id, meta);
    const body = await bytes(path.join(dir, 'body.md'), 256 * 1024);
    let markdown;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      fail(`${folder}: body must be UTF-8`);
    }
    const files = names.includes('assets') ? await assets(path.join(dir, 'assets')) : new Map();
    validateImages(markdown, files, folder);
    if (meta.heroImage && !files.has(meta.heroImage))
      fail(`${folder}: heroImage must name an existing local asset`);
    files.set('body.md', body);
    const manifest = [...files]
      .sort(([a], [b]) => compare(a, b))
      .map(([name, data]) => [name, sha(data)]);
    const bundle = sha(JSON.stringify(manifest));
    if (meta.status === 'draft' || meta.status === 'withdrawn') continue;
    const prefix = `content/${meta.id}/${bundle}`;
    for (const [name, data] of files) outputFiles.set(`${prefix}/${name}`, data);
    const { heroImage, ...feedMeta } = meta;
    items.push({
      ...feedMeta,
      bodyPath: `/announcements/${prefix}/body.md`,
      bodySha256: sha(body),
      ...(heroImage ? { heroImagePath: `/announcements/${prefix}/${heroImage}` } : {}),
    });
  }
  if (items.length > 1000) fail('feed exceeds 1000 items');
  items.sort((a, b) => compare(b.publishedAt, a.publishedAt) || compare(b.id, a.id));
  const content = { schemaVersion: 1, autoShowEnabled: config.autoShowEnabled, items };
  const feed = {
    schemaVersion: 1,
    revision: sha(JSON.stringify(content)),
    autoShowEnabled: config.autoShowEnabled,
    items,
  };
  const serialized = `${JSON.stringify(feed, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 512 * 1024) fail('feed exceeds 512 KiB');
  if (baseRef !== undefined || checkOnly)
    validateImmutable({ repoDir, sourceDir, baseRef, metadata });
  if (checkOnly) return feed;
  await mkdir(path.dirname(outputDir), { recursive: true });
  await safeStat(path.dirname(outputDir), true);
  try {
    await safeStat(outputDir, true);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = `${outputDir}.tmp-${process.pid}`;
  await mkdir(staging); // Existing path is never followed or removed.
  try {
    for (const [name, data] of outputFiles) {
      const dest = path.join(staging, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
    await writeFile(path.join(staging, 'feed.v1.json'), serialized);
    await rm(outputDir, { recursive: true, force: true });
    await rename(staging, outputDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return feed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const flags = new Map([
    ['--source', 'sourceDir'],
    ['--output', 'outputDir'],
    ['--base', 'baseRef'],
    ['--repo', 'repoDir'],
  ]);
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--check') options.checkOnly = true;
      else if (flags.has(arg) && process.argv[i + 1]) options[flags.get(arg)] = process.argv[++i];
      else fail(`unknown or incomplete argument: ${arg}`);
    }
    const feed = await generateAnnouncements(options);
    console.log(`Announcements: ${feed.items.length} items, revision ${feed.revision}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
