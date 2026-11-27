import { TextDecoder } from 'node:util';

import { HOST_CUSTODY_METHOD } from '@agent-teams/legacy-agent-host/owned-process';

import { HostClientError } from './selectedHostProfile';

import type { PendingRequest } from './CapturedHostClientState';
import type { CapturedHostNotificationBuffer } from './CapturedHostNotificationBuffer';
import type {
  HostLimits,
  JsonValue,
  RpcNotification,
} from '@agent-teams/legacy-agent-host/contracts';

export function isHostProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function acceptCapturedHostFrame(
  frame: Buffer,
  options: {
    pending: Map<string, PendingRequest>;
    notifications: CapturedHostNotificationBuffer;
    limits: HostLimits;
    receiveNative(value: unknown, frameBytes: number): void;
    fail(error: HostClientError): void;
  }
): boolean {
  try {
    const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
    if (!isHostProtocolRecord(message) || message.jsonrpc !== '2.0') throw new Error('envelope');
    if (typeof message.method === 'string' && message.method.startsWith(HOST_CUSTODY_METHOD)) {
      options.receiveNative(message, frame.length);
      return true;
    }
    if ('id' in message) {
      if (typeof message.id !== 'string' || 'result' in message === 'error' in message)
        throw new Error('response');
      if (
        'error' in message &&
        (!isHostProtocolRecord(message.error) ||
          !Number.isSafeInteger(message.error.code) ||
          typeof message.error.message !== 'string')
      )
        throw new Error('error');
      const pending = options.pending.get(message.id);
      if (!pending) return true; // Late response to a timed-out original request cannot create a new intent.
      if (frame.length > pending.maxFrameBytes) throw new Error('method response frame');
      options.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message) {
        // Only transport-owned codes establish rejection before handler admission.
        // A handler exception may follow a partial effect and must remain unknown.
        const code = (message.error as { code: number }).code;
        const rejected = [-32001, -32002, -32601, -32602].includes(code);
        pending.reject(
          new HostClientError(
            rejected ? 'remote-rejected' : 'remote-error',
            rejected ? 'rejected' : 'unknown'
          )
        );
      } else pending.resolve(message.result as JsonValue);
    } else {
      if (typeof message.method !== 'string' || !('params' in message))
        throw new Error('notification');
      options.notifications.receive(
        message as unknown as RpcNotification,
        frame.length,
        options.limits
      );
    }
    return true;
  } catch {
    options.fail(new HostClientError('protocol-error', 'unknown'));
    return false;
  }
}
