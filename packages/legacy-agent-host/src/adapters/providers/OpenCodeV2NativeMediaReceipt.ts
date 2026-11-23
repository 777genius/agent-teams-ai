import { pathToFileURL } from 'node:url';
import { captureOpenCodeV2MediaSource, captureOpenCodeV2MediaProjection, issueOpenCodeV2MediaWitness,
  openCodeV2MediaDeadlineHeader, openCodeV2MediaReceiptHeader, openCodeV2MediaPromptBytes,
  openCodeV2MediaProjectionBytes } from './OpenCodeV2MediaReceipt.js';
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
    sync<A>(work: () => A): EffectValue;
    try<A>(work: { try(): A; catch(): Error }): EffectValue;
    flatMap<A>(effect: EffectValue, work: (value: A) => EffectValue): EffectValue;
    provideService(effect: EffectValue, tag: unknown, service: unknown): EffectValue;
    catch(effect: EffectValue, work: () => EffectValue): EffectValue;
    timeout(effect: EffectValue, duration: number): EffectValue;
  };
  Option: { some<A>(value: A): unknown };
}
interface HttpModule {
  HttpServerRequest: { HttpServerRequest: unknown; MaxBodySize: unknown; fromWeb(request: Request): NativeRequest };
  HttpServerResponse: { jsonUnsafe(value: unknown, options?: {
    status?: number; headers?: Record<string, string>; cookies?: unknown;
  }): NativeResponse };
}
interface AuthModule {
  authorizedRequest(request: NativeRequest, config: unknown): EffectValue;
  unauthorizedResponse(request: NativeRequest): NativeResponse;
}
const held = (): never => { throw new Error('OpenCode V2 native media unavailable'); };

/**
 * Observe source bytes and the actual normalizer output inside the same original
 * HTTP fiber. No secondary prompt, normalizer, model call or public signer route.
 */
export async function createOpenCodeV2NativeMediaReceipt(input: {
  sessionId: string; key: string; password: string; graph: VerifiedOpenCodeV2EmbeddedGraph; signal: AbortSignal;
}): Promise<(app: EffectValue) => EffectValue> {
  const modules = input.graph.selectedFileModules;
  if (!modules || !/^ses_[A-Za-z0-9_-]+$/u.test(input.sessionId) || !/^[a-f0-9]{64}$/u.test(input.key) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.password)) return held();
  const [{ Effect, Option }, http, auth] = await Promise.all([
    import(pathToFileURL(input.graph.effectPath).href) as Promise<EffectModule>,
    import(pathToFileURL(modules.httpPath).href) as Promise<HttpModule>,
    import(pathToFileURL(modules.authorizationPath).href) as Promise<AuthModule>,
  ]);
  input.signal.throwIfAborted();
  if (typeof Effect.timeout !== 'function' || typeof Effect.try !== 'function' ||
    typeof Effect.flatMap !== 'function' || typeof Effect.provideService !== 'function' ||
    typeof Effect.catch !== 'function' || typeof Option.some !== 'function' ||
    !http.HttpServerRequest?.MaxBodySize || typeof http.HttpServerRequest.fromWeb !== 'function' ||
    typeof http.HttpServerResponse?.jsonUnsafe !== 'function' ||
    typeof auth.authorizedRequest !== 'function' || typeof auth.unauthorizedResponse !== 'function') return held();
  const credentials = { username: 'opencode', password: Option.some(input.password) };
  const basic = 'Basic ' + Buffer.from('opencode:' + input.password).toString('base64');
  const safely = <A>(work: () => A) => Effect.try({ try: work, catch: () => new Error('OpenCode V2 native media unavailable') });
  const refused = () => http.HttpServerResponse.jsonUnsafe({ _tag: 'InvalidRequestError',
    message: 'Media delivery unavailable' }, { status: 400 });
  const check = (request: NativeRequest, deadline: number) => {
    input.signal.throwIfAborted();
    if (request.source.aborted || Date.now() >= deadline) return held();
  };
  return app => Effect.flatMap<NativeRequest>(http.HttpServerRequest.HttpServerRequest, request => {
    if (request.headers[openCodeV2MediaDeadlineHeader] === undefined) return app;
    return Effect.catch(Effect.flatMap<boolean>(auth.authorizedRequest(request, credentials), authorized => {
      if (!authorized) return Effect.sync(() => auth.unauthorizedResponse(request));
      return Effect.flatMap<number>(safely(() => {
        const raw = request.source.rawHeaders, deadlineText = request.headers[openCodeV2MediaDeadlineHeader];
        if (request.method !== 'POST' || request.url !== `/api/session/${input.sessionId}/prompt` ||
          request.headers.authorization !== basic || request.headers['content-type'] !== 'application/json' ||
          !Array.isArray(raw) || raw.length % 2 || typeof deadlineText !== 'string' ||
          !/^[1-9]\d{0,15}$/u.test(deadlineText)) return held();
        for (const name of ['authorization', 'content-type', openCodeV2MediaDeadlineHeader]) {
          if (raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length !== 1) return held();
        }
        const deadline = Number(deadlineText);
        if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 30_000) return held();
        check(request, deadline);
        return deadline;
      }), deadline => {
        const bytes = Effect.provideService(request.arrayBuffer, http.HttpServerRequest.MaxBodySize, BigInt(openCodeV2MediaPromptBytes));
        const complete = Effect.flatMap<ArrayBuffer>(bytes, value => Effect.flatMap(safely(() => {
          check(request, deadline);
          const body = new TextDecoder('utf-8', { fatal: true }).decode(value);
          const source = captureOpenCodeV2MediaSource(body, input.sessionId);
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined && !['content-length', 'transfer-encoding', openCodeV2MediaDeadlineHeader].includes(name)) headers.set(name, value);
          }
          headers.set('content-length', String(Buffer.byteLength(body)));
          const original = http.HttpServerRequest.fromWeb(new Request(new URL(request.url, 'http://' + request.headers.host), {
            method: request.method, headers, body,
          })).modify({ url: request.url, remoteAddress: request.remoteAddress });
          return { source, original };
        }), (captured: { source: ReturnType<typeof captureOpenCodeV2MediaSource>; original: NativeRequest }) =>
          Effect.flatMap<NativeResponse>(Effect.provideService(app, http.HttpServerRequest.HttpServerRequest,
            captured.original), response => safely(() => {
            check(request, deadline);
            if (response.status !== 200) return response;
            if (response.body._tag !== 'Uint8Array' || !response.body.body ||
              response.body.body.byteLength > openCodeV2MediaProjectionBytes || !response.body.contentType?.includes('json')) return held();
            const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body.body));
            const projectionDigest = captureOpenCodeV2MediaProjection(result, captured.source);
            const witness = issueOpenCodeV2MediaWitness(input.key, { sessionId: input.sessionId,
              inputId: captured.source.inputId, sourceDigest: captured.source.sourceDigest, projectionDigest }, deadline);
            const headers = Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] =>
              entry[1] !== undefined && !['content-length', 'content-type', 'transfer-encoding', openCodeV2MediaReceiptHeader].includes(entry[0])));
            headers[openCodeV2MediaReceiptHeader] = witness;
            return http.HttpServerResponse.jsonUnsafe(result, { status: 200, headers, cookies: response.cookies });
          }))));
        return Effect.timeout(complete, Math.max(1, deadline - Date.now()));
      });
    }), () => Effect.sync(refused));
  });
}
