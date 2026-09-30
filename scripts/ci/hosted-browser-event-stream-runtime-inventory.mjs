import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { extractHostedHtmlModuleScriptPaths } from './hosted-browser-event-stream-proof-html.mjs';

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

function within(root, path) {
  const remaining = relative(root, path);
  return remaining === '' ||
    (!isAbsolute(remaining) && remaining !== '..' && !remaining.startsWith(`..${sep}`));
}

/** Read and validate the complete renderer tree before opening the proof server. */
export function buildHostedRendererInventory(rendererRootPath) {
  const rendererRoot = resolve(rendererRootPath);
  if (lstatSync(rendererRoot).isSymbolicLink()) throw new Error('renderer_root_symlink');
  const canonicalRoot = realpathSync(rendererRoot);
  const artifactRoot = realpathSync(dirname(dirname(rendererRoot)));
  if (canonicalRoot !== join(artifactRoot, 'out', 'renderer')) {
    throw new Error('renderer_root_escape');
  }
  const files = new Map();
  const pending = [rendererRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`renderer_symlink:${path}`);
      const canonicalPath = realpathSync(path);
      if (!within(canonicalRoot, canonicalPath)) throw new Error(`renderer_escape:${path}`);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`renderer_unsupported_file:${path}`);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error(`renderer_unsupported_file:${path}`);
        bytes = readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const key = relative(rendererRoot, path).split(sep).join('/');
      files.set(key, { bytes, contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' });
    }
  }
  const html = files.get('index.html')?.bytes.toString('utf8');
  const entryPaths = extractHostedHtmlModuleScriptPaths(html);
  if (entryPaths === null) throw new Error('renderer_html_invalid');
  for (const entry of entryPaths) {
    if (!files.has(entry)) throw new Error(`renderer_entry_missing:${entry}`);
  }
  return Object.freeze({
    entryPaths,
    fileForPath(path) {
      const file = files.get(path);
      return file === undefined ? null : { bytes: Buffer.from(file.bytes), contentType: file.contentType };
    },
  });
}

export function inventoriedRendererPath(inventory, requestUrl) {
  let path;
  try {
    const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
    path = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).slice(1);
  } catch {
    return null;
  }
  if (path === '' || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) {
    return null;
  }
  return inventory.fileForPath(path);
}
