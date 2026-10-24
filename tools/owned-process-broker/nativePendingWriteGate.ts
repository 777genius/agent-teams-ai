import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import type { HelperRole } from './nativeGateDiagnostics';
import { createNativeGateEvents, type NativeGateEvents } from './nativeGateEvents';

const SOURCE_BYTES = 1024 * 1024;
type WriteMode = 'complete' | 'deadline';
interface NativeFacts {
  schema: number;
  mode: number;
  writerExit: number;
  activeProcesses: number;
  readBytes: number;
  header: number[];
  operations: number[][];
}
function readBounded(path: string, limit: number): Buffer {
  const original = lstatSync(path);
  assert.ok(original.isFile() && !original.isSymbolicLink(), 'Regular owned binary/inventory');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.dev === original.dev && opened.ino === original.ino);
    assert.ok(opened.size > 0 && opened.size <= limit, 'Bounded binary/inventory');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    for (;;) {
      const added = readSync(fd, buffer, count, buffer.length - count, null);
      if (!added) break;
      count += added;
      assert.ok(count <= limit, 'No inventory/binary overflow');
    }
    assert.equal(count, opened.size, 'Stable complete inventory/binary');
    const after = fstatSync(fd);
    assert.ok(after.size === opened.size && after.mtimeMs === opened.mtimeMs);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
