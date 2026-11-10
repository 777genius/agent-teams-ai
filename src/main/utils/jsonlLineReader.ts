import { createReadStream } from 'fs';

/**
 * Async generator that yields the lines of a JSONL file using a chunked stream read
 * plus a plain `\n` split, as a drop-in replacement for
 * `for await (const line of readline.createInterface({ input, crlfDelay: Infinity }))`.
 *
 * readline runs an expensive Unicode line-break regex (`\r?\n | \r | U+2028 | U+2029`)
 * and extra stream/string-decoder machinery on every chunk. JSONL is strictly
 * newline-delimited, so a plain `\n` split is cheaper and more correct here: it will
 * not split on a bare `\r` or a Unicode line/paragraph separator that appears *inside*
 * a JSON string value, which readline would.
 *
 * The stream is opened with utf8 encoding, so the runtime's StringDecoder reassembles
 * multi-byte characters that straddle a chunk boundary before we split - string
 * concatenation + `indexOf('\n')` is therefore safe.
 *
 * Semantics match the readline loop the callers replace:
 * - every line is yielded IN ORDER, INCLUDING empty lines (so callers tracking a
 *   1-based line number stay correct);
 * - a trailing `\r` (from a CRLF ending) is stripped, exactly as readline does;
 * - a final line with no trailing newline is still yielded;
 * - breaking/returning out of the `for await` destroys the underlying stream via the
 *   generator's `finally`.
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string, void, undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += chunk as string;
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        newlineIndex = pending.indexOf('\n');
      }
    }
    // Honor a final line that has no trailing newline (readline yields it too).
    if (pending.length > 0) {
      yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
    }
  } finally {
    stream.destroy();
  }
}
