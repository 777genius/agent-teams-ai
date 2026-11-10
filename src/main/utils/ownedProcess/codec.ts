import type { ResolvedLaunchSpec } from './contract';

export const HEADER_BYTES = 32;
export const MAX_LAUNCH_BYTES = 1024 * 1024;
export const MAX_CONTROL_BYTES = 4096;
export const VERSION = 1;
export const Op = Object.freeze({
  launch: 1,
  resume: 2,
  stop: 3,
  release: 4,
  prepared: 101,
  resumed: 102,
  stopped: 103,
  released: 104,
  failed: 105,
  rootExit: 106,
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
