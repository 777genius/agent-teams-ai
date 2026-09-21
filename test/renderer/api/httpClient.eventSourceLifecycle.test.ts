import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, describe, expect, it, vi } from 'vitest';
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener = vi.fn((channel: string, listener: EventListener) => {
    const listeners = this.listeners.get(channel) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  });

  removeEventListener = vi.fn((channel: string, listener: EventListener) => {
    const listeners = this.listeners.get(channel);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(channel);
  });

  emit(channel: string, data: unknown): void {
    const event = new MessageEvent(channel, { data: JSON.stringify(data) });
    this.listeners.get(channel)?.forEach((listener) => listener(event));
  }
}

describe('HttpAPIClient EventSource lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares a native SSE listener, removes it after the final unsubscribe, and resubscribes', () => {
    const eventSource = new FakeEventSource();
    const eventSourceConstructor = vi.fn(() => eventSource);
    vi.stubGlobal('EventSource', eventSourceConstructor);

    const client = new HttpAPIClient('http://localhost:9999');
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const unsubscribeFirst = client.onFileChange(firstCallback);
    const unsubscribeSecond = client.onFileChange(secondCallback);

    expect(eventSourceConstructor).toHaveBeenCalledOnce();
    expect(eventSourceConstructor).toHaveBeenCalledWith('http://localhost:9999/api/events');
    expect(eventSource.addEventListener).toHaveBeenCalledWith('file-change', expect.any(Function));
    expect(eventSource.addEventListener).toHaveBeenCalledOnce();

    const event = { path: '/tmp/file.txt', type: 'change' };
    eventSource.emit('file-change', event);
    expect(firstCallback).toHaveBeenCalledWith(event);
    expect(secondCallback).toHaveBeenCalledWith(event);

    unsubscribeFirst();
    expect(eventSource.removeEventListener).not.toHaveBeenCalled();
    eventSource.emit('file-change', event);
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
    expect(eventSource.removeEventListener).toHaveBeenCalledWith('file-change', expect.any(Function));
    eventSource.emit('file-change', event);
    expect(secondCallback).toHaveBeenCalledTimes(2);

    const resubscribedCallback = vi.fn();
    const unsubscribeResubscribed = client.onFileChange(resubscribedCallback);
    expect(eventSource.addEventListener).toHaveBeenCalledTimes(2);
    eventSource.onerror?.(); // Native EventSource reconnect keeps its listeners installed.
    eventSource.emit('file-change', event);
    expect(resubscribedCallback).toHaveBeenCalledWith(event);
    unsubscribeResubscribed();
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
