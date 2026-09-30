import type { HostedCoordinationResyncReason, ReplayCursor } from '../../../../contracts';

export interface HostedCoordinationHttpSocket {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

export interface HostedCoordinationHttpRawRequest {
  readonly aborted: boolean;
  readonly destroyed: boolean;
  readonly socket: HostedCoordinationHttpSocket;
  once(event: 'aborted', listener: () => void): unknown;
  removeListener(event: 'aborted', listener: () => void): unknown;
}

export interface HostedCoordinationHttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly query: unknown;
  readonly raw: HostedCoordinationHttpRawRequest;
}

export interface HostedCoordinationHttpRawReply {
  readonly destroyed: boolean;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  destroy(): unknown;
  end(): unknown;
  flushHeaders(): unknown;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  write(frame: string): boolean;
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown;
}

export interface HostedCoordinationHttpReply {
  readonly sent: boolean;
  readonly raw: HostedCoordinationHttpRawReply;
  code(statusCode: number): HostedCoordinationHttpReply;
  hijack(): void;
  send(payload: unknown): unknown;
}

export interface HostedCoordinationHttpApplication {
  get(
    route: string,
    handler: (
      request: HostedCoordinationHttpRequest,
      reply: HostedCoordinationHttpReply
    ) => Promise<void>
  ): void;
}

const MAX_CURSOR_LENGTH = 2_048;

function exactHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function headerContainsMediaType(value: string | null, mediaType: string): boolean {
  return (
    value
      ?.split(',')
      .some((candidate) => candidate.split(';', 1)[0]?.trim().toLowerCase() === mediaType) ?? false
  );
}

function exactRefererOrigin(value: string | null, allowedOrigin: string): boolean {
  if (value === null) return false;
  try {
    return new URL(value).origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function admitsSameOriginEventSource(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  allowedOrigin: string
): boolean {
  const origin = exactHeader(headers.origin);
  if (origin !== null) return origin === allowedOrigin;

  // Native same-origin EventSource omits Origin and, under `no-referrer`, also
  // Referer. Fetch Metadata headers are browser-controlled, so require their
  // exact SSE shape instead of weakening the route to any cookie-bearing GET.
  // If a Referer is present despite policy, it must still be same-origin.
  const referer = exactHeader(headers.referer);
  return (
    exactHeader(headers['sec-fetch-site']) === 'same-origin' &&
    exactHeader(headers['sec-fetch-mode']) === 'cors' &&
    exactHeader(headers['sec-fetch-dest']) === 'empty' &&
    headerContainsMediaType(exactHeader(headers.accept), 'text/event-stream') &&
    (referer === null || exactRefererOrigin(referer, allowedOrigin))
  );
}

export function initialCursor(request: HostedCoordinationHttpRequest): string | null {
  const reconnectCursor = exactHeader(request.headers['last-event-id']);
  if (reconnectCursor !== null) return reconnectCursor;
  const query = request.query as { readonly after?: unknown } | null;
  return typeof query?.after === 'string' ? query.after : null;
}

export function boundedCursor(value: string | null): value is ReplayCursor {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

export function resyncReason(error: unknown): HostedCoordinationResyncReason | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  switch (code) {
    case 'invalid_replay_cursor':
    case 'unsupported_replay_cursor_version':
      return 'malformed_cursor';
    case 'replay_cursor_deployment_mismatch':
      return 'foreign_deployment';
    case 'replay_cursor_epoch_mismatch':
      return 'foreign_epoch';
    case 'replay_cursor_stale':
      return 'cursor_expired';
    case 'replay_cursor_ahead':
      return 'cursor_ahead';
    case 'event_sequence_discontinuity':
    case 'event_cursor_mismatch':
    case 'journal_watermark_mismatch':
    case 'journal_watermark_regression':
    case 'resource_revision_discontinuity':
    case 'journal_protocol_error':
      return 'event_gap';
    default:
      return null;
  }
}

export function rawConnectionClosed(
  request: HostedCoordinationHttpRequest,
  reply: HostedCoordinationHttpReply
): boolean {
  return (
    request.raw.aborted ||
    request.raw.destroyed ||
    request.raw.socket.destroyed ||
    reply.raw.destroyed ||
    reply.raw.writableEnded
  );
}
