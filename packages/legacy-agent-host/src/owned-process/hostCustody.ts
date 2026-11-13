/** Closed private Main/Host custody transport. This module grants no native process authority. */
import { z } from 'zod';

import type { HostLimits, RpcRequest } from '../contracts.js';

export const HOST_CUSTODY_METHOD = 'host.native-custody';
export const HOST_CUSTODY_BIND_METHOD = 'host.native-custody.bind';
export const HOST_CUSTODY_READY_METHOD = 'host.native-custody.ready';
export const HOST_CUSTODY_CAPABILITY = 'transport.native-custody-v1';
export const HOST_CUSTODY_CHUNK_BYTES = 16 * 1024;
export const HOST_CUSTODY_FRAME_BYTES = 32 * 1024;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const stream = z.enum(['stdout', 'stderr']);
const bytes = z
  .string()
  .max(4 * Math.ceil(HOST_CUSTODY_CHUNK_BYTES / 3))
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length <= HOST_CUSTODY_CHUNK_BYTES && decoded.toString('base64') === value;
  });
export const hostCustodyBindingSchema = z
  .object({
    mainEpoch: ref,
    hostIncarnation: ref,
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type HostCustodyBinding = z.infer<typeof hostCustodyBindingSchema>;

const callSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read'), capability: ref, stream }).strict(),
  z.object({ operation: z.literal('write'), capability: ref, bytes }).strict(),
  z.object({ operation: z.literal('end'), capability: ref }).strict(),
  z.object({ operation: z.literal('observe'), capability: ref }).strict(),
  z
    .object({
      operation: z.literal('stop'),
      capability: ref,
      attemptRef: ref,
      budgetMs: z.number().int().min(0).max(30_000),
    })
    .strict(),
  z.object({ operation: z.literal('release'), capability: ref, receiptRef: ref }).strict(),
]);
export type HostCustodyCall = z.infer<typeof callSchema>;
const resultSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('read'),
      state: z.enum(['data', 'empty', 'eof']),
      bytes,
      more: z.boolean(),
    })
    .strict()
    .refine((value) =>
      value.state === 'data' ? value.bytes.length > 0 : value.bytes === '' && !value.more
    ),
  z.object({ operation: z.literal('write'), state: z.literal('completed') }).strict(),
  z.object({ operation: z.literal('end'), state: z.literal('completed') }).strict(),
  // Root exit is deliberately not a tree-cleanup receipt.
  z
    .object({ operation: z.literal('observe'), root: z.enum(['running', 'exited', 'unknown']) })
    .strict(),
  z
    .object({
      operation: z.literal('stop'),
      state: z.enum(['confirmed', 'unknown']),
      receiptRef: ref.optional(),
    })
    .strict()
    .refine((value) => (value.state === 'confirmed') === (value.receiptRef !== undefined)),
  z.object({ operation: z.literal('release'), state: z.enum(['released', 'unknown']) }).strict(),
]);
export type HostCustodyResult = z.infer<typeof resultSchema>;
const replySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('refused') }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('completed'), value: resultSchema }).strict(),
]);
export type HostCustodyReply = z.infer<typeof replySchema>;
export const hostCustodyRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string(),
    method: z.literal(HOST_CUSTODY_METHOD),
    params: z.object({ binding: hostCustodyBindingSchema, call: callSchema }).strict(),
  })
  .strict();
const responseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string(),
    result: z.object({ binding: hostCustodyBindingSchema, reply: replySchema }).strict(),
  })
  .strict();
export const hostCustodyHintSchema = z.object({ capability: ref, stream }).strict();
export type HostCustodyHint = z.infer<typeof hostCustodyHintSchema>;
const readySchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal(HOST_CUSTODY_READY_METHOD),
    params: z.object({ binding: hostCustodyBindingSchema, hint: hostCustodyHintSchema }).strict(),
  })
  .strict();

/** A pre-existing physical owner supplies this port; sealing its Host does not dispose that owner. */
export interface HostCustodyOwner {
  readonly mainEpoch: string;
  attach(
    context: Readonly<{
      binding: HostCustodyBinding;
      profileId: string;
      signal: AbortSignal;
      /** Resolves only from close of the original captured Host child. */
      hostExited: Promise<void>;
    }>
  ): HostCustodyPort;
}
export interface HostCustodyPort {
  /** Recheck the attached epoch before dispatch after every await. Keep admitted effects after signal abort. */
  handle(call: HostCustodyCall): HostCustodyResult | Promise<HostCustodyResult>;
  /** Replay current buffered-readable/EOF state on subscription, then report new readiness. */
  onReadable(observer: (hint: HostCustodyHint) => void): () => void;
}
export function sameHostCustodyBinding(a: HostCustodyBinding, b: HostCustodyBinding): boolean {
  return (
    a.mainEpoch === b.mainEpoch &&
    a.hostIncarnation === b.hostIncarnation &&
    a.profileDigest === b.profileDigest
  );
}
export function hostCustodyControl(call: HostCustodyCall): boolean {
  return call.operation !== 'read' && call.operation !== 'write' && call.operation !== 'end';
}
export function hostCustodySequence(
  id: string,
  incarnation: string,
  control: boolean
): bigint | undefined {
  const prefix = `custody:${incarnation}:${control ? 'control' : 'work'}:`;
  if (!id.startsWith(prefix)) return;
  const value = id.slice(prefix.length);
  if (!/^[1-9][0-9]{0,19}$/.test(value)) return;
  const number = BigInt(value);
  return number <= MAX_SEQUENCE ? number : undefined;
}
export function validateHostCustodyResult(
  call: HostCustodyCall,
  value: unknown
): HostCustodyResult {
  const result = resultSchema.safeParse(value);
  if (!result.success || result.data.operation !== call.operation)
    throw new Error('Invalid private custody result');
  return result.data;
}

