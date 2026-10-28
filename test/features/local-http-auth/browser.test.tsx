/* eslint-disable @typescript-eslint/require-await -- synthetic async services preserve their promise contracts */
// Observable regressions: requests before explicit key entry; secret URL/cookie transport;
// dropped UTF8/fragments; duplicate connections; retry storms after 401; leaked readers after disposal.
import { fixtureKey, fixtureRequestUrl } from './browserFixture';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BrowserAccessSession,
  getBrowserAccessSession,
  AuthenticatedEventStream,
  SseFrameDecoder,
  BrowserAccessGate,
} from '@features/local-http-auth/renderer';
import { HttpAPIClient } from '@renderer/api/httpClient';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function readiness(fetcher: typeof fetch): typeof fetch {
  return (input, options) =>
    fixtureRequestUrl(input).endsWith('/api/auth/ready')
      ? Promise.resolve(new Response(JSON.stringify({ ready: true, service: 'api' })))
      : fetcher(input, options);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('blocks data and event requests until explicit key entry and binds authorization to the configured origin', async () => {
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const fetchMock = vi.fn(
    async () => new Response('[]', { headers: { 'content-type': 'application/json' } })
  );
  vi.stubGlobal('fetch', readiness(fetchMock));
  const client = new HttpAPIClient(session.baseUrl, session);
  const unsubscribe = client.onFileChange(() => {
    /* synthetic no-op callback */
  });
  await expect(client.getProjects()).rejects.toThrow('access key');
  expect(fetchMock).not.toHaveBeenCalled();
  unsubscribe();
  await session.enterKey(key);
  expect(await client.getProjects()).toEqual([]);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://fixture.test/api/projects');
  expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${key}`);
  expect(options.credentials).toBe('omit');
  expect(options.redirect).toBe('error');
  await expect(session.fetch('http://foreign.test/api/projects')).rejects.toThrow('Foreign');
  expect(fetchMock).toHaveBeenCalledOnce();
  client.dispose();
});

it('401 clears the key, exposes reauthentication and prevents subsequent requests without retries', async () => {
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const fetchMock = vi.fn(
    async () => new Response('{"error":"API access key required"}', { status: 401 })
  );
  vi.stubGlobal('fetch', readiness(fetchMock));
  await session.enterKey(key);
  const client = new HttpAPIClient(session.baseUrl, session);
  await expect(client.getProjects()).rejects.toThrow('access key');
  expect(session.getSnapshot()).toBe('expired');
  await expect(client.getProjects()).rejects.toThrow('access key');
  expect(fetchMock).toHaveBeenCalledOnce();
  client.dispose();
});

it('decodes fragmented UTF8, channel frames, multiline JSON and keepalive comments', () => {
  const events: [string, unknown][] = [];
  const decoder = new SseFrameDecoder((channel, value) => events.push([channel, value]));
  const bytes = new TextEncoder().encode(
    ':ping\r\n\r\nevent: fixture:changed\r\ndata: {"text":"日本語🙂"}\r\n\r\nevent: second\ndata: {"count":\ndata: 2}\n\n:keepalive\n\n'
  );
  for (const byte of bytes) decoder.push(new Uint8Array([byte]));
  expect(events).toEqual([
    ['fixture:changed', { text: '日本語🙂' }],
    ['second', { count: 2 }],
  ]);
});

it('shares one fetch stream across listeners and cancels on unsubscribe/dispose', async () => {
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const canceled = vi.fn();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      writer = controller;
    },
    cancel: canceled,
  });
  const fetchMock = vi.fn(
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  );
  vi.stubGlobal('fetch', readiness(fetchMock));
  const stream = new AuthenticatedEventStream(session, 10);
  const first = vi.fn(),
    second = vi.fn();
  const unFirst = stream.subscribe('channel', first);
  const unSecond = stream.subscribe('channel', second);
  expect(fetchMock).not.toHaveBeenCalled();
  await session.enterKey(key);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  writer.enqueue(new TextEncoder().encode('event: channel\ndata: {"value":1}\n\n'));
  await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ value: 1 }));
  expect(second).toHaveBeenCalledWith({ value: 1 });
  unFirst();
  writer.enqueue(new TextEncoder().encode('event: channel\ndata: {"value":2}\n\n'));
  await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2));
  expect(first).toHaveBeenCalledOnce();
  unSecond();
  stream.dispose();
  await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('reconnects interrupted streams once and stops timers after dispose', async () => {
  vi.useFakeTimers();
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const fetchMock = vi.fn(
    async () =>
      new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  vi.stubGlobal('fetch', readiness(fetchMock));
  await session.enterKey(key);
  const stream = new AuthenticatedEventStream(session, 100);
  stream.subscribe('channel', () => {
    /* synthetic no-op callback */
  });
  stream.subscribe('other', () => {
    /* synthetic no-op callback */
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  stream.dispose();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('stops SSE and reconnects only after new explicit entry following 401', async () => {
  vi.useFakeTimers();
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
  vi.stubGlobal('fetch', readiness(fetchMock));
  await session.enterKey(key);
  const stream = new AuthenticatedEventStream(session, 100);
  stream.subscribe('channel', () => {
    /* synthetic no-op callback */
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(session.getSnapshot()).toBe('expired');
  await session.enterKey(fixtureKey());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  stream.dispose();
});

it('access UI mounts application effects only after entry and replaces expired application with a usable form', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  const mounted = vi.fn();
  function PrivateApplication() {
    useEffect(() => {
      mounted();
    }, []);
    return <p>Private application</p>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BrowserAccessGate session={session}>
          <PrivateApplication />
        </BrowserAccessGate>
      )
    );
    expect(mounted).not.toHaveBeenCalled();
    expect(container.textContent).toContain('API access key');
    vi.stubGlobal('fetch', readiness(vi.fn()));
    await act(async () => {
      await session.enterKey(key);
    });
    expect(mounted).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Private application');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    );
    await act(async () => {
      await session.fetch('/api/projects');
    });
    expect(container.textContent).toContain('Access key expired or invalid');
    expect(container.querySelector('button')?.textContent).toBe('Connect');
    expect(container.innerHTML).not.toContain(key);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

// Regression: an invalid candidate must never mount effects or open a private stream.
it('waits for successful authenticated readiness before data or SSE, and rejects invalid candidates', async () => {
  const session = new BrowserAccessSession('http://fixture.test');
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  const stream = new AuthenticatedEventStream(session, 10);
  stream.subscribe('channel', () => {
    /* synthetic no-op callback */
  });
  const candidate = session.enterKey(fixtureKey());
  expect(session.getSnapshot()).toBe('checking');
  const data = session.fetch('/api/projects');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fixtureRequestUrl(fetchMock.mock.calls[0][0])).toBe('http://fixture.test/api/auth/ready');
  finish(new Response('', { status: 401 }));
  await expect(candidate).rejects.toThrow('invalid');
  await expect(data).rejects.toThrow('invalid');
  expect(session.getSnapshot()).toBe('expired');
  expect(fetchMock).toHaveBeenCalledOnce();
  stream.dispose();
});

// Regression: an old response for the same re-entered key cannot clear a newer verified session.
it('keeps new entry authorized when a stale in-flight 401 returns, even for the same key', async () => {
  const key = fixtureKey();
  const session = new BrowserAccessSession('http://fixture.test');
  let finish!: (response: Response) => void;
  const dataFetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  vi.stubGlobal('fetch', readiness(dataFetch));
  await session.enterKey(key);
  const stale = session.fetch('/api/projects');
  await session.enterKey(key);
  finish(new Response('', { status: 401 }));
  expect((await stale).status).toBe(401);
  expect(session.getSnapshot()).toBe('ready');
  session.clear();
  await expect(session.fetch('/api/projects')).rejects.toThrow('required');
});

// Regression: memory credentials are scoped to both API authority and browser origin.
it('isolates sessions across endpoints and browser origins without persistence', async () => {
  vi.stubGlobal('location', { origin: 'http://ui-one.test' });
  const one = getBrowserAccessSession('http://fixture.test');
  vi.stubGlobal('fetch', readiness(vi.fn(async () => new Response('[]'))));
  await one.enterKey(fixtureKey());
  expect(getBrowserAccessSession('http://other-api.test').getSnapshot()).toBe('required');
  vi.stubGlobal('location', { origin: 'http://ui-two.test' });
  expect(getBrowserAccessSession('http://fixture.test').getSnapshot()).toBe('required');
  await expect(one.fetch('/api/projects')).rejects.toThrow('Foreign');
  one.clear();
});
