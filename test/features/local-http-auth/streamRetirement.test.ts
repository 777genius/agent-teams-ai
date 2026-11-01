/* eslint-disable @typescript-eslint/require-await -- synthetic async services preserve their promise contracts */
import { AuthenticatedEventStream, BrowserAccessSession } from '@features/local-http-auth/renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { deferred, fixtureKey, fixtureRequestUrl } from './browserFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['expiry', 'same-key', 'replacement', 'unsubscribe'] as const)(
  'discards an already completed read after %s before dispatch and never reconnects its retired connection',
  async (mode) => {
    const session = new BrowserAccessSession('http://fixture.test');
    const key = fixtureKey();
    const reads: ReturnType<typeof deferred<ReadableStreamReadResult<Uint8Array>>>[] = [];
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const events = vi.fn();
    const expiry = deferred<Response>();
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (fixtureRequestUrl(input).endsWith('/api/auth/ready'))
        return Promise.resolve(new Response('{"ready":true,"service":"api"}'));
      if (fixtureRequestUrl(input).endsWith('/api/expire')) return expiry.promise;
      const read = deferred<ReadableStreamReadResult<Uint8Array>>();
      reads.push(read);
      const cancel = vi.fn(async () => {
        /* synthetic no-op callback */
      });
      cancels.push(cancel);
      // A controlled reader models a fulfilled read whose await continuation is queued.
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: {
          getReader: () => ({
            read: () => read.promise,
            cancel,
            releaseLock: () => {
              /* synthetic no-op callback */
            },
          }),
          cancel,
        },
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetcher);
    await session.enterKey(key);
    const stream = new AuthenticatedEventStream(session, 5);
    let unsubscribe = stream.subscribe('channel', events);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    // Ensure run() is waiting on read(), then queue invalidation ahead of its continuation.
    await Promise.resolve();
    let entering: Promise<void> | undefined;
    let expiring: Promise<Response> | undefined;
    if (mode === 'expiry') {
      expiring = session.fetch('/api/expire');
      expiry.resolve(new Response('', { status: 401 }));
    }
    reads[0].resolve({
      done: false,
      value: new TextEncoder().encode('event: channel\ndata: {"retired":true}\n\n'),
    });
    if (mode === 'same-key' || mode === 'replacement')
      entering = session.enterKey(mode === 'same-key' ? key : fixtureKey());
    if (mode === 'unsubscribe') {
      unsubscribe();
      unsubscribe = stream.subscribe('channel', events);
    }
    await entering;
    await expiring;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(events).not.toHaveBeenCalled();
    expect(cancels[0]).toHaveBeenCalled();
    expect(reads).toHaveLength(mode === 'expiry' ? 1 : 2);
    unsubscribe();
    stream.dispose();
  }
);

it('stops callbacks and subsequent frames when a listener retires the connection mid-chunk', async () => {
  const session = new BrowserAccessSession('http://fixture.test');
  const completed = deferred<ReadableStreamReadResult<Uint8Array>>();
  const cancel = vi.fn(async () => {
    /* synthetic no-op callback */
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      fixtureRequestUrl(input).endsWith('/api/auth/ready')
        ? new Response('{"ready":true,"service":"api"}')
        : ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: {
              getReader: () => ({
                read: () => completed.promise,
                cancel,
                releaseLock: () => {
                  /* synthetic no-op callback */
                },
              }),
              cancel,
            },
          } as unknown as Response)
    )
  );
  await session.enterKey(fixtureKey());
  const stream = new AuthenticatedEventStream(session);
  const first = vi.fn(() => session.clear()),
    second = vi.fn();
  stream.subscribe('channel', first);
  stream.subscribe('channel', second);
  await Promise.resolve();
  completed.resolve({
    done: false,
    value: new TextEncoder().encode('event: channel\ndata: 1\n\nevent: channel\ndata: 2\n\n'),
  });
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  expect(second).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toBe('required');
  stream.dispose();
});
