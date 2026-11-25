import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createOpenCodeV2FileMaterialization, openCodeV2SelectedSourceReference,
  parseOpenCodeV2SelectedFileDescriptor } from './OpenCodeV2SelectedFileKey.js';
import type { OpenCodeV2SelectedFileMode } from './OpenCodeV2SelectedFileKey.js';
import type { VerifiedOpenCodeV2EmbeddedGraph } from './OpenCodeV2EmbeddedGraph.js';

type EffectValue = unknown;
interface NativeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly remoteAddress: unknown;
  readonly source: { readonly aborted?: boolean; readonly rawHeaders?: readonly string[] };
  readonly arrayBuffer: EffectValue;
  modify(input: { url?: string; remoteAddress?: unknown }): NativeRequest;
}
interface NativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly cookies: unknown;
  readonly body: { readonly _tag: string; readonly body?: Uint8Array; readonly contentType?: string };
}
interface EffectModule {
  Effect: {
    sync<A>(action: () => A): EffectValue;
    try<A>(action: { try(): A; catch(error: unknown): Error }): EffectValue;
    flatMap<A>(effect: EffectValue, action: (value: A) => EffectValue): EffectValue;
    provideService(effect: EffectValue, tag: unknown, service: unknown): EffectValue;
    catch(effect: EffectValue, action: (error: unknown) => EffectValue): EffectValue;
  };
  Option: { some<A>(value: A): unknown };
}
interface HttpModule {
  HttpServerRequest: { HttpServerRequest: unknown; MaxBodySize: unknown; fromWeb(value: Request): NativeRequest };
  HttpServerResponse: {
    jsonUnsafe(value: unknown, options?: { status?: number; headers?: Record<string, string>; cookies?: unknown }): NativeResponse;
  };
}
interface FileModule { FSUtil: { Service: unknown } }
interface VariableModule { ConfigVariable: { substitute(input: unknown): EffectValue } }
interface AuthModule {
  authorizedRequest(request: NativeRequest, config: unknown): EffectValue;
  unauthorizedResponse(request: NativeRequest): NativeResponse;
}
const held = (): never => { throw new Error('OpenCode V2 selected native source refused'); };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/u.test(value);
const integration = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);

