/* Private controller resolver, shared by runtime and workSync. Compiled for distribution. */
/* eslint-disable @typescript-eslint/no-require-imports -- this independently built package is CommonJS */
const authFs = require('node:fs') as typeof import('node:fs');
const authPath = require('node:path') as typeof import('node:path');
const authCrypto = require('node:crypto') as typeof import('node:crypto');
const authOs = require('node:os') as typeof import('node:os');
const { assertPrivateWindowsAcl } = require('./windowsPrivateAcl.ts') as {
  assertPrivateWindowsAcl(this: void, file: string): void;
};

export interface ControlContext {
  claudeDir: string;
}
export interface ControlFlags {
  controlUrl?: unknown;
  'control-url'?: unknown;
}
export interface ControlAuthority {
  schemaVersion: 1;
  service: 'api';
  profileScope: string;
  instanceId: string;
  generation: string;
  baseUrl: string;
  token: string;
}
export interface ControlAuthoritySource {
  read(): ControlAuthority;
}
export interface ControlRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
}
export interface ControlAuthModule {
  resolveControlAuthorities(
    context: ControlContext,
    flags?: ControlFlags,
    fixedReference?: string
  ): ControlAuthoritySource[];
  authenticatedControlFetch(
    source: ControlAuthoritySource,
    pathname: string,
    options?: ControlRequestOptions
  ): Promise<Response>;
}

class DiscoveryChanged extends Error {}

function endpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid control API endpoint');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid control API endpoint');
  return url.origin;
}

function validateRoot(root: string): void {
  if (!authPath.isAbsolute(root) || authPath.resolve(root) !== root)
    throw new Error('Invalid API profile root');
  if (process.platform === 'win32') {
    assertPrivateWindowsAcl(root);
    const relative = authPath.win32.relative(authOs.homedir(), root);
    if (!relative || relative.startsWith('..') || authPath.win32.isAbsolute(relative)) {
      throw new Error('API credentials must inherit a private user-profile ACL');
    }
  }
  let cursor = root;
  while (true) {
    const stat = authFs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe control API root');
    if (cursor === root && process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o022)) {
      throw new Error('Control API root is not owner controlled');
    }
    const parent = authPath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function readPrivate(file: string, directory: string): unknown {
  if (process.platform === 'win32') {
    assertPrivateWindowsAcl(directory);
    assertPrivateWindowsAcl(file);
  }
  const dirStat = authFs.lstatSync(directory);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (process.getuid && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o777) !== 0o700))
  ) {
    throw new Error('Unsafe control API credential directory');
  }
  const stat = authFs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600))
  ) {
    throw new Error('Unsafe control API credential reference');
  }
  const fd = authFs.openSync(file, authFs.constants.O_RDONLY | (authFs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = authFs.fstatSync(fd);
    if (opened.isFile() && opened.nlink === 0 && opened.dev === stat.dev && opened.ino === stat.ino)
      throw new DiscoveryChanged('Control API reference was atomically replaced during open');
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.nlink !== 1 ||
      opened.size > 16384 ||
      (process.getuid && (opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600))
    ) {
      throw new Error('Invalid control API credential file');
    }
    try {
      return JSON.parse(authFs.readFileSync(fd, 'utf8')) as unknown;
    } catch {
      throw new Error('Invalid control API credential JSON');
    }
  } finally {
    authFs.closeSync(fd);
  }
}

function authority(value: unknown, scope: string): ControlAuthority {
  const item = value as Partial<ControlAuthority> | null;
  if (
    item?.schemaVersion !== 1 ||
    item.service !== 'api' ||
    item.profileScope !== scope ||
    typeof item.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(item.instanceId) ||
    typeof item.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(item.generation) ||
    typeof item.token !== 'string' ||
    !/^\S{32,512}$/.test(item.token) ||
    endpoint(item.baseUrl) !== item.baseUrl
  )
    throw new Error('Invalid private control API authority');
  return item as ControlAuthority;
}

function readAuthority(
  context: ControlContext,
  flags: ControlFlags,
  fixedReference?: string
): ControlAuthority {
  const root = context.claudeDir;
  validateRoot(root);
  const directory = authPath.join(root, 'local-http-auth');
  const scope = authCrypto.createHash('sha256').update(root).digest('hex');
  const external =
    fixedReference === undefined ? process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF : undefined;
  const reference =
    fixedReference ??
    (external ||
      process.env.CLAUDE_TEAM_CONTROL_AUTH_REF ||
      authPath.join(root, 'team-control-api.json'));
  if (external) {
    if (
      authPath.dirname(reference) !== directory ||
      !/^external-[a-f0-9-]{36}\.json$/.test(authPath.basename(reference))
    ) {
      throw new Error('External authority requires a private profile credential reference');
    }
  } else if (
    reference !== authPath.join(root, 'team-control-api.json') &&
    (authPath.dirname(reference) !== directory ||
      !/^api-[a-f0-9-]{36}\.ref\.json$/.test(authPath.basename(reference)))
  ) {
    throw new Error('Foreign control API credential reference');
  }
  const raw = readPrivate(reference, directory);
  let current: ControlAuthority;
  if (external) {
    current = authority(raw, scope);
    if (reference !== authPath.join(directory, `external-${current.instanceId}.json`))
      throw new Error('Invalid external authority instance');
  } else {
    current = discoveryAuthority(raw, scope, root, directory, reference);
  }
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty optional flag means absent
  const explicit = flags.controlUrl || flags['control-url'];
  if (explicit && endpoint(explicit) !== current.baseUrl) {
    throw new Error('Explicit controlUrl does not match the private credential authority');
  }
  // An inherited endpoint is only a hint. The committed descriptor owns endpoint AND key.
  return current;
}

