import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJsonlLines } from '../../../src/main/utils/jsonlLineReader';

describe('readJsonlLines', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-line-reader-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, content, 'utf8');
    return p;
  }

  async function collect(filePath: string): Promise<string[]> {
    const out: string[] = [];
    for await (const line of readJsonlLines(filePath)) {
      out.push(line);
    }
    return out;
  }

  it('yields every line in order, including empty lines', async () => {
    // empty lines must still be yielded so callers tracking line numbers match readline
    const p = await write('a.jsonl', 'a\n\nb\nc\n');
    expect(await collect(p)).toEqual(['a', '', 'b', 'c']);
  });

  it('strips a trailing CR from CRLF endings', async () => {
    const p = await write('crlf.jsonl', 'one\r\ntwo\r\nthree\r\n');
    expect(await collect(p)).toEqual(['one', 'two', 'three']);
  });

  it('yields a final line that has no trailing newline', async () => {
    const p = await write('tail.jsonl', 'first\nlast-no-newline');
    expect(await collect(p)).toEqual(['first', 'last-no-newline']);
  });

  it('returns nothing for an empty file', async () => {
    const p = await write('empty.jsonl', '');
    expect(await collect(p)).toEqual([]);
  });

  it('stops and cleans up when the consumer breaks out of the loop', async () => {
    const p = await write('stop.jsonl', 'l1\nl2\nl3\nl4\n');
    const seen: string[] = [];
    for await (const line of readJsonlLines(p)) {
      seen.push(line);
      if (line === 'l2') break;
    }
    expect(seen).toEqual(['l1', 'l2']);
  });

  it('decodes multi-byte UTF-8 that straddles a read-chunk boundary', async () => {
    // >64KB of 2-byte Cyrillic before the marker forces a multi-byte char to span the
    // stream's default 64KB chunk boundary; the marker line must still arrive intact.
    const big = 'я'.repeat(40_000); // ~80KB
    const p = await write('mb.jsonl', `${big}\n${big}\nМАРКЕР-Ω\n`);
    const lines = await collect(p);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(big);
    expect(lines[2]).toBe('МАРКЕР-Ω');
  });
});