/** A finite transform in the original native server, retaining its request fiber, Scope and handler. */
export async function createOpenCodeV2NativeFileTransform(input: {
  descriptor: unknown; mode: OpenCodeV2SelectedFileMode; nonce: string; password: string;
  graph: VerifiedOpenCodeV2EmbeddedGraph; signal: AbortSignal;
}): Promise<(app: EffectValue) => EffectValue> {
  const source = parseOpenCodeV2SelectedFileDescriptor(input.descriptor), modules = input.graph.selectedFileModules;
  if (!modules || !['fresh', 'restore', 'catalog'].includes(input.mode) || !hash(input.nonce) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.password) || source.cwd !== process.cwd() || source.home !== homedir()) return held();
  input.signal.throwIfAborted();
  const [{ Effect, Option }, http, fs, variable, auth] = await Promise.all([
    import(pathToFileURL(input.graph.effectPath).href) as Promise<EffectModule>,
    import(pathToFileURL(modules.httpPath).href) as Promise<HttpModule>,
    import(pathToFileURL(modules.fileSystemPath).href) as Promise<FileModule>,
    import(pathToFileURL(modules.variablePath).href) as Promise<VariableModule>,
    import(pathToFileURL(modules.authorizationPath).href) as Promise<AuthModule>,
  ]);
  input.signal.throwIfAborted();
  if (typeof Effect.try !== 'function' || typeof Effect.flatMap !== 'function' || typeof Effect.provideService !== 'function' ||
      typeof Effect.catch !== 'function' || typeof Option.some !== 'function' || !fs.FSUtil?.Service ||
      typeof variable.ConfigVariable?.substitute !== 'function' || typeof auth.authorizedRequest !== 'function' ||
      typeof auth.unauthorizedResponse !== 'function' || !http.HttpServerRequest?.MaxBodySize ||
      typeof http.HttpServerRequest.fromWeb !== 'function' || typeof http.HttpServerResponse?.jsonUnsafe !== 'function') return held();
  const attempt = { spent: false, imported: false };
  const safely = <A>(work: () => A) => Effect.try({ try: work, catch: () => new Error('OpenCode V2 selected native source refused') });
  const refused = () => http.HttpServerResponse.jsonUnsafe({ _tag: 'InvalidRequestError',
    message: 'Selected credential source unavailable' }, { status: 400 });
  const closed = (effect: EffectValue) => Effect.catch(effect, () => Effect.sync(refused));
  const credentials = { username: 'opencode', password: Option.some(input.password) };
  const basic = 'Basic ' + Buffer.from('opencode:' + input.password).toString('base64');

  function shape(request: NativeRequest) {
    const url = new URL(request.url, 'http://127.0.0.1'), path = /^\/api\/integration\/([^/]+)(\/connect\/key)?$/u.exec(url.pathname);
    if (!path || url.hash || url.username || url.password) return held();
    const id = decodeURIComponent(path[1]!);
    if (!integration(id) || encodeURIComponent(id) !== path[1] ||
        [...url.searchParams.keys()].length !== 1 || url.searchParams.get('location[directory]') !== source.cwd ||
        url.search !== '?' + new URLSearchParams({ 'location[directory]': source.cwd })) return held();
    if (request.method === 'POST' ? !path[2] : request.method !== 'GET' || path[2]) return held();
    const raw = request.source.rawHeaders;
    if (!Array.isArray(raw) || raw.length % 2) return held();
    for (const name of ['authorization', 'x-agent-teams-selected-source', 'x-agent-teams-selected-source-deadline']) {
      if (raw.filter((_value, index) => index % 2 === 0 && raw[index]!.toLowerCase() === name).length > 1) return held();
    }
    if (request.headers.authorization !== basic) return held();
    return { id, reference: openCodeV2SelectedSourceReference(source, input.nonce, id, input.mode) };
  }
  function cutoff(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= Date.now() || value > Date.now() + 30000) return held();
    return value;
  }
  const checkRequest = (request: NativeRequest, deadline: number) => {
    input.signal.throwIfAborted();
    if (request.source.aborted || Date.now() >= deadline) return held();
  };
  function requestBody(request: NativeRequest, key: string): NativeRequest {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && name !== 'content-length' && name !== 'transfer-encoding') headers.set(name, value);
    }
    const body = JSON.stringify({ key }); headers.set('content-type', 'application/json');
    headers.set('content-length', String(Buffer.byteLength(body)));
    // This Request is an in-memory body view. The app effect still runs in the original HTTP fiber.
    return http.HttpServerRequest.fromWeb(new Request(new URL(request.url, 'http://' + request.headers.host), {
      method: request.method, headers, body,
    })).modify({ url: request.url, remoteAddress: request.remoteAddress });
  }
  function wrap(response: NativeResponse, reference: string, witness: string, original?: unknown): NativeResponse {
    const headers = Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !['content-length', 'content-type', 'transfer-encoding'].includes(entry[0])));
    return http.HttpServerResponse.jsonUnsafe({ schemaVersion: 1, sourceReference: reference, witness,
      ...(original === undefined ? {} : { integration: original }) }, { status: 200, headers, cookies: response.cookies });
  }
  function materialize(app: EffectValue, request: NativeRequest, selected: { id: string; reference: string }, deadline: number) {
    const check = () => checkRequest(request, deadline), capture = createOpenCodeV2FileMaterialization(source, check);
    const environment = Object.fromEntries(source.environment.map(row => [row.name, row.value ?? '']));
    const parse = variable.ConfigVariable.substitute({
      ...(source.origin.kind === 'file' ? { type: 'path', path: source.origin.path }
        : { type: 'virtual', source: 'agent-teams-selected-api-key', dir: source.cwd }),
      text: JSON.stringify({ apiKey: source.rawKey }), env: environment,
    });
    const substituted = Effect.provideService(parse, fs.FSUtil.Service, {
      readFileString: (path: string) => safely(() => capture.readFileString(path)),
    });
    return Effect.flatMap<string>(substituted, value => Effect.flatMap<{ key: string; request: NativeRequest }>(safely(() => {
      check(); const decoded: unknown = JSON.parse(value);
      if (!object(decoded) || Object.keys(decoded).length !== 1 || !Object.hasOwn(decoded, 'apiKey')) return held();
      const key = capture.materializedKey(decoded.apiKey);
      return { key, request: request.method === 'POST' ? requestBody(request, key) : request };
    }), captured => Effect.flatMap<NativeResponse>(Effect.provideService(app, http.HttpServerRequest.HttpServerRequest,
      captured.request), response => safely(() => {
      check();
      if (request.method === 'POST') {
        if (response.status !== 204 || response.body._tag !== 'Empty') return response;
        attempt.imported = true;
        return wrap(response, selected.reference, capture.issue(captured.key, {
          nonce: input.nonce, pid: process.pid, integrationId: selected.id, reference: selected.reference,
        }));
      }
      if (response.status !== 200) return response;
      if (response.body._tag !== 'Uint8Array' || !response.body.body || response.body.body.byteLength > 8 * 1024 * 1024 ||
          !response.body.contentType?.includes('json')) return held();
      const original: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body.body));
      if (!object(original)) return held();
      return wrap(response, selected.reference, capture.issue(captured.key, {
        nonce: input.nonce, pid: process.pid, integrationId: selected.id, reference: selected.reference,
      }), original);
    }))));
  }
  return app => Effect.flatMap<NativeRequest>(http.HttpServerRequest.HttpServerRequest, request => {
    const privateRead = request.headers['x-agent-teams-selected-source'] !== undefined ||
      request.headers['x-agent-teams-selected-source-deadline'] !== undefined;
    const keyPost = request.method === 'POST' && /^\/api\/integration\/[^/?]+\/connect\/key(?:\?|$)/u.test(request.url);
    if (!privateRead && !keyPost || input.mode === 'catalog') return app;
    return closed(Effect.flatMap<boolean>(auth.authorizedRequest(request, credentials), authorized => {
      if (!authorized) return Effect.sync(() => auth.unauthorizedResponse(request));
      return Effect.flatMap<{ id: string; reference: string }>(safely(() => shape(request)), selected => {
        if (request.method === 'GET') return Effect.flatMap<number>(safely(() => {
          const deadline = request.headers['x-agent-teams-selected-source-deadline'];
          if (request.headers['x-agent-teams-selected-source'] !== 'v1:' + selected.reference ||
              typeof deadline !== 'string' || !/^[1-9]\d{0,15}$/u.test(deadline) ||
              String(Number(deadline)) !== deadline || input.mode === 'fresh' && !attempt.imported) return held();
          return cutoff(Number(deadline));
        }), deadline => materialize(app, request, selected, deadline));
        if (input.mode !== 'fresh' || attempt.spent || privateRead) return Effect.sync(refused);
        // The original Node adapter reads this same request with MaxBodySize and closes its stream on interruption.
        const bytes = Effect.provideService(request.arrayBuffer, http.HttpServerRequest.MaxBodySize, 4096n);
        return Effect.flatMap<{ deadline: number }>(Effect.flatMap<ArrayBuffer>(bytes, value => safely(() => {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(value), body: unknown = JSON.parse(content);
          if (!object(body) || Object.keys(body).length !== 1 || !object(body.selectedSource)) return held();
          const sourceRequest = body.selectedSource;
          if (Object.keys(sourceRequest).length !== 3 || sourceRequest.schemaVersion !== 1 ||
              sourceRequest.reference !== selected.reference || JSON.stringify({ selectedSource: {
                schemaVersion: 1, reference: selected.reference, deadline: sourceRequest.deadline,
              } }) !== content || attempt.spent) return held();
          const deadline = cutoff(sourceRequest.deadline); checkRequest(request, deadline);
          attempt.spent = true; return { deadline };
        })), ({ deadline }) => materialize(app, request, selected, deadline));
      });
    }));
  });
}
