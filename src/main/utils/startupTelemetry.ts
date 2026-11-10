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
    arrayBuffersBytes: memory.arrayBuffers ?? 0,
  };
}

export function formatStartupMemorySnapshot(memory: AppStartupMemorySnapshot): string {
  return `rss=${formatMiB(memory.rssBytes)} heap=${formatMiB(memory.heapUsedBytes)}/${formatMiB(
    memory.heapTotalBytes
  )} external=${formatMiB(memory.externalBytes)}`;
}

export function formatProcessMemorySnapshot(
  memory: AppStartupMemorySnapshot,
  pid: number = process.pid
): string {
  return `pid=${pid} ${formatStartupMemorySnapshot(memory)} arrayBuffers=${formatMiB(
    memory.arrayBuffersBytes ?? 0
  )}`;
}

export function formatCurrentProcessMemorySnapshot(
  readMemoryUsage: MemoryUsageReader = () => process.memoryUsage(),
  pid: number = process.pid
): string {
  return formatProcessMemorySnapshot(captureStartupMemorySnapshot(readMemoryUsage), pid);
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}
