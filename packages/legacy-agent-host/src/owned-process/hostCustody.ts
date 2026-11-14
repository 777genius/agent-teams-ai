/** Closed private Main/Host custody transport. This module grants no native process authority. */
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { runtimeSourceProcessOriginSchema } from '../composition/runtimeSourceProcessOrigin.js';

import { MAX_LAUNCH_BYTES } from './codec.js';
import { hostServiceCallSchemas, hostServiceResultSchemas, isHostServiceCall,
  validateServiceOutcome } from './retainedServiceContracts.js';

import type { HostLimits, RpcRequest } from '../contracts.js';

export const HOST_CUSTODY_METHOD = 'host.native-custody';
export const HOST_CUSTODY_BIND_METHOD = 'host.native-custody.bind';
export const HOST_CUSTODY_READY_METHOD = 'host.native-custody.ready';
export const HOST_CUSTODY_SHUTDOWN_METHOD = 'host.native-custody.prepare-shutdown';
export const HOST_CUSTODY_CAPABILITY = 'transport.native-custody-v1';
export const HOST_CUSTODY_CHUNK_BYTES = 16 * 1024;
export const HOST_CUSTODY_FRAME_BYTES = 32 * 1024;
/** Main retains at most this many allocations, each with state/stdout/stderr readiness. */
export const HOST_CUSTODY_MAX_ALLOCATIONS = 320;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const stream = z.enum(['stdout', 'stderr']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const root = z.object({ pid: z.number().int().min(1).max(0x7fffffff), birth: z.string().regex(/^[a-f0-9]{16}$/) }).strict();
const owner = z.object({ teamIncarnation: ref, runId: ref, laneId: ref,
  processGeneration: z.string().uuid() }).strict();
const treeReceipt = z.object({ owner, attemptId: ref, coverage: z.enum(['job-membership', 'no-local-dispatch']),
  rootExited: z.boolean(), proofDigest: hash }).strict();
/** Existing native preparation15s plus resume5s, including the bounded transport staging. */
export const HOST_CUSTODY_LAUNCH_MS = 20_000;
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
  ...hostServiceCallSchemas,
  z.object({ operation: z.literal('allocate'), capability: ref, owner, brokerRef: hash,
    executableSha256: hash, launchSha256: hash, launchBytes: z.number().int().min(1).max(MAX_LAUNCH_BYTES),
    runtimeSourceOrigin: runtimeSourceProcessOriginSchema.optional(),
    budgetMs: z.number().int().min(0).max(HOST_CUSTODY_LAUNCH_MS) }).strict(),
  z.object({ operation: z.literal('launch-chunk'), capability: ref, offset: z.number().int().min(0).max(MAX_LAUNCH_BYTES), bytes }).strict(),
  z.object({ operation: z.literal('launch-commit'), capability: ref }).strict(),
  z.object({ operation: z.literal('prepare'), capability: ref }).strict(),
  z.object({ operation: z.literal('resume'), capability: ref }).strict(),
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
  z.object({ operation: z.literal('drain'), capability: ref, budgetMs: z.number().int().min(0).max(3000) }).strict(),
]);
export type HostCustodyCall = z.infer<typeof callSchema>;
const resultSchema = z.discriminatedUnion('operation', [
  ...hostServiceResultSchemas,
  z.object({ operation: z.literal('allocate'), state: z.literal('allocated') }).strict(),
  z.object({ operation: z.literal('launch-chunk'), offset: z.number().int().min(0).max(MAX_LAUNCH_BYTES) }).strict(),
  z.object({ operation: z.literal('launch-commit'), state: z.literal('committed') }).strict(),
  z.object({ operation: z.literal('prepare'), root }).strict(),
  z.object({ operation: z.literal('resume'), state: z.literal('running') }).strict(),
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
    .object({ operation: z.literal('observe'), root: z.enum(['running', 'exited', 'unknown']),
      exit: z.object({ code: z.number().int().min(0).max(0xffffffff), birth: root.shape.birth }).strict().optional(),
      transportFailed: z.boolean().optional() })
    .strict(),
  z
    .object({
      operation: z.literal('stop'),
      state: z.enum(['confirmed', 'unknown']),
      receiptRef: ref.optional(),
      receipt: treeReceipt.optional(),
    })
    .strict()
    .refine((value) => (value.state === 'confirmed') === (value.receiptRef !== undefined)),
  z.object({ operation: z.literal('release'), state: z.enum(['released', 'unknown']) }).strict(),
  z.object({ operation: z.literal('drain'), state: z.enum(['complete', 'incomplete']) }).strict(),
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
    params: z.object({ binding: hostCustodyBindingSchema, call: callSchema,
      remainingMs: z.number().int().min(1).max(30_000) }).strict(),
  })
  .strict();
const responseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string(),
    result: z.object({ binding: hostCustodyBindingSchema, reply: replySchema }).strict(),
  })
  .strict();
export const hostCustodyHintSchema = z.object({ capability: ref, stream: z.enum(['stdout', 'stderr', 'state']) }).strict();
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
  onReadable(observer: (hint: HostCustodyHint) => boolean): () => void;
  /** Reconsider already-buffered readiness after the shared transport regains capacity. */
  resumeReadable?(): void;
  /** Graceful cleanup keeps original controls/reads; no new input or allocation is admitted. */
  sealInput?(): void;
}
export function sameHostCustodyBinding(a: HostCustodyBinding, b: HostCustodyBinding): boolean {
  return (
    a.mainEpoch === b.mainEpoch &&
    a.hostIncarnation === b.hostIncarnation &&
    a.profileDigest === b.profileDigest
  );
}
export function hostCustodyControl(call: Pick<HostCustodyCall, 'operation'>): boolean {
  return ['observe', 'stop', 'drain', 'release', 'service-query', 'service-stop',
    'service-settle', 'service-lookup'].includes(call.operation);
}
export function hostCustodyCleanup(call: Pick<HostCustodyCall, 'operation'>): boolean {
  return ['read', 'observe', 'stop', 'drain', 'release', 'service-query', 'service-stop',
    'service-settle', 'service-lookup'].includes(call.operation);
}
export function hostCustodyHintKey(call: HostCustodyCall): string | undefined {
  return call.operation === 'read' ? `${call.capability}:${call.stream}`
    : call.operation === 'observe' ? `${call.capability}:state` : undefined;
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
  if (isHostServiceCall(call)) {
    if (!('outcome' in result.data)) throw new Error('Invalid private service result');
    validateServiceOutcome(call, result.data.outcome);
  }
  return result.data;
}

interface NativeAdmission {
  readonly operation: HostCustodyCall['operation'];
  readonly build: (deadlineMs: number) => HostCustodyCall;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  finish(reply: HostCustodyReply): void;
}

/** Only the closed operation family is available. There is no arbitrary reverse RPC method. */
export class HostCustodyClient {
  private binding?: HostCustodyBinding;
  private sealed = false;
  private inputSealed = false;
  private next = 1n;
  private admitting = false;
  private readonly admissions: { work: NativeAdmission[]; control: NativeAdmission[] } = { work: [], control: [] };
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
      canSend?(control: boolean): boolean;
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

  matchesBinding(value: unknown): boolean {
    const parsed = hostCustodyBindingSchema.safeParse(value);
    return !this.sealed && !!this.binding && parsed.success &&
      sameHostCustodyBinding(this.binding, parsed.data);
  }

  /** Private immutable metadata only; native authority stays with the original Main owner. */
  originalBinding(): Readonly<HostCustodyBinding> {
    if (this.sealed || !this.binding) throw new Error('Original private custody binding unavailable');
    return this.binding;
  }

  request(value: HostCustodyCall, deadlineMs?: number): Promise<HostCustodyReply> {
    const parsed = callSchema.safeParse(value);
    return parsed.success
      ? this.requestWhenReady(parsed.data.operation, () => parsed.data, deadlineMs)
      : Promise.resolve({ status: 'refused' });
  }

  /** Only references wait here. The builder receives the fixed deadline after queueing and timeout clamping. */
  requestWhenReady(
    operation: HostCustodyCall['operation'],
    build: (deadlineMs: number) => HostCustodyCall,
    deadlineMs?: number
  ): Promise<HostCustodyReply> {
    const now = performance.now();
    const deadline = Math.min(deadlineMs ?? now + this.options.timeoutMs, now + this.options.timeoutMs);
    const queued = this.admissions.control.length + this.admissions.work.length;
    if (this.sealed || !this.binding || this.next > MAX_SEQUENCE ||
      (this.inputSealed && !hostCustodyCleanup({ operation })) ||
      !Number.isFinite(deadline) || deadline <= now || queued + this.pending.size >= 6 * 256)
      return Promise.resolve({ status: 'refused' });
    const lane = hostCustodyControl({ operation }) ? this.admissions.control : this.admissions.work;
    return new Promise((resolve) => {
      let settled = false;
      const admission: NativeAdmission = {
        operation, build, deadline,
        timer: setTimeout(() => admission.finish({ status: 'refused' }), deadline - now),
        finish: (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(admission.timer);
          const index = lane.indexOf(admission);
          if (index >= 0) lane.splice(index, 1);
          resolve(reply);
          this.resumeAdmission();
        },
      };
      lane.push(admission);
      this.resumeAdmission();
    });
  }