function hasControlCharacter(text: string, allowLineWhitespace = false): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && (!allowLineWhitespace || ![9, 10, 13].includes(code))))
      return true;
  }
  return false;
}
function canonical(path: string): string {
  assert.ok(win32.isAbsolute(path) && !hasControlCharacter(path));
  assert.equal(win32.normalize(path).toLowerCase(), path.toLowerCase(), 'Canonical full path');
  return path.toLowerCase();
}
export function parseBinaryInventory(bytes: Buffer, directory: string): Map<string, string> {
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  assert.ok(!text.startsWith('\uFEFF'), 'At most one inventory BOM');
  assert.ok(!hasControlCharacter(text, true));
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  assert.ok(!lines.some((line) => line.includes('\r')) && lines.length <= 1024);
  const records = new Map<string, string>();
  let fields: string[] = [];
  const finish = (): void => {
    if (!fields.length) return;
    assert.equal(fields.length, 3, 'Complete Algorithm/Hash/Path inventory record');
    const [algorithm, hash, path] = fields;
    assert.ok(algorithm === 'SHA256' && hash && /^[a-f0-9]{64}$/iu.test(hash) && path);
    assert.ok(path.length <= 4096 && !path.includes('...') && !path.includes('\u2026'));
    const key = canonical(path);
    assert.equal(
      canonical(win32.dirname(path)),
      canonical(directory),
      'Exact owned build directory'
    );
    assert.ok(!records.has(key) && records.size < 16, 'Unique bounded binary inventory');
    records.set(key, hash.toLowerCase());
    fields = [];
  };
  for (const line of lines) {
    if (!line) {
      finish();
      continue;
    }
    const field = /^(Algorithm|Hash|Path)\s+: (.+)$/u.exec(line);
    if (field) {
      assert.equal(field[1], ['Algorithm', 'Hash', 'Path'][fields.length]);
      assert.ok(field[1] && field[2]);
      assert.equal(line.slice(0, 12), `${field[1]}${' '.repeat(10 - field[1].length)}: `);
      fields.push(field[2]);
    } else {
      assert.ok(
        fields.length === 3 && line.startsWith(' '.repeat(12)) && line.length > 12,
        'Exact Path continuation'
      );
      const path = fields[2];
      assert.ok(path);
      fields[2] = path + line.slice(12);
      assert.ok(fields[2].length <= 4096);
    }
  }
  finish();
  assert.ok(records.size > 0);
  return records;
}
function admitFixture(existingFixture: string): { executable: string; sha256: string } {
  const modulePath = fileURLToPath(import.meta.url);
  assert.equal(realpathSync(modulePath), modulePath, 'Original trusted source module');
  const checkout = resolve(dirname(modulePath), '../..');
  assert.equal(modulePath, join(checkout, 'tools/owned-process-broker/nativePendingWriteGate.ts'));
  const executable = join(dirname(existingFixture), 'owned-process-pending-write-fixture.exe');
  assert.ok(isAbsolute(executable));
  assert.equal(canonical(realpathSync(executable)), canonical(executable), 'Original fixture path');
  const inventory = readBounded(join(checkout, 'native-evidence/binary-sha256.txt'), 64 * 1024);
  const digest = parseBinaryInventory(inventory, dirname(executable)).get(canonical(executable));
  assert.ok(digest, 'Exact full fixture path in external build inventory');
  const bytes = readBounded(executable, 16 * 1024 * 1024);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, digest, 'Independent build digest matches actual fixture');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  verifyBrokerArchitecture(bytes, process.arch);
  return { executable, sha256 };
}
function numbers(value: unknown, length: number): number[] {
  assert.ok(Array.isArray(value) && value.length === length);
  const items: readonly unknown[] = value;
  return items.map((item) => {
    assert.ok(
      typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 0xffffffff
    );
    return item;
  });
}
function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
function decodeFacts(output: Buffer): NativeFacts {
  assert.ok(output.length > 0 && output.length <= 4096);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  assert.ok(/^\{[^\r\n]*\}\r?\n$/u.test(text), 'One complete bounded native fact record');
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  const data = parsed as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(data).sort(compareKeys),
    ['schema', 'mode', 'writerExit', 'activeProcesses', 'readBytes', 'header', 'operations'].sort(
      compareKeys
    )
  );
  const scalars = numbers(
    [data.schema, data.mode, data.writerExit, data.activeProcesses, data.readBytes],
    5
  );
  const [schema, mode, writerExit, activeProcesses, readBytes] = scalars;
  assert.ok(
    schema !== undefined &&
      mode !== undefined &&
      writerExit !== undefined &&
      activeProcesses !== undefined &&
      readBytes !== undefined
  );
  assert.ok(Array.isArray(data.operations) && data.operations.length === 8);
  const operations: readonly unknown[] = data.operations;
  return {
    schema,
    mode,
    writerExit,
    activeProcesses,
    readBytes,
    header: numbers(data.header, 64),
    operations: operations.map((row) => numbers(row, 24)),
  };
}
function validateCompleted(row: number[]): number {
  assert.equal(row[8], 0, 'Pending completion requires WAIT_OBJECT_0; immediate has no wait');
  if (row[2] === 1)
    assert.ok(
      row.slice(4, 8).every((cell) => cell === 0),
      'Immediate has no pending probe'
    );
  else if (row[5] === 1) {
    assert.equal(row[4], 0);
    assert.equal(row[6], 0);
    const probeCount = row[7];
    assert.ok(probeCount !== undefined && probeCount <= (row[1] ?? 0));
  } else assert.deepEqual(row.slice(4, 7), [1, 0, 996], 'Pending incomplete probe');
  assert.equal(row[9], 1); // original GetOverlappedResult, never an event-only assertion
  assert.equal(row[10], 0);
  const count = row[11];
  assert.ok(count !== undefined && count > 0 && count <= (row[1] ?? 0));
  assert.ok(
    row.slice(12, 18).every((cell) => cell === 0),
    'Completed operation has no cancellation facts'
  );
  assert.equal(row[22], 0);
  assert.equal(row[18], 1);
  assert.equal(row[19], 1);
  assert.ok((row[21] ?? 0) > 0 && (row[23] ?? 0) > (row[21] ?? 0));
  return count;
}
function validateCancellation(row: number[], facts: NativeFacts): void {
  assert.equal(row[2], 0);
  assert.equal(row[3], 997);
  assert.equal(row[8], 258, 'Actual WaitForSingleObject deadline');
  assert.equal(row[12], 1, 'Actual exact-operation CancelIoEx');
  assert.ok(row[13] === 0 || row[13] === 1);
  if (row[13] === 1) assert.equal(row[14], 0);
  assert.ok((row[22] ?? 0) > 0 && (row[21] ?? 0) > (row[22] ?? 0));
  assert.ok((facts.header[13] ?? 0) > 0 && (row[22] ?? 0) > (facts.header[13] ?? 0));
  assert.ok(row[15] === 0 || row[15] === 1);
  if (row[15] === 1) assert.equal(row[16], 0);
  const terminal = row[15] === 1 || [995, 109, 233].includes(row[16] ?? -1);
  assert.equal(facts.header[9], terminal ? 0 : 1);
  assert.equal(facts.writerExit, 74 | (terminal ? 0 : 128));
  assert.equal(row[18], terminal ? 1 : 0);
  if (terminal) {
    assert.equal(row[19], 1);
    assert.ok((row[23] ?? 0) > (row[21] ?? 0));
  } else assert.equal(row[23], 0, 'Unknown cancellation retains event until original death');
}
function validateRead(facts: NativeFacts, positive: boolean): void {
  const h = facts.header;
  if (!positive) {
    assert.ok(
      h.slice(32).every((n) => n === 0),
      'No peer read in deadline cohort'
    );
    return;
  }
  assert.ok((h[32] ?? 0) >= 16 && (h[32] ?? 0) <= SOURCE_BYTES);
  assert.equal(h[34], h[32]);
  assert.equal(h[35], h[32]);
  assert.ok((h[33] ?? 0) <= (h[32] ?? 0));
  assert.equal(h[36], SOURCE_BYTES);
  assert.equal(h[37], 1);
  assert.equal(h[38], 1);
  assert.equal(h[42], 1);
  assert.equal(h[43], 0);
  assert.equal(h[45], 0);
  assert.ok((h[44] ?? 0) > 0 && (h[44] ?? 0) <= 64 * 1024);
  assert.ok(h.slice(46).every((n) => n === 0));
}
function validateOperation(row: number[], ordinal: number, remaining: number): boolean {
  assert.equal(row[0], ordinal);
  assert.equal(row[1], remaining);
  assert.equal(row[20], 15, 'Original pipe/operation/event/buffer identity');
  assert.ok([2, 4, 5, 9, 12, 13, 15, 18, 19].every((cell) => row[cell] === 0 || row[cell] === 1));
  assert.equal(row[3], row[2] === 1 ? 0 : 997);
  const incomplete = row[4] === 1;
  if (incomplete) {
    assert.deepEqual(row.slice(2, 4), [0, 997]);
    assert.deepEqual(row.slice(5, 7), [0, 996]);
  }
  return incomplete;
}
export function validateNativeWriteFacts(facts: NativeFacts, mode: WriteMode): void {
  const positive = mode === 'complete';
  assert.equal(facts.schema, 1);
  assert.equal(facts.mode, positive ? 0 : 1);
  assert.equal(facts.activeProcesses, 0);
  assert.equal(facts.readBytes, positive ? SOURCE_BYTES : 0);
  const h = facts.header;
  assert.deepEqual(h.slice(0, 4), [1, positive ? 0 : 1, 1, 0]);
  const count = h[4];
  assert.ok(count !== undefined && count > 0 && count <= 8);
  assert.ok((h[5] ?? 0) + (h[6] ?? 0) > 0);
  assert.deepEqual(h.slice(7, 9), positive ? [0, 0] : [74, 74]);
  assert.deepEqual(h.slice(10, 12), positive ? [1, 1] : [0, 0]);
  assert.ok(h.slice(14, 32).every((n) => n === 0));
  if (positive) assert.equal(h[13], 0);
  let remaining = SOURCE_BYTES;
  let pending = false;
  for (let index = 0; index < count; index++) {
    const row = facts.operations[index];
    assert.ok(row);
    pending = validateOperation(row, index + 1, remaining) || pending;
    if (!positive && index === count - 1) validateCancellation(row, facts);
    else remaining -= validateCompleted(row);
  }
  assert.ok(pending, 'Actual WriteFile pending plus actual incomplete query before any peer read');
  assert.ok(facts.operations.slice(count).every((row) => row.every((n) => n === 0)));
  if (positive) {
    assert.equal(remaining, 0);
    assert.equal(facts.writerExit, 0);
    assert.equal(h[9], 0);
  }
  validateRead(facts, positive);
}
export async function runNativePendingWriteGate(
  existingFixture: string,
  mode: WriteMode,
  track: (child: ChildProcess, role?: HelperRole) => void,
  events: NativeGateEvents = createNativeGateEvents()
): Promise<void> {
  const admitted = admitFixture(existingFixture); // external receipt/PE/digest before any spawn
  assert.ok(isAbsolute(admitted.executable));
  const child = spawn(admitted.executable, [mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  track(child, 'write-fixture');
  const chunks: Buffer[] = [];
  let length = 0;
  let stderr = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await events.wait(
      new Promise<void>((done, reject) => {
        timer = setTimeout(
          () => reject(new Error('Pending write original helper deadline')),
          10000
        );
        child.stdout.on(
          'data',
          events.guard((chunk: Buffer) => {
            length += chunk.length;
            if (length <= 4096) chunks.push(chunk);
            else reject(new Error('Pending write fact overflow'));
          })
        );
        child.stderr.on(
          'data',
          events.guard((chunk: Buffer) => {
            stderr += chunk.length;
            if (stderr > 4096) reject(new Error('Pending write error overflow'));
          })
        );
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Pending write helper error'));
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 || signal !== null || stderr !== 0 || length > 4096)
            reject(new Error('Pending write original supervisor failed'));
          else done();
        });
      })
    );
  } finally {
    clearTimeout(timer);
  }
  const facts = decodeFacts(Buffer.concat(chunks, length));
  validateNativeWriteFacts(facts, mode);
  console.log(JSON.stringify({ nativeWritePrimitive: mode, binarySha256: admitted.sha256, facts }));
}
