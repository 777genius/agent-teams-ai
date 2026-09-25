import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { Loader2, RefreshCw, Send } from 'lucide-react';

import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  type HostedClientMessageId,
  type HostedMessageRecipient,
  type HostedMessageSourceGeneration,
  type HostedTeamMessage,
  parseHostedClientMessageId,
  parseHostedMessageRecipient,
} from '../../contracts/hosted';
import {
  HOSTED_MESSAGE_MAX_PAGE_ITEMS,
  HOSTED_MESSAGE_MAX_TEXT_LENGTH,
  parseSendHostedTeamMessageCommand,
} from '../../core/domain/hostedMessagePolicy';

import type { HostedTeamMessageTransport } from '../ports/HostedTeamMessageRendererPorts';
import type { Cursor, Revision, TeamId } from '@shared/contracts/hosted';

const DEFAULT_PAGE_LIMIT = 25;
const SAFE_LOAD_ERROR = 'Messages are temporarily unavailable. Refresh to try again.';
const SAFE_SEND_ERROR = 'Your message was not confirmed. Try again without changing it.';
const RECIPIENT_REJECTED_ERROR = 'The selected teammate is not in this team anymore.';
/** Select value for the lead; the pattern of teammate names can never produce it. */
const LEAD_RECIPIENT_OPTION = '__lead__';

type LoadStatus = 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'error';
type SendStatus = 'idle' | 'sending' | 'error';

interface HostedTeamMessageViewState {
  readonly messages: readonly HostedTeamMessage[];
  readonly nextCursor: Cursor | null;
  readonly sourceGeneration: HostedMessageSourceGeneration | null;
  readonly revision: Revision | null;
  readonly loadStatus: LoadStatus;
  readonly sendStatus: SendStatus;
  readonly draft: string;
  readonly error: string | null;
  readonly notice: string | null;
}

interface PendingRetry {
  readonly text: string;
  readonly recipient: HostedMessageRecipient | null;
  readonly clientMessageId: HostedClientMessageId;
}

export interface HostedTeamMessagePanelProps {
  readonly teamId: TeamId;
  readonly transport: HostedTeamMessageTransport;
  readonly heading?: string;
  readonly description?: string;
  readonly pageLimit?: number;
  readonly sendEnabled?: boolean;
  /** Current teammate names that can receive a direct message. The lead is always the default. */
  readonly recipients?: readonly string[];
  readonly createClientMessageId?: () => HostedClientMessageId;
}

function initialState(): HostedTeamMessageViewState {
  return Object.freeze({
    messages: Object.freeze([]),
    nextCursor: null,
    sourceGeneration: null,
    revision: null,
    loadStatus: 'loading',
    sendStatus: 'idle',
    draft: '',
    error: null,
    notice: null,
  });
}

function defaultClientMessageId(): HostedClientMessageId {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new TypeError('hosted-team-message-client-id-unavailable');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return parseHostedClientMessageId(`client_message_${value}`);
}

function deliveryNotice(delivery: 'delivered' | 'pending' | 'operator_required'): string | null {
  if (delivery === 'operator_required') {
    return 'Your message was saved. Delivery needs an operator check and will not be resent automatically.';
  }
  return delivery === 'pending' ? 'Your message was saved. Delivery is pending.' : null;
}

function recipientOptions(names: readonly string[]): readonly HostedMessageRecipient[] {
  const options: HostedMessageRecipient[] = [];
  for (const name of names) {
    try {
      const recipient = parseHostedMessageRecipient(name);
      if (!options.includes(recipient)) options.push(recipient);
    } catch {
      // Lead aliases and names outside the hosted member pattern are not addressable.
    }
  }
  return Object.freeze(options);
}

function mergeMessages(
  preferred: readonly HostedTeamMessage[],
  remaining: readonly HostedTeamMessage[]
): readonly HostedTeamMessage[] {
  const messageIds = new Set<string>();
  const messages: HostedTeamMessage[] = [];
  for (const message of [...preferred, ...remaining]) {
    if (messageIds.has(message.messageId)) continue;
    messageIds.add(message.messageId);
    messages.push(message);
  }
  return Object.freeze(messages);
}