/** Only the closed operation family is available. There is no arbitrary reverse RPC method. */
export class HostCustodyClient {
  private binding?: HostCustodyBinding;
  private sealed = false;
  private next = 1n;
  private readonly pending = new Map<
    string,
    {
      call: HostCustodyCall;
      finish: (reply: HostCustodyReply) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly observers = new Set<(hint: HostCustodyHint) => void>();
  private readonly hints = new Map<string, HostCustodyHint>();

  constructor(
    private readonly options: {
      hostIncarnation: string;
      limits: HostLimits;
      timeoutMs: number;
      send(frame: RpcRequest, control: boolean): boolean;
    }
  ) {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 30_000
    )
      throw new Error('Invalid private custody timeout');
  }

  bind(value: unknown): boolean {
    const parsed = hostCustodyBindingSchema.safeParse(value);
    if (
      this.sealed ||
      this.binding ||
      !parsed.success ||
      parsed.data.hostIncarnation !== this.options.hostIncarnation
    )
      return false;
    this.binding = Object.freeze(parsed.data);
    return true;
  }

  request(value: HostCustodyCall): Promise<HostCustodyReply> {
    const parsed = callSchema.safeParse(value);
    if (this.sealed || !this.binding || !parsed.success || this.next > MAX_SEQUENCE)
      return Promise.resolve({ status: 'refused' });
    const call = parsed.data;
    const control = hostCustodyControl(call);
    const { limits } = this.options;
    const capacity = limits.maxPendingRequests - (control ? 0 : limits.reservedControlRequests);
    if (this.pending.size >= capacity) return Promise.resolve({ status: 'refused' });
    if (
      call.operation === 'read' &&
      [...this.pending.values()].some(
        ({ call: other }) =>
          other.operation === 'read' &&
          other.capability === call.capability &&
          other.stream === call.stream
      )
    )
      return Promise.resolve({ status: 'refused' });
    const id = `custody:${this.binding.hostIncarnation}:${control ? 'control' : 'work'}:${this.next++}`;
    const hintKey = call.operation === 'read' ? `${call.capability}:${call.stream}` : undefined;
    const admittedHint = hintKey ? this.hints.get(hintKey) : undefined;
    const frame: RpcRequest = {
      jsonrpc: '2.0',
      id,
      method: HOST_CUSTODY_METHOD,
      params: { binding: this.binding, call },
    };
    return new Promise((resolve) => {
      const finish = (reply: HostCustodyReply) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (reply.status === 'completed' && hintKey && this.hints.get(hintKey) === admittedHint)
          this.hints.delete(hintKey);
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ status: 'unknown' }), this.options.timeoutMs);
      this.pending.set(id, { call, finish, timer });
      if (!this.options.send(frame, control)) finish({ status: 'unknown' });
    });
  }

  onReadable(observer: (hint: HostCustodyHint) => void): () => void {
    if (this.sealed || this.observers.size >= this.options.limits.maxPendingRequests)
      throw new Error('Private custody observer unavailable');
    this.observers.add(observer);
    for (const hint of this.hints.values()) observer(hint);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** Returns false only for an ordinary Host request. Malformed private frames fail the transport. */
  receive(value: unknown, frameBytes: number): boolean {
    const candidate = value as { id?: unknown; method?: unknown } | null;
    if (candidate?.method === HOST_CUSTODY_READY_METHOD) {
      const ready = readySchema.safeParse(value);
      if (frameBytes > HOST_CUSTODY_FRAME_BYTES || !ready.success)
        throw new Error('Invalid private custody readiness');
      if (
        !this.sealed &&
        this.binding &&
        sameHostCustodyBinding(this.binding, ready.data.params.binding)
      ) {
        const hint = ready.data.params.hint;
        const key = `${hint.capability}:${hint.stream}`;
        const previous = this.hints.get(key);
        if (!previous) {
          if (this.hints.size >= this.options.limits.maxPendingRequests)
            throw new Error('Private custody readiness capacity');
        }
        // A pending read can acknowledge only the marker it actually observed.
        this.hints.set(key, hint);
        if (!previous) for (const observer of this.observers) observer(hint);
      }
      return true;
    }
    if (typeof candidate?.id !== 'string' || !candidate.id.startsWith('custody:')) return false;
    const pending = this.pending.get(candidate.id);
    if (!pending) return true; // Old, retired or timed-out reply cannot finish a different request/epoch.
    const response = responseSchema.safeParse(value);
    if (
      frameBytes > HOST_CUSTODY_FRAME_BYTES ||
      !response.success ||
      !this.binding ||
      !sameHostCustodyBinding(this.binding, response.data.result.binding)
    )
      throw new Error('Invalid private custody response');
    const reply = response.data.result.reply;
    if (reply.status === 'completed') validateHostCustodyResult(pending.call, reply.value);
    pending.finish(reply);
    return true;
  }

  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    for (const pending of this.pending.values()) pending.finish({ status: 'unknown' });
    this.observers.clear();
    this.hints.clear();
  }
}
