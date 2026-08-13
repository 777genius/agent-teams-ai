import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH,
  type HostedMessagePage,
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
  type SendHostedTeamMessageResult,
} from '@features/team-message-delivery/contracts/hosted';
import {
  createHostedTeamMessageTransport,
  type HostedTeamMessageFetchPort,
  HostedTeamMessagePanel,
  type HostedTeamMessageTransport,
} from '@features/team-message-delivery/renderer';
import { parseCursor, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const firstMessageId = parseHostedMessageId(`message_${'b'.repeat(32)}`);
const secondMessageId = parseHostedMessageId(`message_${'c'.repeat(32)}`);
const thirdMessageId = parseHostedMessageId(`message_${'d'.repeat(32)}`);
const clientMessageId = parseHostedClientMessageId('client_message_renderer-1');
const reboundTeamId = parseTeamId(`team_${'e'.repeat(32)}`);
const firstGeneration = parseHostedMessageSourceGeneration('generation_renderer-1');
const secondGeneration = parseHostedMessageSourceGeneration('generation_renderer-2');
const firstRevision = parseRevision('revision_renderer-1');
const secondRevision = parseRevision('revision_renderer-2');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function message(messageId: typeof firstMessageId, text: string) {
  return Object.freeze({
    teamId,
    messageId,
    direction: 'operator' as const,
    text,
    createdAtMs: 1,
  });
}

function page(
  messages: HostedMessagePage['messages'],
  generation = firstGeneration,
  revision = firstRevision,
  nextCursor: HostedMessagePage['nextCursor'] = null
): HostedMessagePage {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    kind: 'message_page',
    teamId,
    sourceGeneration: generation,
    revision,
    messages,
    nextCursor,
  });
}

function emptyPageFor(requestedTeamId: typeof teamId): HostedMessagePage {
  return Object.freeze({ ...page([]), teamId: requestedTeamId });
}

function persistedResult(requestedTeamId: typeof teamId): SendHostedTeamMessageResult {
  return Object.freeze({
    kind: 'persisted',
    receipt: Object.freeze({
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      teamId: requestedTeamId,
      messageId: firstMessageId,
      clientMessageId,
      persistence: 'durable',
      runtimeDelivery: 'pending',
    }),
  });
}

async function renderPanel(
  transport: HostedTeamMessageTransport
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedTeamMessagePanel
        createClientMessageId={() => clientMessageId}
        teamId={teamId}
        transport={transport}
      />
    );
    await Promise.resolve();
  });
  return { host, root };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (!descriptor?.set) throw new Error('HTMLTextAreaElement value setter not found');
  descriptor.set.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function composerControls(host: HTMLDivElement): {
  readonly form: HTMLFormElement;
  readonly send: HTMLButtonElement;
  readonly textarea: HTMLTextAreaElement;
} {
  const textarea = host.querySelector('textarea');
  const form = host.querySelector('form');
  const send = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Send')
  );
  if (
    !(textarea instanceof HTMLTextAreaElement) ||
    !(form instanceof HTMLFormElement) ||
    !(send instanceof HTMLButtonElement)
  ) {
    throw new Error('Hosted team message controls not found');
  }
  return Object.freeze({ form, send, textarea });
}

