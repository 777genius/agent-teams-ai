import type { ResolvedLaunchSpec } from './contract.js';

export const HEADER_BYTES = 32;
export const MAX_LAUNCH_BYTES = 1024 * 1024;
export const MAX_CONTROL_BYTES = 4096;
export const VERSION = 1;
export const Op = Object.freeze({
  launch: 1,
  resume: 2,
  stop: 3,
  release: 4,
  serviceCapture: 5,
  serviceQuery: 6,
  serviceStop: 7,
  serviceSettle: 8,
  prepared: 101,
  resumed: 102,
  stopped: 103,
  released: 104,
  failed: 105,
  rootExit: 106,
  serviceCaptured: 107,
  serviceObserved: 108,
  serviceStopped: 109,
  serviceSettled: 110,
  serviceRefused: 111,
});
const operations = new Set<number>(Object.values(Op));
export type Frame = Readonly<{
  opcode: number;
  requestId: bigint;
  generation: string;
  payload: Buffer;
}>;
export function generationBytes(value: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid process generation');
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}
function generationString(bytes: Buffer): string {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function encodeFrame(frame: Frame): Buffer {
  if (
    !operations.has(frame.opcode) ||
    frame.requestId < 0n ||
    frame.requestId > 0xffffffffffffffffn
  ) {
    throw new Error('Invalid protocol header');
  }
  const cap = frame.opcode === Op.launch ? MAX_LAUNCH_BYTES : MAX_CONTROL_BYTES;
  if (frame.payload.length > cap) throw new Error('Protocol payload exceeds limit');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(frame.payload.length);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(frame.opcode, 6);
  header.writeBigUInt64LE(frame.requestId, 8);
  generationBytes(frame.generation).copy(header, 16);
  return Buffer.concat([header, frame.payload]);
}
/** One bounded partial frame, never an unbounded queued frame list. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  private failed = false;
  constructor(private readonly generation: string) {
    generationBytes(generation);
  }
  push(chunk: Buffer, consume: (frame: Frame) => void): void {
    if (this.failed) throw new Error('Protocol already sealed');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const needed =
          this.pending.length < HEADER_BYTES
            ? HEADER_BYTES
            : HEADER_BYTES + this.pending.readUInt32LE(0);
        const count = Math.min(needed - this.pending.length, chunk.length - offset);
        this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + count)]);
        offset += count;
        if (this.pending.length < HEADER_BYTES) continue;
        const length = this.pending.readUInt32LE(0);
        const opcode = this.pending.readUInt16LE(6);
        const generation = generationString(this.pending.subarray(16, 32));
        if (
          this.pending.readUInt16LE(4) !== VERSION ||
          !operations.has(opcode) ||
          generation !== this.generation.toLowerCase() ||
          length > (opcode === Op.launch ? MAX_LAUNCH_BYTES : MAX_CONTROL_BYTES)
        ) {
          throw new Error('Invalid protocol frame');
        }
        if (this.pending.length === HEADER_BYTES + length) {
          const complete = this.pending;
          this.pending = Buffer.alloc(0);
          consume({
            opcode,
            generation,
            requestId: complete.readBigUInt64LE(8),
            payload: complete.subarray(HEADER_BYTES),
          });
        }
      }
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }
  end(): void {
    if (this.pending.length || this.failed) throw new Error('Truncated or sealed protocol');
  }
}
function validateWireString(value: string): void {
  if (
    value.includes('\0') ||
    value.length > 32767 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  ) {
    throw new Error('Invalid launch string');
  }
}
function wireString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf16le');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function encodeLaunch(spec: ResolvedLaunchSpec): Buffer {
  if (
    !/^(?:[a-z]:\\|\\\\)/i.test(spec.executable) ||
    !/^(?:[a-z]:\\|\\\\)/i.test(spec.cwd) ||
    !spec.commandLine ||
    spec.environment.length > 4096
  ) {
    throw new Error('Unsupported Windows launch shape');
  }
  const names = new Set<string>();
  let totalBytes = 4; // environment count
  for (const value of [spec.executable, spec.commandLine, spec.cwd, ...spec.environment]) {
    validateWireString(value);
    totalBytes += 4 + value.length * 2;
    if (totalBytes > MAX_LAUNCH_BYTES) throw new Error('Launch payload exceeds limit');
  }
  for (const entry of spec.environment) {
    const split = entry.indexOf('=');
    const key = entry.slice(0, split).toUpperCase();
    if (split < 1 || names.has(key)) throw new Error('Invalid or duplicate environment name');
    names.add(key);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(spec.environment.length);
  const payload = Buffer.concat([
    wireString(spec.executable),
    wireString(spec.commandLine),
    wireString(spec.cwd),
    count,
    ...[...spec.environment]
      .sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), 'en'))
      .map(wireString),
  ]);
  if (payload.length > MAX_LAUNCH_BYTES) throw new Error('Launch payload exceeds limit');
  return payload;
}

/** Decode only the existing bounded launch format; re-encoding checks every native field rule. */
export function decodeLaunch(payload: Buffer): ResolvedLaunchSpec {
  if (payload.length > MAX_LAUNCH_BYTES) throw new Error('Launch payload exceeds limit');
  let offset = 0;
  const integer = () => {
    if (offset + 4 > payload.length) throw new Error('Truncated launch');
    const value = payload.readUInt32LE(offset); offset += 4; return value;
  };
  const string = () => {
    const length = integer();
    if (length % 2 || length > 65534 || offset + length > payload.length)
      throw new Error('Invalid launch string');
    const value = payload.toString('utf16le', offset, offset + length); offset += length;
    return value;
  };
  const executable = string(), commandLine = string(), cwd = string(), count = integer();
  if (count > 4096) throw new Error('Invalid launch environment');
  const environment = Array.from({ length: count }, string);
  if (offset !== payload.length) throw new Error('Unexpected launch bytes');
  const spec = Object.freeze({ executable, commandLine, cwd, environment: Object.freeze(environment) });
  if (!encodeLaunch(spec).equals(payload)) throw new Error('Noncanonical launch bytes');
  return spec;
}

/** Private original-scope wire facts. These values are not native authority or a TreeReceipt. */
export type ServiceScopeIdentity = Readonly<{ key: string; birth: string }>;
export type ServiceScopeFacts = ServiceScopeIdentity & Readonly<{
  rootExited: boolean;
  activeProcesses: number;
  exitCode: number;
  queryError: number;
  dispatchError: number;
}>;
export const ServiceRefusal = Object.freeze({
  unqualified: 1, missing: 2, busy: 3, invalid: 4, retiredRequest: 5, unknown: 6,
});
function serviceUint64(value: string): bigint {
  if (!/^[0-9a-f]{16}$/.test(value) || value === '0000000000000000')
    throw new Error('Invalid original service identity');
  return BigInt('0x' + value);
}
function serviceIdentity(payload: Buffer): ServiceScopeIdentity {
  const key = payload.readBigUInt64LE(0).toString(16).padStart(16, '0');
  const birth = payload.readBigUInt64LE(8).toString(16).padStart(16, '0');
  serviceUint64(key); serviceUint64(birth);
  return Object.freeze({ key, birth });
}
/** Caller supplies an already captured original birth, never a PID-only adoption request. */
export function encodeServiceCapture(pid: number, birth: string): Buffer {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw new Error('Invalid service PID metadata');
  const payload = Buffer.alloc(12);
  payload.writeUInt32LE(pid); payload.writeBigUInt64LE(serviceUint64(birth), 4);
  return payload;
}
export function encodeServiceScope(key: string): Buffer {
  const payload = Buffer.alloc(8); payload.writeBigUInt64LE(serviceUint64(key));
  return payload;
}
export function encodeServiceStop(key: string, budgetMs: number): Buffer {
  if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > 60000)
    throw new Error('Invalid service Stop budget');
  const payload = Buffer.alloc(12);
  payload.writeBigUInt64LE(serviceUint64(key)); payload.writeUInt32LE(budgetMs, 8);
  return payload;
}
export function decodeServiceIdentity(frame: Frame): ServiceScopeIdentity {
  if ((frame.opcode !== Op.serviceCaptured && frame.opcode !== Op.serviceSettled) || frame.payload.length !== 16)
    throw new Error('Invalid original service response');
  return serviceIdentity(frame.payload);
}
export function decodeServiceFacts(frame: Frame): ServiceScopeFacts {
  const p = frame.payload;
  if ((frame.opcode !== Op.serviceObserved && frame.opcode !== Op.serviceStopped) ||
      p.length !== 33 || p[16]! > 1)
    throw new Error('Invalid original service observation');
  return Object.freeze({ ...serviceIdentity(p), rootExited: p[16] === 1,
    activeProcesses: p.readUInt32LE(17), exitCode: p.readUInt32LE(21),
    queryError: p.readUInt32LE(25), dispatchError: p.readUInt32LE(29) });
}
export function decodeServiceRefusal(frame: Frame): Readonly<{ reason: number; nativeCode: number }> {
  if (frame.opcode !== Op.serviceRefused || frame.payload.length !== 5 ||
      !Object.values(ServiceRefusal).some(value => value === frame.payload[0]))
    throw new Error('Invalid service refusal');
  return Object.freeze({ reason: frame.payload[0]!, nativeCode: frame.payload.readUInt32LE(1) });
}
