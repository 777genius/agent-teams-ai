const MAX_REVIEW_STREAM_BYTES = 64 * 1024;

interface ReviewSseWriter {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(message: string): boolean;
  destroy(): unknown;
}

/** A slow captured review subscriber loses the stream and must resynchronize; no event queue/replay. */
export function writeReviewSse(stream: ReviewSseWriter, message: string): boolean {
  if (
    stream.destroyed ||
    stream.writableLength + Buffer.byteLength(message) > MAX_REVIEW_STREAM_BYTES
  ) {
    stream.destroy();
    return false;
  }
  try {
    if (stream.write(message)) return true;
  } catch {
    /* Closing is the only safe response to an uncertain delivery. */
  }
  stream.destroy();
  return false;
}