describe('hosted team-message renderer', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses only the injected authenticated transport for page and send requests', async () => {
    const fetch = vi
      .fn<HostedTeamMessageFetchPort>()
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(page([message(firstMessageId, 'First')])),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () =>
          Promise.resolve({
            kind: 'persisted',
            receipt: {
              schemaVersion: 1,
              teamId,
              messageId: firstMessageId,
              clientMessageId,
              persistence: 'durable',
              runtimeDelivery: 'operator_required',
            },
          }),
      });
    const transport = createHostedTeamMessageTransport({
      fetch,
      getCsrfToken: () => 'c'.repeat(32),
    });
    const pageRequest = {
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      teamId,
      cursor: null,
      expectedSourceGeneration: null,
      limit: 25,
    };
    await expect(transport.getPage(pageRequest)).resolves.toMatchObject({
      kind: 'success',
      page: { messages: [message(firstMessageId, 'First')] },
    });
    await expect(
      transport.sendMessage({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId,
        clientMessageId,
        text: 'First',
      })
    ).resolves.toMatchObject({
      kind: 'persisted',
      receipt: { persistence: 'durable', runtimeDelivery: 'operator_required' },
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
      HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH,
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'x-agent-teams-csrf': 'c'.repeat(32) },
    });
  });

  it('ignores an older page request after the transport is rebound', async () => {
    const oldLoad = deferred<{ kind: 'success'; page: HostedMessagePage }>();
    const currentLoad = deferred<{ kind: 'success'; page: HostedMessagePage }>();
    const oldTransport: HostedTeamMessageTransport = {
      getPage: () => oldLoad.promise,
      sendMessage: () => Promise.resolve({ kind: 'unavailable' as const }),
    };
    const currentTransport: HostedTeamMessageTransport = {
      getPage: () => currentLoad.promise,
      sendMessage: () => Promise.resolve({ kind: 'unavailable' as const }),
    };
    const { host, root } = await renderPanel(oldTransport);

    await act(async () => {
      root.render(<HostedTeamMessagePanel teamId={teamId} transport={currentTransport} />);
      await Promise.resolve();
    });
    await act(async () => {
      currentLoad.resolve({
        kind: 'success',
        page: page([message(secondMessageId, 'Current message')], secondGeneration, secondRevision),
      });
      await currentLoad.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Current message'));

    await act(async () => {
      oldLoad.resolve({ kind: 'success', page: page([message(firstMessageId, 'Old message')]) });
      await oldLoad.promise;
    });
    expect(host.textContent).toContain('Current message');
    expect(host.textContent).not.toContain('Old message');
    expect(host.querySelector('[title]')).toBeNull();
    act(() => root.unmount());
  });

  it('refreshes on a matching external invalidation and fences the older page response', async () => {
    const staleHttpPage = deferred<{ kind: 'success'; page: HostedMessagePage }>();
    const eventRefresh = deferred<{ kind: 'success'; page: HostedMessagePage }>();
    const getPage = vi
      .fn<HostedTeamMessageTransport['getPage']>()
      .mockReturnValueOnce(staleHttpPage.promise)
      .mockReturnValueOnce(eventRefresh.promise);
    let invalidationListener:
      | Parameters<NonNullable<HostedTeamMessageTransport['subscribeToInvalidations']>>[1]
      | null = null;
    const unsubscribe = vi.fn();
    const transport: HostedTeamMessageTransport = {
      getPage,
      sendMessage: () => Promise.resolve({ kind: 'unavailable' }),
      subscribeToInvalidations: (_subscribedTeamId, listener) => {
        invalidationListener = listener;
        return unsubscribe;
      },
    };
    const { host, root } = await renderPanel(transport);
    if (invalidationListener === null) {
      throw new Error('hosted-message-invalidation-listener-was-not-subscribed');
    }
    const emit: Parameters<
      NonNullable<HostedTeamMessageTransport['subscribeToInvalidations']>
    >[1] = invalidationListener;

    await act(async () => {
      emit({ teamId });
      await Promise.resolve();
    });
    expect(getPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleHttpPage.resolve({
        kind: 'success',
        page: page([message(firstMessageId, 'Stale HTTP message')]),
      });
      await staleHttpPage.promise;
    });
    expect(host.textContent).not.toContain('Stale HTTP message');

    await act(async () => {
      eventRefresh.resolve({
        kind: 'success',
        page: page(
          [message(secondMessageId, 'External inbox message')],
          secondGeneration,
          secondRevision
        ),
      });
      await eventRefresh.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('External inbox message'));

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('re-enables the composer and ignores a stale send after the team is rebound', async () => {
    const staleSend = deferred<SendHostedTeamMessageResult>();
    let staleSignal: AbortSignal | undefined;
    const transport: HostedTeamMessageTransport = {
      getPage: (request) =>
        Promise.resolve(
          Object.freeze({ kind: 'success' as const, page: emptyPageFor(request.teamId) })
        ),
      sendMessage: (_command, options) => {
        staleSignal = options?.signal;
        return staleSend.promise;
      },
    };
    const { host, root } = await renderPanel(transport);
    await vi.waitFor(() => expect(host.textContent).toContain('No messages yet.'));
    const composer = composerControls(host);

    await act(async () => {
      setTextareaValue(composer.textarea, 'Team rebind draft');
      await Promise.resolve();
    });
    await act(async () => {
      composer.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(composer.textarea.disabled).toBe(true));

    await act(async () => {
      root.render(
        <HostedTeamMessagePanel
          createClientMessageId={() => clientMessageId}
          teamId={reboundTeamId}
          transport={transport}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      const reboundComposer = composerControls(host);
      expect(reboundComposer.textarea.disabled).toBe(false);
      expect(reboundComposer.send.disabled).toBe(false);
      expect(reboundComposer.textarea.value).toBe('Team rebind draft');
    });
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => {
      staleSend.resolve(persistedResult(teamId));
      await staleSend.promise;
    });
    const reboundComposer = composerControls(host);
    expect(reboundComposer.textarea.disabled).toBe(false);
    expect(reboundComposer.send.disabled).toBe(false);
    expect(reboundComposer.textarea.value).toBe('Team rebind draft');
    expect(host.textContent).not.toContain('Your message was saved. Delivery is pending.');
    act(() => root.unmount());
  });

  it('re-enables the composer and ignores a stale send after the transport is rebound', async () => {
    const staleSend = deferred<SendHostedTeamMessageResult>();
    let staleSignal: AbortSignal | undefined;
    const oldTransport: HostedTeamMessageTransport = {
      getPage: () => Promise.resolve(Object.freeze({ kind: 'success' as const, page: page([]) })),
      sendMessage: (_command, options) => {
        staleSignal = options?.signal;
        return staleSend.promise;
      },
    };
    const currentTransport: HostedTeamMessageTransport = {
      getPage: () => Promise.resolve(Object.freeze({ kind: 'success' as const, page: page([]) })),
      sendMessage: () => Promise.resolve(Object.freeze({ kind: 'unavailable' as const })),
    };
    const { host, root } = await renderPanel(oldTransport);
    await vi.waitFor(() => expect(host.textContent).toContain('No messages yet.'));
    const composer = composerControls(host);

    await act(async () => {
      setTextareaValue(composer.textarea, 'Transport rebind draft');
      await Promise.resolve();
    });
    await act(async () => {
      composer.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(composer.textarea.disabled).toBe(true));

    await act(async () => {
      root.render(
        <HostedTeamMessagePanel
          createClientMessageId={() => clientMessageId}
          teamId={teamId}
          transport={currentTransport}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      const reboundComposer = composerControls(host);
      expect(reboundComposer.textarea.disabled).toBe(false);
      expect(reboundComposer.send.disabled).toBe(false);
      expect(reboundComposer.textarea.value).toBe('Transport rebind draft');
    });
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => {
      staleSend.resolve(persistedResult(teamId));
      await staleSend.promise;
    });
    const reboundComposer = composerControls(host);
    expect(reboundComposer.textarea.disabled).toBe(false);
    expect(reboundComposer.send.disabled).toBe(false);
    expect(reboundComposer.textarea.value).toBe('Transport rebind draft');
    expect(host.textContent).not.toContain('Your message was saved. Delivery is pending.');
    act(() => root.unmount());
  });

  it('preserves loaded older pages when a head refresh returns a new source generation', async () => {
    const initialCursor = parseCursor('cursor_renderer-initial');
    const refreshedCursor = parseCursor('cursor_renderer-refreshed');
    const getPage = vi
      .fn<HostedTeamMessageTransport['getPage']>()
      .mockResolvedValueOnce({
        kind: 'success',
        page: page(
          [message(firstMessageId, 'Initial message')],
          firstGeneration,
          firstRevision,
          initialCursor
        ),
      })
      .mockResolvedValueOnce({
        kind: 'success',
        page: page([message(secondMessageId, 'Older message')]),
      })
      .mockResolvedValueOnce({
        kind: 'success',
        page: page(
          [message(thirdMessageId, 'Refreshed message')],
          secondGeneration,
          secondRevision,
          refreshedCursor
        ),
      });
    const transport: HostedTeamMessageTransport = {
      getPage,
      sendMessage: () => Promise.resolve({ kind: 'unavailable' }),
    };
    const { host, root } = await renderPanel(transport);

    await vi.waitFor(() => expect(host.textContent).toContain('Initial message'));
    const loadMore = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Load more')
    );
    if (!(loadMore instanceof HTMLButtonElement)) {
      throw new Error('Load more button not found');
    }
    await act(async () => {
      loadMore.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Older message'));

    const refresh = host.querySelector('button[aria-label="Refresh messages"]');
    if (!(refresh instanceof HTMLButtonElement)) throw new Error('Refresh button not found');
    await act(async () => {
      refresh.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Refreshed message'));
    expect(
      Array.from(host.querySelectorAll('[data-testid="hosted-team-message"]')).map((element) =>
        element.getAttribute('data-message-id')
      )
    ).toEqual([thirdMessageId, firstMessageId, secondMessageId]);

    act(() => root.unmount());
  });

  it('reuses the client message ID when an unconfirmed send is retried unchanged', async () => {
    const sendMessage = vi
      .fn<HostedTeamMessageTransport['sendMessage']>()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({
        kind: 'persisted',
        receipt: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId,
          messageId: firstMessageId,
          clientMessageId,
          persistence: 'durable',
          runtimeDelivery: 'pending',
        },
      });
    const transport: HostedTeamMessageTransport = {
      getPage: () => Promise.resolve(Object.freeze({ kind: 'success' as const, page: page([]) })),
      sendMessage,
    };
    const { host, root } = await renderPanel(transport);
    await vi.waitFor(() => expect(host.textContent).toContain('No messages yet.'));
    const { form, textarea } = composerControls(host);

    await act(async () => {
      setTextareaValue(textarea, 'Retry unchanged');
      await Promise.resolve();
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(host.textContent).toContain('Try again without changing it.');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([command]) => command.clientMessageId)).toEqual([
      clientMessageId,
      clientMessageId,
    ]);
    act(() => root.unmount());
  });

  it.each([
    ['C0', 'unsafe\u0000message'],
    ['C1', 'unsafe\u0085message'],
    ['bidi', 'unsafe\u202emessage'],
  ])('rejects %s controls in the composer before calling the transport', async (_kind, draft) => {
    const sendMessage = vi.fn<HostedTeamMessageTransport['sendMessage']>();
    const transport: HostedTeamMessageTransport = {
      getPage: () => Promise.resolve(Object.freeze({ kind: 'success' as const, page: page([]) })),
      sendMessage,
    };
    const { host, root } = await renderPanel(transport);
    await vi.waitFor(() => expect(host.textContent).toContain('No messages yet.'));
    const { form, textarea } = composerControls(host);

    await act(async () => {
      setTextareaValue(textarea, draft);
      await Promise.resolve();
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Enter a short, plain-text message before sending.');
    act(() => root.unmount());
  });
});