  /** Called when the original output write frees shared bytes, or a reply frees a request slot. */
  resumeAdmission(): void {
    if (this.admitting || this.sealed) return;
    this.admitting = true;
    try {
      for (;;) {
        const lane = this.admissions.control.length ? this.admissions.control : this.admissions.work;
        const admission = lane[0];
        if (!admission) return;
        const control = hostCustodyControl(admission);
        const capacity = this.options.limits.maxPendingRequests -
          (control ? 0 : this.options.limits.reservedControlRequests);
        if (admission.deadline <= performance.now() ||
          (this.inputSealed && !hostCustodyCleanup(admission))) {
          admission.finish({ status: 'refused' });
          continue;
        }
        if (this.pending.size >= capacity || this.options.canSend?.(control) === false) return;
        lane.shift();
        clearTimeout(admission.timer);
        let parsed: ReturnType<typeof callSchema.safeParse>;
        try { parsed = callSchema.safeParse(admission.build(admission.deadline)); }
        catch { admission.finish({ status: 'refused' }); continue; }
        if (!parsed.success || parsed.data.operation !== admission.operation) {
          admission.finish({ status: 'refused' }); continue;
        }
        // dispatch rechecks the original deadline after the lazy builder, without extending it.
        void this.dispatch(parsed.data, admission.deadline).then(admission.finish);
      }
    } finally { this.admitting = false; }
  }

  private dispatch(call: HostCustodyCall, deadline: number): Promise<HostCustodyReply> {
    if (this.sealed || !this.binding || this.next > MAX_SEQUENCE ||
      (this.inputSealed && !hostCustodyCleanup(call)))
      return Promise.resolve({ status: 'refused' });
    const remaining = Math.floor(deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining <= 0) return Promise.resolve({ status: 'refused' });
    const control = hostCustodyControl(call);
    if (call.operation === 'read' && [...this.pending.values()].some(({ call: other }) =>
      other.operation === 'read' && other.capability === call.capability && other.stream === call.stream))
      return Promise.resolve({ status: 'refused' });
    const id = `custody:${this.binding.hostIncarnation}:${control ? 'control' : 'work'}:${this.next++}`;
    const hintKey = hostCustodyHintKey(call);
    const admittedHint = hintKey ? this.hints.get(hintKey) : undefined;
    const wireCall = call.operation === 'allocate' ? (() => {
      const { runtimeSourceOrigin, ...original } = call;
      return runtimeSourceOrigin === undefined ? original : { ...original, runtimeSourceOrigin };
    })() : call;
    const frame: RpcRequest = {
      jsonrpc: '2.0', id, method: HOST_CUSTODY_METHOD, params: { binding: this.binding, call: wireCall, remainingMs: remaining },
    };
    return new Promise((resolve) => {
      let returned = false;
      const settle = (reply: HostCustodyReply) => {
        if (!returned) { returned = true; resolve(reply); }
      };
      const finish = (reply: HostCustodyReply) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (reply.status === 'completed' && hintKey) {
          const current = this.hints.get(hintKey);
          if (current === admittedHint) this.hints.delete(hintKey);
          else if (current) for (const observer of this.observers) observer(current);
        }
        if (reply.status === 'completed' && reply.value.operation === 'release' && reply.value.state === 'released')
          for (const key of this.hints.keys()) if (key.startsWith(`${call.capability}:`)) this.hints.delete(key);
        settle(reply);
        this.resumeAdmission();
      };
      // A caller timeout is not an ACK: retain its slot, ID and marker until the original reply.
      const expire = () => settle({ status: 'unknown' });
      const timer = setTimeout(expire, remaining);
      this.pending.set(id, { call, finish, timer });
      try { if (!this.options.send(frame, control)) finish({ status: 'refused' }); }
      catch { expire(); }
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
          if (this.hints.size >= HOST_CUSTODY_MAX_ALLOCATIONS * 3)
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
    for (const admission of [...this.admissions.control, ...this.admissions.work])
      admission.finish({ status: 'refused' });
    this.observers.clear();
    this.hints.clear();
  }

  sealInput(): void {
    this.inputSealed = true;
    for (const admission of [...this.admissions.control, ...this.admissions.work])
      if (!hostCustodyCleanup(admission)) admission.finish({ status: 'refused' });
    this.resumeAdmission();
  }
}
