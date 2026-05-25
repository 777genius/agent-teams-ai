import type { AppStartupMemorySnapshot } from '@shared/types';

export type MemoryUsageReader = () => NodeJS.MemoryUsage;

export function captureStartupMemorySnapshot(
  readMemoryUsage: MemoryUsageReader = () => process.memoryUsage()
): AppStartupMemorySnapshot {
  const memory = readMemoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

export function formatStartupMemorySnapshot(memory: AppStartupMemorySnapshot): string {
  return `rss=${formatMiB(memory.rssBytes)} heap=${formatMiB(memory.heapUsedBytes)}/${formatMiB(
    memory.heapTotalBytes
  )} external=${formatMiB(memory.externalBytes)}`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}
