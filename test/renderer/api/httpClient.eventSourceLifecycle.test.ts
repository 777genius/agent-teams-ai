import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, describe, expect, it, vi } from 'vitest';
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();

  addEventListener = vi.fn((channel: string, listener: EventListener) => {
    this.listeners.set(channel, listener);
  });

  emit(channel: string, data: unknown): void {
    this.listeners.get(channel)?.(
      new MessageEvent(channel, {
        data: JSON.stringify(data),
      })
    );
  }
}

describe('HttpAPIClient EventSource lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves browser SSE initialization, event delivery, and unsubscription', () => {
    const eventSource = new FakeEventSource();
    const eventSourceConstructor = vi.fn(() => eventSource);
    vi.stubGlobal('EventSource', eventSourceConstructor);

    const client = new HttpAPIClient('http://localhost:9999');
    const callback = vi.fn();
    const unsubscribe = client.onFileChange(callback);

    expect(eventSourceConstructor).toHaveBeenCalledOnce();
    expect(eventSourceConstructor).toHaveBeenCalledWith('http://localhost:9999/api/events');
    expect(eventSource.addEventListener).toHaveBeenCalledWith('file-change', expect.any(Function));

    const event = { path: '/tmp/file.txt', type: 'change' };
    eventSource.emit('file-change', event);
    expect(callback).toHaveBeenCalledWith(event);

    unsubscribe();
    eventSource.emit('file-change', event);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('supports Node and SSR runtimes without constructing EventSource', () => {
    vi.stubGlobal('EventSource', undefined);

    expect(() => {
      const client = new HttpAPIClient('http://localhost:9999');
      const unsubscribe = client.onFileChange(vi.fn());
      unsubscribe();
    }).not.toThrow();
  });
});
