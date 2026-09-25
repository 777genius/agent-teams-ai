import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, posix, relative, sep } from 'node:path';

export const HOSTED_RENDERER_GRAPH_MANIFEST = 'hosted-renderer-graph.json';
export const HOSTED_BROWSER_EVENT_STREAM_ENTRY =
  'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts';
export const HOSTED_BROWSER_EVENT_STREAM_GLOBAL = '__agentTeamsHostedCoordinationEventStream';
export const HOSTED_BROWSER_EVENT_STREAM_API = Object.freeze([
  Object.freeze({
    globalKey: 'createHostedCoordinationEventBootstrapTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
  }),
  Object.freeze({
    globalKey: 'createHostedCoordinationEventTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
  }),
]);

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isSortedUniqueStrings(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    value.every((entry, index) => index === 0 || value[index - 1].localeCompare(entry) < 0)
  );
}

export function isCanonicalGraphModuleId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  const unprefixed = value.startsWith('\0') ? value.slice(1) : value;
  const path = unprefixed.split('?')[0];
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveJavaScriptSpecifier(importer, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('./')) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return resolved.startsWith('../') || !resolved.endsWith('.js') ? null : resolved;
}

export function collectRendererJavaScript(rendererRoot) {
  if (!existsSync(rendererRoot) || !statSync(rendererRoot).isDirectory()) return [];
  const paths = [];
  const stack = [rendererRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && ['.cjs', '.js', '.mjs'].includes(extname(entry.name))) {
        paths.push(relative(rendererRoot, path).split(sep).join('/'));
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function hostedBrowserChunkIsolationViolations(chunks) {
  const violations = [];
  const installerEntries = chunks.filter(
    (chunk) =>
      isRecord(chunk) &&
      chunk.isEntry === true &&
      chunk.facadeModuleId === HOSTED_BROWSER_EVENT_STREAM_ENTRY
  );
  if (
    installerEntries.length !== 1 ||
    !Array.isArray(installerEntries[0]?.moduleIds) ||
    installerEntries[0].moduleIds.includes('src/renderer/hosted/main.tsx')
  ) {
    violations.push('hosted_renderer_graph_browser_entry_not_isolated');
  }
  const apiChunkPaths = HOSTED_BROWSER_EVENT_STREAM_API.map(({ moduleId }) =>
    chunks
      .filter((chunk) => isRecord(chunk) && chunk.moduleIds?.includes?.(moduleId))
      .map((chunk) => chunk.fileName)
  );
  if (
    apiChunkPaths.some((paths) => paths.length !== 1) ||
    new Set(apiChunkPaths.flat()).size !== HOSTED_BROWSER_EVENT_STREAM_API.length
  ) {
    violations.push('hosted_renderer_graph_browser_api_not_isolated');
  }
  return violations;
}
