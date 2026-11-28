// @vitest-environment node
import { createHash } from 'node:crypto';

import { expect, test, vi } from 'vitest';

import { captureOpenCodeV2MediaProjection,
captureOpenCodeV2MediaSource,   issueOpenCodeV2MediaWitness, verifyOpenCodeV2MediaWitness } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2MediaReceipt';

const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64');
const key = 'a'.repeat(64);
const body = (bytes = original) => JSON.stringify({ id: 'msg_TESTmedia', text: 'TEST image', resume: true,
  delivery: 'queue', files: [{ name: 'TEST-image', uri: 'data:image/png;base64,' + bytes.toString('base64') }] });
const source = () => captureOpenCodeV2MediaSource(body(), 'ses_TESTmedia');
const response = (bytes = original) => ({ data: { id: 'msg_TESTmedia', sessionID: 'ses_TESTmedia', type: 'user',
  delivery: 'queue', payload: { text: 'TEST image', files: [{ data: bytes.toString('base64'), mime: 'image/png',
    source: { type: 'inline' }, name: 'TEST-image' }] } } });

test('the native signer binds source bytes and actual normalized projection without storing the key', () => {
  const captured = source();
  const projectionDigest = captureOpenCodeV2MediaProjection(response(), captured);
  expect(captured.sourceDigest).toBe(createHash('sha256').update(body()).digest('hex'));
  const proof = { sessionId: captured.sessionId, inputId: captured.inputId,
    sourceDigest: captured.sourceDigest, projectionDigest };
  const witness = issueOpenCodeV2MediaWitness(key, proof, Date.now() + 20_000);
  expect(verifyOpenCodeV2MediaWitness(key, { ...proof, witness })).toBe(true);
  expect(witness).not.toContain(key);
  const normalized = captureOpenCodeV2MediaProjection(response(Buffer.concat([original, Buffer.from([1])])), captured);
  expect(normalized).not.toBe(projectionDigest);
  for (const change of [{ sessionId: 'ses_FOREIGN' }, { inputId: 'msg_FOREIGN' },
    { sourceDigest: 'b'.repeat(64) }, { projectionDigest: normalized }, { witness: witness.slice(0, -1) + 'z' }]) {
    expect(verifyOpenCodeV2MediaWitness(key, { ...proof, witness, ...change })).toBe(false);
  }
  expect(verifyOpenCodeV2MediaWitness('c'.repeat(64), { ...proof, witness })).toBe(false);
});

test('expired, future or malformed witnesses cannot revive an earlier image input', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    const captured = source(), proof = { sessionId: captured.sessionId, inputId: captured.inputId,
      sourceDigest: captured.sourceDigest, projectionDigest: captureOpenCodeV2MediaProjection(response(), captured) };
    expect(() => issueOpenCodeV2MediaWitness(key, proof, Date.now() + 30_001)).toThrow();
    const witness = issueOpenCodeV2MediaWitness(key, proof, Date.now() + 100);
    vi.advanceTimersByTime(100);
    expect(verifyOpenCodeV2MediaWitness(key, { ...proof, witness })).toBe(false);
    for (const malformed of ['', 'v2.1.' + 'a'.repeat(64), 'v1.01.' + 'a'.repeat(64)]) {
      expect(verifyOpenCodeV2MediaWitness(key, { ...proof, witness: malformed })).toBe(false);
    }
  } finally { vi.useRealTimers(); }
});

test('native receipt captures reject a foreign input, extra media authority and arbitrary source URIs', () => {
  for (const uri of ['file:///TEST/private.png', 'https://TEST.invalid/image.png', 'data:video/mp4;base64,VEVTVA==']) {
    const invalid = JSON.parse(body()) as { files: { uri: string }[] };
    invalid.files[0]!.uri = uri;
    expect(() => captureOpenCodeV2MediaSource(JSON.stringify(invalid), 'ses_TESTmedia')).toThrow();
  }
  const original = source();
  const foreign = response(); foreign.data.sessionID = 'ses_FOREIGN';
  expect(() => captureOpenCodeV2MediaProjection(foreign, original)).toThrow();
  const missing = response(); missing.data.payload.files = [];
  expect(() => captureOpenCodeV2MediaProjection(missing, original)).toThrow();
  const renamed = response(); renamed.data.payload.files[0]!.name = 'TEST-other';
  expect(() => captureOpenCodeV2MediaProjection(renamed, original)).toThrow();
  const extra = response(); Object.assign(extra.data.payload.files[0]!, { description: 'TEST hidden change' });
  expect(() => captureOpenCodeV2MediaProjection(extra, original)).toThrow();
});


test('PDF receipt preserves every original document byte and rejects image substitution', () => {
  const pdf = Buffer.from('%PDF-1.7\nTEST original document\n%%EOF\n');
  const input = JSON.parse(body()) as { files: { uri: string }[] };
  input.files[0]!.uri = 'data:application/pdf;base64,' + pdf.toString('base64');
  const captured = captureOpenCodeV2MediaSource(JSON.stringify(input), 'ses_TESTmedia');
  const native = response(pdf); native.data.payload.files[0]!.mime = 'application/pdf';
  const projectionDigest = captureOpenCodeV2MediaProjection(native, captured);
  const proof = { sessionId: captured.sessionId, inputId: captured.inputId,
    sourceDigest: captured.sourceDigest, projectionDigest };
  const witness = issueOpenCodeV2MediaWitness(key, proof, Date.now() + 20_000);
  expect(verifyOpenCodeV2MediaWitness(key, { ...proof, witness })).toBe(true);
  native.data.payload.files[0]!.data = Buffer.concat([pdf, Buffer.from('changed')]).toString('base64');
  expect(() => captureOpenCodeV2MediaProjection(native, captured)).toThrow();
  expect(() => captureOpenCodeV2MediaProjection(response(), captured)).toThrow();
});
