import { createHash } from 'node:crypto';

import type { OpenCodeRuntimeInstallProgress } from '@shared/types';

const MAX_TARBALL_BYTES = 250 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export function verifyOpenCodeRuntimePackageIntegrity(buffer: Buffer, integrity: string): void {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) {
    throw new Error('OpenCode package integrity is missing sha512 metadata');
  }
  const actual = createHash('sha512').update(buffer).digest('base64');
  if (actual !== match[1]) {
    throw new Error('OpenCode package integrity check failed');
  }
}

export async function downloadOpenCodePackage(
  url: string,
  onProgress: (progress: OpenCodeRuntimeInstallProgress) => void
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download OpenCode package: HTTP ${response.status}`);
    }
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;
    if (totalBytes && totalBytes > MAX_TARBALL_BYTES) {
      throw new Error('OpenCode package is unexpectedly large');
    }

    const chunks: Buffer[] = [];
    let downloadedBytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      downloadedBytes += chunk.length;
      if (downloadedBytes > MAX_TARBALL_BYTES) {
        throw new Error('OpenCode package exceeded the maximum allowed download size');
      }
      chunks.push(chunk);
      onProgress({
        phase: 'downloading',
        downloadedBytes,
        totalBytes,
        percent: totalBytes
          ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          : undefined,
        detail: totalBytes
          ? `Downloading OpenCode ${Math.round((downloadedBytes / totalBytes) * 100)}%`
          : 'Downloading OpenCode...',
      });
    }
    return Buffer.concat(chunks, downloadedBytes);
  } finally {
    clearTimeout(timer);
  }
}