export const HostedTeamMessagePanel = ({
  teamId,
  transport,
  heading = 'Messages',
  description = 'Send plain-text messages and review the team conversation.',
  pageLimit = DEFAULT_PAGE_LIMIT,
  sendEnabled = true,
  recipients,
  createClientMessageId = defaultClientMessageId,
}: HostedTeamMessagePanelProps): React.JSX.Element => {
  if (
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > HOSTED_MESSAGE_MAX_PAGE_ITEMS
  ) {
    throw new TypeError('hosted-team-message-renderer-page-limit-invalid');
  }

  const headingId = useId();
  const descriptionId = useId();
  const [state, setState] = useState<HostedTeamMessageViewState>(initialState);
  const availableRecipients = useMemo(() => recipientOptions(recipients ?? []), [recipients]);
  const [recipient, setRecipient] = useState<HostedMessageRecipient | null>(null);
  // A teammate that left the roster falls back to the lead instead of failing on send.
  const selectedRecipient =
    recipient !== null && availableRecipients.includes(recipient) ? recipient : null;
  const pageEpoch = useRef(0);
  const sendEpoch = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const sendController = useRef<AbortController | null>(null);
  const pageBusy = useRef(false);
  const refreshQueued = useRef(false);
  const seenCursors = useRef(new Set<Cursor>());
  const pendingRetry = useRef<PendingRetry | null>(null);
  const currentTeamId = useRef(teamId);
  const currentTransport = useRef(transport);
  currentTeamId.current = teamId;
  currentTransport.current = transport;

  const publishLoadError = useCallback((epoch: number) => {
    if (pageEpoch.current !== epoch) return;
    pageBusy.current = false;
    pageController.current = null;
    setState((current) =>
      Object.freeze({ ...current, loadStatus: 'error', error: SAFE_LOAD_ERROR })
    );
  }, []);

  const loadFirstPage = useCallback(
    async (preserveMessages: boolean): Promise<void> => {
      let preserve = preserveMessages;
      // Each pass starts after every refresh request queued so far, so one follow-up read covers
      // all invalidations that arrived while the previous pass was in flight.
      for (;;) {
        refreshQueued.current = false;
        const epoch = pageEpoch.current + 1;
        pageEpoch.current = epoch;
        pageController.current?.abort();
        const controller = new AbortController();
        pageController.current = controller;
        pageBusy.current = true;
        seenCursors.current = new Set();
        const requestedTeamId = teamId;
        const preserveCurrent = preserve;
        setState((current) =>
          Object.freeze({
            ...current,
            messages: preserveCurrent ? current.messages : Object.freeze([]),
            nextCursor: preserveCurrent ? current.nextCursor : null,
            sourceGeneration: preserveCurrent ? current.sourceGeneration : null,
            revision: preserveCurrent ? current.revision : null,
            loadStatus: preserveCurrent && current.messages.length > 0 ? 'refreshing' : 'loading',
            error: null,
          })
        );

        try {
          const result = await transport.getPage(
            Object.freeze({
              schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
              teamId: requestedTeamId,
              cursor: null,
              expectedSourceGeneration: null,
              limit: pageLimit,
            }),
            Object.freeze({ signal: controller.signal })
          );
          if (
            pageEpoch.current !== epoch ||
            controller.signal.aborted ||
            currentTeamId.current !== requestedTeamId
          ) {
            return;
          }
          if (result.kind !== 'success' || result.page.teamId !== requestedTeamId) {
            publishLoadError(epoch);
          } else {
            pageBusy.current = false;
            pageController.current = null;
            if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
            setState((current) =>
              Object.freeze({
                ...current,
                messages: mergeMessages(
                  result.page.messages,
                  preserveCurrent ? current.messages : Object.freeze([])
                ),
                nextCursor: result.page.nextCursor,
                sourceGeneration: result.page.sourceGeneration,
                revision: result.page.revision,
                loadStatus: 'ready',
                error: null,
              })
            );
          }
        } catch {
          publishLoadError(epoch);
        }
        if (pageEpoch.current !== epoch || !refreshQueued.current) return;
        preserve = true;
      }
    },
    [pageLimit, publishLoadError, teamId, transport]
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      pageBusy.current ||
      state.nextCursor === null ||
      state.sourceGeneration === null ||
      state.revision === null
    ) {
      return;
    }
    const requestedTeamId = teamId;
    const requestCursor = state.nextCursor;
    const sourceGeneration = state.sourceGeneration;
    const revision = state.revision;
    const epoch = pageEpoch.current + 1;
    pageEpoch.current = epoch;
    const controller = new AbortController();
    pageController.current = controller;
    pageBusy.current = true;
    setState((current) => Object.freeze({ ...current, loadStatus: 'loading_more', error: null }));
    const refreshIfQueued = (): void => {
      if (pageEpoch.current === epoch && refreshQueued.current) void loadFirstPage(true);
    };

    try {
      const result = await transport.getPage(
        Object.freeze({
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: requestedTeamId,
          cursor: requestCursor,
          expectedSourceGeneration: sourceGeneration,
          limit: pageLimit,
        }),
        Object.freeze({ signal: controller.signal })
      );
      if (
        pageEpoch.current !== epoch ||
        controller.signal.aborted ||
        currentTeamId.current !== requestedTeamId
      ) {
        return;
      }
      if (result.kind === 'stale_generation') {
        pageBusy.current = false;
        void loadFirstPage(true);
        return;
      }
      if (
        result.kind !== 'success' ||
        result.page.teamId !== requestedTeamId ||
        result.page.sourceGeneration !== sourceGeneration ||
        result.page.revision !== revision ||
        (result.page.nextCursor !== null && seenCursors.current.has(result.page.nextCursor))
      ) {
        if (result.kind === 'success') {
          pageBusy.current = false;
          void loadFirstPage(true);
        } else {
          publishLoadError(epoch);
          refreshIfQueued();
        }
        return;
      }
      pageBusy.current = false;
      pageController.current = null;
      if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
      setState((current) =>
        Object.freeze({
          ...current,
          messages: mergeMessages(current.messages, result.page.messages),
          nextCursor: result.page.nextCursor,
          sourceGeneration: result.page.sourceGeneration,
          revision: result.page.revision,
          loadStatus: 'ready',
          error: null,
        })
      );
      refreshIfQueued();
    } catch {
      publishLoadError(epoch);
      refreshIfQueued();
    }
  }, [loadFirstPage, pageLimit, publishLoadError, state, teamId, transport]);

  /**
   * Invalidations can arrive faster than a page read completes. Cancelling the read each time would
   * starve the panel, so an in-flight read finishes and is followed by one fresh first-page read.
   */
  const requestRefresh = useCallback((): void => {
    if (pageBusy.current) {
      refreshQueued.current = true;
      return;
    }
    void loadFirstPage(true);
  }, [loadFirstPage]);

  useEffect(() => {
    void loadFirstPage(false);
    const subscribeToInvalidations = transport.subscribeToInvalidations;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe =
        typeof subscribeToInvalidations === 'function'
          ? subscribeToInvalidations.call(transport, teamId, (event) => {
              if (event.teamId !== teamId) return;
              requestRefresh();
            })
          : undefined;
    } catch {
      // Optional event wiring must not block the HTTP message view.
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* optional event teardown */
      }
      pageEpoch.current += 1;
      sendEpoch.current += 1;
      pageController.current?.abort();
      sendController.current?.abort();
      pageBusy.current = false;
      refreshQueued.current = false;
    };
  }, [loadFirstPage, requestRefresh, teamId, transport]);

  useEffect(() => {
    setState((current) =>
      current.sendStatus === 'sending' ? Object.freeze({ ...current, sendStatus: 'idle' }) : current
    );
  }, [teamId, transport]);

  const onDraftChange = useCallback((value: string): void => {
    if (pendingRetry.current?.text !== value) pendingRetry.current = null;
    setState((current) => Object.freeze({ ...current, draft: value, error: null }));
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!sendEnabled || state.sendStatus === 'sending') return;
      const requestedTeamId = teamId;
      const requestedTransport = transport;
      const retry = pendingRetry.current;
      let clientMessageId: HostedClientMessageId;
      try {
        clientMessageId =
          retry?.text === state.draft && retry.recipient === selectedRecipient
            ? retry.clientMessageId
            : createClientMessageId();
      } catch {
        setState((current) =>
          Object.freeze({ ...current, sendStatus: 'error', error: SAFE_SEND_ERROR })
        );
        return;
      }
      const command = parseSendHostedTeamMessageCommand({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId: requestedTeamId,
        clientMessageId,
        text: state.draft,
        ...(selectedRecipient === null ? {} : { recipient: selectedRecipient }),
      });
      if (!command.ok) {
        setState((current) =>
          Object.freeze({
            ...current,
            sendStatus: 'error',
            error: 'Enter a short, plain-text message before sending.',
          })
        );
        return;
      }
      pendingRetry.current = Object.freeze({
        text: command.value.text,
        recipient: selectedRecipient,
        clientMessageId,
      });
      const epoch = sendEpoch.current + 1;
      sendEpoch.current = epoch;
      sendController.current?.abort();
      const controller = new AbortController();
      sendController.current = controller;
      setState((current) =>
        Object.freeze({ ...current, sendStatus: 'sending', error: null, notice: null })
      );

      try {
        const result = await requestedTransport.sendMessage(
          command.value,
          Object.freeze({ signal: controller.signal })
        );
        if (
          sendEpoch.current !== epoch ||
          controller.signal.aborted ||
          currentTeamId.current !== requestedTeamId ||
          currentTransport.current !== requestedTransport
        ) {
          return;
        }
        if (result.kind !== 'persisted' && result.kind !== 'idempotent_replay') {
          const error =
            result.kind === 'invalid_request' && selectedRecipient !== null
              ? RECIPIENT_REJECTED_ERROR
              : SAFE_SEND_ERROR;
          setState((current) => Object.freeze({ ...current, sendStatus: 'error', error }));
          return;
        }
        pendingRetry.current = null;
        sendController.current = null;
        setState((current) =>
          Object.freeze({
            ...current,
            draft: '',
            sendStatus: 'idle',
            error: null,
            notice: deliveryNotice(result.receipt.runtimeDelivery),
          })
        );
        requestRefresh();
      } catch {
        if (
          sendEpoch.current !== epoch ||
          controller.signal.aborted ||
          currentTeamId.current !== requestedTeamId ||
          currentTransport.current !== requestedTransport
        ) {
          return;
        }
        setState((current) =>
          Object.freeze({ ...current, sendStatus: 'error', error: SAFE_SEND_ERROR })
        );
      }
    },
    [
      createClientMessageId,
      requestRefresh,
      selectedRecipient,
      sendEnabled,
      state.draft,
      state.sendStatus,
      teamId,
      transport,
    ]
  );

  const loading = state.loadStatus === 'loading' || state.loadStatus === 'refreshing';
  const loadingMore = state.loadStatus === 'loading_more';
  const sending = state.sendStatus === 'sending';

  return (
    <section aria-describedby={descriptionId} aria-labelledby={headingId} className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold" id={headingId}>
            {heading}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]" id={descriptionId}>
            {description}
          </p>
        </div>
        <Button
          aria-label="Refresh messages"
          disabled={loading || loadingMore}
          onClick={() => void loadFirstPage(true)}
          size="icon"
          type="button"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : ''} size={16} />
        </Button>
      </div>

      <div aria-live="polite" className="space-y-2" data-testid="hosted-team-message-list">
        {loading && state.messages.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 aria-hidden="true" className="animate-spin" size={16} /> Loading messages
          </div>
        ) : null}
        {!loading && state.messages.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No messages yet.</p>
        ) : null}
        {state.messages.map((message) => (
          <article
            className="rounded-md border border-[var(--color-border)] p-3"
            data-message-id={message.messageId}
            data-testid="hosted-team-message"
            key={message.messageId}
          >
            <p className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">
              {message.direction === 'operator' ? 'You' : 'Team'}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
          </article>
        ))}
      </div>

      {state.nextCursor !== null ? (
        <Button
          disabled={loadingMore || loading}
          onClick={() => void loadMore()}
          type="button"
          variant="outline"
        >
          {loadingMore ? <Loader2 aria-hidden="true" className="animate-spin" size={16} /> : null}
          Load more
        </Button>
      ) : null}

      {sendEnabled ? (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          {availableRecipients.length > 0 ? (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor={`${headingId}-recipient`}>
                To
              </label>
              <Select
                disabled={sending}
                onValueChange={(value) =>
                  setRecipient(
                    value === LEAD_RECIPIENT_OPTION ? null : parseHostedMessageRecipient(value)
                  )
                }
                value={selectedRecipient ?? LEAD_RECIPIENT_OPTION}
              >
                <SelectTrigger id={`${headingId}-recipient`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LEAD_RECIPIENT_OPTION}>Team lead</SelectItem>
                  {availableRecipients.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <label className="text-sm font-medium" htmlFor={`${headingId}-draft`}>
            New message
          </label>
          <Textarea
            disabled={sending}
            id={`${headingId}-draft`}
            maxLength={HOSTED_MESSAGE_MAX_TEXT_LENGTH}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Write a message"
            value={state.draft}
          />
          <div className="flex items-center justify-between gap-3">
            <p
              aria-live="polite"
              className="text-sm text-[var(--color-text-muted)]"
              role={state.error === null ? undefined : 'alert'}
            >
              {state.error ?? state.notice ?? ''}
            </p>
            <Button disabled={sending || state.draft.trim().length === 0} type="submit">
              {sending ? (
                <Loader2 aria-hidden="true" className="animate-spin" size={16} />
              ) : (
                <Send aria-hidden="true" size={16} />
              )}
              Send
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
};
