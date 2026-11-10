export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    return Buffer.byteLength(raw, 'utf8') <= maxBytes ? raw : null;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, totalBytes).toString('utf8');
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}
