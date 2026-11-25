import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const openCodeV2MediaRevision = 'opencode-2.1.4-native-media-v1';
export const openCodeV2MediaReceiptHeader = 'x-agent-teams-media-receipt';
export const openCodeV2MediaDeadlineHeader = 'x-agent-teams-media-deadline';
export const openCodeV2ImageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const openCodeV2MediaMimes = [...openCodeV2ImageMimes, 'application/pdf'] as const;
const MiB = 1024 * 1024;
const envelopeBytes = 6 * 256 * 1024 + 64 * 1024;
export const openCodeV2MediaPromptBytes = Math.ceil(8 * MiB / 3) * 4 + 5 * 4 + envelopeBytes;
// The existing message boundary admits five media files in total. PDFs are
// unchanged; each normalized image may occupy at most 5 MiB of base64.
const nativePayloadBytes = Math.max(...Array.from({ length: 6 }, (_, images) =>
  images * 5 * MiB + Math.min((5 - images) * Math.ceil(4 * MiB / 3) * 4,
    Math.ceil(8 * MiB / 3) * 4 + (5 - images) * 4)));
export const openCodeV2MediaProjectionBytes = nativePayloadBytes + envelopeBytes;
export interface OpenCodeV2MediaProof {
  sessionId: string;
  inputId: string;
  sourceDigest: string;
  projectionDigest: string;
  witness: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const held = (): never => { throw new Error('OpenCode V2 media receipt unavailable'); };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function mediaMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return undefined;
}

/** Exact original inline source; no file/network URI can enter the attested handler. */
export function captureOpenCodeV2MediaSource(source: string, sessionId: string) {
  if (Buffer.byteLength(source) > openCodeV2MediaPromptBytes || !/^ses_[A-Za-z0-9_-]+$/u.test(sessionId)) return held();
  const value: unknown = JSON.parse(source);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'delivery,files,id,resume,text' ||
    typeof value.id !== 'string' || !/^msg_[A-Za-z0-9_-]+$/u.test(value.id) ||
    typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 256 * 1024 ||
    value.delivery !== 'queue' || value.resume !== true || !Array.isArray(value.files) ||
    !value.files.length || value.files.length > 5) return held();
  let total = 0;
  const files = value.files.map((file: unknown) => {
    if (!object(file) || Object.keys(file).sort().join(',') !== 'name,uri' ||
      typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/u.test(file.name) ||
      typeof file.uri !== 'string' || file.uri.length > Math.ceil(4 * MiB / 3) * 4 + 32) return held();
    const match = /^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(file.uri);
    if (!match) return held();
    const bytes = Buffer.from(match[2]!, 'base64');
    if (!bytes.length || bytes.length > 4 * MiB || bytes.toString('base64') !== match[2] || mediaMime(bytes) !== match[1]) return held();
    total += bytes.length;
    return Object.freeze({ name: file.name, mime: match[1]!, data: match[2]! });
  });
  if (total > 8 * MiB || new Set(files.map(file => file.name)).size !== files.length) return held();
  return Object.freeze({ sessionId, inputId: value.id, text: value.text, files: Object.freeze(files), sourceDigest: digest(source) });
}

/** Hash the original engine's normalized ACK in the provider's canonical key order. */
export function captureOpenCodeV2MediaProjection(value: unknown,
  source: ReturnType<typeof captureOpenCodeV2MediaSource>): string {
  if (!object(value) || Object.keys(value).join(',') !== 'data' || !object(value.data)) return held();
  const receipt = value.data;
  if (receipt.id !== source.inputId || receipt.sessionID !== source.sessionId || receipt.type !== 'user' ||
    receipt.delivery !== 'queue' || !object(receipt.payload) || receipt.payload.text !== source.text ||
    !Array.isArray(receipt.payload.files) || receipt.payload.files.length !== source.files.length) return held();
  const files = receipt.payload.files.map((value: unknown, index: number) => {
    const original = source.files[index]!;
    const document = original.mime === 'application/pdf';
    if (!object(value) || Object.keys(value).sort().join(',') !== 'data,mime,name,source' ||
      value.name !== source.files[index]!.name || !object(value.source) || Object.keys(value.source).join(',') !== 'type' ||
      value.source.type !== 'inline' || typeof value.mime !== 'string' ||
      (document ? value.mime !== 'application/pdf' : !(openCodeV2ImageMimes as readonly string[]).includes(value.mime)) || typeof value.data !== 'string' ||
      value.data.length > (document ? Math.ceil(4 * MiB / 3) * 4 : 5 * MiB) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data) ||
      Buffer.from(value.data, 'base64').toString('base64') !== value.data ||
      mediaMime(Buffer.from(value.data, 'base64')) !== value.mime || document && value.data !== original.data) return held();
    return { data: value.data, mime: value.mime, name: value.name, source: { type: 'inline' } };
  });
  return digest(JSON.stringify(files));
}

function signature(key: string, proof: Omit<OpenCodeV2MediaProof, 'witness'>, deadline: number): string {
  if (!/^[a-f0-9]{64}$/u.test(key) || !/^ses_[A-Za-z0-9_-]+$/u.test(proof.sessionId) ||
    !/^msg_[A-Za-z0-9_-]+$/u.test(proof.inputId) ||
    ![proof.sourceDigest, proof.projectionDigest].every(value => /^[a-f0-9]{64}$/u.test(value))) return held();
  return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify([
    openCodeV2MediaRevision, proof.sessionId, proof.inputId, proof.sourceDigest, proof.projectionDigest, deadline,
  ])).digest('hex');
}
/** Called only by the original child after its original native handler completes. */
export function issueOpenCodeV2MediaWitness(key: string, proof: Omit<OpenCodeV2MediaProof, 'witness'>, deadline: number): string {
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 30_000) return held();
  return `v1.${deadline}.${signature(key, proof, deadline)}`;
}
export function verifyOpenCodeV2MediaWitness(key: string, proof: OpenCodeV2MediaProof): boolean {
  try {
    const matched = /^v1\.([1-9]\d{0,15})\.([a-f0-9]{64})$/u.exec(proof.witness);
    if (!matched) return false;
    const deadline = Number(matched[1]);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 30_000) return false;
    return timingSafeEqual(Buffer.from(matched[2]!, 'hex'), Buffer.from(signature(key, proof, deadline), 'hex'));
  } catch { return false; }
}
