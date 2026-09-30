import type { HostedHttpReply } from '../../../../core/domain';

const abandonedReplies = new WeakSet<HostedHttpReply>();

export function isHostedReplyWritable(reply: HostedHttpReply): boolean {
  return (
    !reply.sent &&
    reply.raw.headersSent !== true &&
    reply.raw.writableEnded !== true &&
    reply.raw.destroyed !== true &&
    reply.raw.closed !== true
  );
}

export function abandonHostedReply(reply: HostedHttpReply): void {
  if (abandonedReplies.has(reply)) return;
  abandonedReplies.add(reply);
  reply.hijack?.();
}

export function continueHostedReplyIfWritable(reply: HostedHttpReply): boolean {
  if (isHostedReplyWritable(reply)) return true;
  abandonHostedReply(reply);
  return false;
}

export function sendIfWritable(
  reply: HostedHttpReply,
  statusCode: number,
  payload?: unknown
): unknown {
  if (!continueHostedReplyIfWritable(reply)) return undefined;
  return reply.code(statusCode).send(payload);
}