function discoveryAuthority(
  raw: unknown,
  scope: string,
  root: string,
  directory: string,
  reference: string
): ControlAuthority {
  const discovery = raw as Partial<ControlAuthority> & { descriptorPath?: string };
  if (
    !discovery ||
    typeof discovery !== 'object' ||
    Array.isArray(discovery) ||
    Object.keys(discovery).sort().join(',') !==
      'descriptorPath,generation,instanceId,profileScope,schemaVersion,service'
  ) {
    throw new Error('Invalid control API discovery reference; authentication is required');
  }
  const expected = authPath.join(
    directory,
    `api-${discovery.instanceId}-${discovery.generation}.json`
  );
  if (
    discovery.schemaVersion !== 1 ||
    discovery.service !== 'api' ||
    discovery.profileScope !== scope ||
    typeof discovery.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(discovery.instanceId) ||
    typeof discovery.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(discovery.generation) ||
    discovery.descriptorPath !== expected ||
    (reference !== authPath.join(root, 'team-control-api.json') &&
      reference !== authPath.join(directory, `api-${discovery.instanceId}.ref.json`))
  ) {
    throw new Error('Invalid control API discovery reference; authentication is required');
  }
  const current = authority(readPrivate(expected, directory), scope);
  if (current.instanceId !== discovery.instanceId || current.generation !== discovery.generation) {
    throw new Error('Control API publication changed; retry discovery');
  }
  return current;
}

function configuredAuthority(
  context: ControlContext,
  flags: ControlFlags
): ControlAuthority | null {
  // Direct credentials are a single configured pair. An arbitrary explicit URL
  // cannot borrow the managed app's inherited bearer.
  const explicit = flags.controlUrl || flags['control-url'];
  const envUrl = process.env.CLAUDE_TEAM_CONTROL_URL?.trim();
  const envToken = process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN?.trim();
  const baseUrl = explicit ? endpoint(explicit) : envUrl ? endpoint(envUrl) : '';
  const token = envUrl && baseUrl === endpoint(envUrl) ? envToken : '';
  if (!baseUrl || !token) return null;
  if (!/^\S{32,512}$/.test(token)) throw new Error('Invalid configured control API credential');
  return {
    schemaVersion: 1,
    service: 'api',
    profileScope: authCrypto.createHash('sha256').update(context.claudeDir).digest('hex'),
    instanceId: 'configured',
    generation: 'configured',
    baseUrl,
    token,
  };
}

function resolveControlAuthorities(
  context: ControlContext,
  flags: ControlFlags = {},
  fixedReference?: string
): ControlAuthoritySource[] {
  const reference =
    fixedReference ??
    (process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF || process.env.CLAUDE_TEAM_CONTROL_AUTH_REF);
  // Existing publications always take precedence and fail closed if malformed.
  // Only a missing publication permits an explicitly configured external pair.
  if (fixedReference === undefined && !reference) {
    try {
      authFs.lstatSync(authPath.join(context.claudeDir, 'team-control-api.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const configured = configuredAuthority(context, flags);
      if (configured) return [{ read: () => configured }];
    }
  }
  const source = {
    read: (): ControlAuthority => {
      // Retry discovery only, before sending anything. Unsafe existing files still fail
      // immediately; no mutation response or uncertain delivery is ever replayed.
      for (let attempt = 0; ; attempt++) {
        try {
          return readAuthority(context, flags, fixedReference);
        } catch (error) {
          if (!(error instanceof DiscoveryChanged) || attempt === 2) throw error;
        }
      }
    },
  };
  source.read(); // Fail before requests; no legacy/auth-free fallback.
  return [source];
}

async function authenticatedControlFetch(
  source: ControlAuthoritySource,
  pathname: string,
  options: ControlRequestOptions = {}
): Promise<Response> {
  if (!pathname.startsWith('/api/') || pathname.startsWith('//') || pathname.includes('\\')) {
    throw new Error('Invalid private API request path');
  }
  const method = (options.method ?? 'GET').toUpperCase();
  let current = source.read();
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = new URL(pathname, current.baseUrl);
    if (target.origin !== current.baseUrl) throw new Error('Foreign control API target');
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    // Headers normalizes casing so a caller cannot override the committed bearer.
    headers.set('authorization', `Bearer ${current.token}`);
    if (options.body) headers.set('content-type', 'application/json');
    const response = await fetch(target, {
      method,
      redirect: 'error',
      credentials: 'omit',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal,
    });
    if (response.status !== 401 || method !== 'GET' || attempt !== 0) return response;
    const next = source.read();
    if (next.generation === current.generation) return response;
    await response.body?.cancel();
    current = next;
  }
  throw new Error('Control API authentication failed');
}

module.exports = {
  resolveControlAuthorities,
  authenticatedControlFetch,
} satisfies ControlAuthModule;
