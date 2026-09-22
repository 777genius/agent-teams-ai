import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { canonicalJsonBytes } from './contracts.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const MAX_COMPRESSED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_MEMBERS = 2048;
const MAX_ARTIFACT_PATH_BYTES = 4096;

export function parseCanonicalClosure(bytes, label) {
  let parsed;
  const source = requireBytes(bytes, label);
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)); } catch {
    throw new Error(`${label} is not a canonical closure manifest`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !canonicalJsonBytes(parsed).equals(source)) {
    throw new Error(`${label} is not a canonical closure manifest`);
  }
  if (Object.keys(parsed).sort().join(',') !== 'entryPath,members' || typeof parsed.entryPath !== 'string' || !Array.isArray(parsed.members)) {
    throw new Error(`${label} is not a complete closure manifest`);
  }
  const members = parsed.members.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member) || Object.keys(member).sort().join(',') !== 'path,sha256' || typeof member.path !== 'string' || !safeArchivePath(member.path) || !digestPattern.test(member.sha256)) {
      throw new Error(`${label}.members[${index}] is malformed`);
    }
    return { path: member.path, sha256: member.sha256 };
  });
  if (members.some((member, index) => index && Buffer.compare(Buffer.from(members[index - 1].path), Buffer.from(member.path)) >= 0)) {
    throw new Error(`${label}.members is not canonically ordered`);
  }
  return { entryPath: parsed.entryPath, members };
}

export async function parseGzipTarMembers(value, label, entryPath) {
  const compressed = requireBytes(value, label);
  if (compressed.byteLength > MAX_COMPRESSED_ARTIFACT_BYTES) throw new Error(`${label} compressed artifact exceeds limit`);
  const gunzip = createGunzip();
  let carry = Buffer.alloc(0), output = 0, zeroBlocks = 0, ended = false, remaining = 0, padding = 0, current;
  const names = new Set(), members = []; let entryBytes;
  const finish = () => {
    if (!current) return;
    members.push({ path: current.path, sha256: `sha256:${current.hash.digest('hex')}` });
    if (current.path === entryPath) entryBytes = Buffer.concat(current.chunks, current.size);
    current = undefined;
  };
  const consume = (chunk) => {
    output += chunk.byteLength;
    if (output > MAX_DECOMPRESSED_ARTIFACT_BYTES) throw new Error(`${label} decompressed artifact exceeds limit`);
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length) {
      if (ended) { if (carry.some((byte) => byte !== 0)) throw new Error(`${label} tar archive is malformed`); carry = Buffer.alloc(0); continue; }
      if (remaining) {
        const part = carry.subarray(0, Math.min(remaining, carry.length));
        current.hash.update(part); if (current.path === entryPath) current.chunks.push(Buffer.from(part));
        remaining -= part.length; carry = carry.subarray(part.length); if (remaining) continue; finish(); continue;
      }
      if (padding) { const size = Math.min(padding, carry.length); if (carry.subarray(0, size).some((byte) => byte !== 0)) throw new Error(`${label} tar member padding is malformed`); padding -= size; carry = carry.subarray(size); continue; }
      if (carry.length < 512) return;
      const header = carry.subarray(0, 512); carry = carry.subarray(512);
      if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks >= 2) ended = true; continue; }
      if (zeroBlocks) throw new Error(`${label} tar archive is malformed`);
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (parseTarNumber(header.subarray(148, 156), label) !== checksum) throw new Error(`${label} tar header checksum is invalid`);
      if (header[156] !== 0 && header[156] !== 48) throw new Error(`${label} tar archive contains a non-regular member`);
      const name = tarPath(header, label), size = parseTarNumber(header.subarray(124, 136), label);
      if (!safeArchivePath(name) || Buffer.byteLength(name) > MAX_ARTIFACT_PATH_BYTES || size > MAX_ARTIFACT_MEMBER_BYTES || names.has(name) || members.length >= MAX_ARTIFACT_MEMBERS) throw new Error(`${label} tar archive has a duplicate, traversal, or oversized member`);
      names.add(name); current = { path: name, size, hash: createHash('sha256'), chunks: [] }; remaining = size; padding = (512 - (size % 512)) % 512;
      if (!remaining) finish();
    }
  };
  try {
    const input = (async function* () { for (let offset = 0; offset < compressed.length; offset += 64 * 1024) yield compressed.subarray(offset, offset + 64 * 1024); })();
    Readable.from(input).pipe(gunzip);
    for await (const chunk of gunzip) consume(chunk);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not a valid gzip tar archive`);
  }
  if (!ended || remaining || padding || carry.length || !members.length) throw new Error(`${label} tar archive is truncated or malformed`);
  members.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { members, entryBytes };
}

function safeArchivePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function tarPath(header, label) {
  const field = (start, length) => { const bytes = header.subarray(start, start + length); const nul = bytes.indexOf(0); return bytes.subarray(0, nul < 0 ? length : nul); };
  try { const name = new TextDecoder('utf-8', { fatal: true }).decode(field(0, 100)); const prefix = new TextDecoder('utf-8', { fatal: true }).decode(field(345, 155)); return prefix ? `${prefix}/${name}` : name; } catch { throw new Error(`${label} tar path is malformed`); }
}

function parseTarNumber(field, label) {
  const text = field.toString('ascii').replace(/\0+$/u, '').trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`${label} tar numeric field is malformed`);
  const result = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} tar numeric field is out of range`);
  return result;
}

function requireBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${label} evidence is unavailable`);
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
