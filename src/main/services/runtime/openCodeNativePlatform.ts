import { open } from 'node:fs/promises';
import path from 'node:path';

import { isNativeProbeFatal, runOpenCodeNativeProbe } from './openCodeNativeProbe';

import type { OpenCodeNativeFacts } from './openCodeNativePolicy';

const MAX_KERNEL_BYTES = 512 * 1024;

async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error('Native evidence exceeded its bound');
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export function classifyOpenCodeInterpreter(value: string): OpenCodeNativeFacts['libc'] {
  if (/^\/(?:[^\0\r\n/]+\/)*(?:ld-linux-x86-64\.so\.2|ld-linux-aarch64\.so\.1)$/.test(value))
    return 'glibc';
  if (/^\/(?:[^\0\r\n/]+\/)*ld-musl-(?:x86_64|aarch64)\.so\.1$/.test(value)) return 'musl';
  return 'unknown';
}

/** Read only bounded ELF program headers of the running Linux image, never an arbitrary PATH ldd. */
async function linuxLibc(arch: string): Promise<OpenCodeNativeFacts['libc']> {
  const file = await open('/proc/self/exe', 'r');
  try {
    const header = Buffer.alloc(64);
    if (
      (await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
      header.subarray(0, 4).toString('hex') !== '7f454c46' ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== (arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1)
    )
      return 'unknown';
    const offset = Number(header.readBigUInt64LE(32));
    const entrySize = header.readUInt16LE(54),
      count = header.readUInt16LE(56);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 64 ||
      offset > 1024 * 1024 ||
      entrySize < 56 ||
      entrySize > 128 ||
      count < 1 ||
      count > 128
    )
      return 'unknown';
    const table = Buffer.alloc(entrySize * count);
    if ((await file.read(table, 0, table.length, offset)).bytesRead !== table.length)
      return 'unknown';
    const interpreters: string[] = [];
    for (let index = 0; index < count; index++) {
      const base = index * entrySize;
      if (table.readUInt32LE(base) !== 3) continue;
      const start = Number(table.readBigUInt64LE(base + 8)),
        size = Number(table.readBigUInt64LE(base + 32));
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > 16 * 1024 * 1024 ||
        size < 2 ||
        size > 4096
      )
        return 'unknown';
      const bytes = Buffer.alloc(size);
      if (
        (await file.read(bytes, 0, size, start)).bytesRead !== size ||
        bytes[size - 1] !== 0 ||
        bytes.subarray(0, -1).includes(0)
      )
        return 'unknown';
      interpreters.push(bytes.subarray(0, -1).toString('utf8'));
    }
    if (interpreters.length !== 1) return 'unknown';
    const declared = classifyOpenCodeInterpreter(interpreters[0] ?? '');
    const maps = (await boundedRead('/proc/self/maps', MAX_KERNEL_BYTES)).toString('utf8');
    // Conflicting loader evidence is not permission to cross libc variants.
    if (declared === 'glibc' && /\/ld-musl-[^/\s]+\.so\.1(?:\s|$)/m.test(maps)) return 'unknown';
    if (declared === 'musl' && /\/ld-linux-[^/\s]+\.so\.[12](?:\s|$)/m.test(maps)) return 'unknown';
    return declared;
  } finally {
    await file.close();
  }
}

async function acquireNativeFacts(signal?: AbortSignal): Promise<OpenCodeNativeFacts> {
  signal?.throwIfAborted();
  const facts: OpenCodeNativeFacts = {
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === 'linux' ? 'unknown' : null,
    avx2: 'unknown',
  };
  const observations = Promise.all([
    facts.platform === 'linux'
      ? linuxLibc(facts.arch)
          .then((value) => {
            facts.libc = value;
          })
          .catch(() => {})
      : Promise.resolve(),
    (async () => {
      if (facts.arch !== 'x64') return;
      if (facts.platform === 'linux') {
        const text = (await boundedRead('/proc/cpuinfo', MAX_KERNEL_BYTES)).toString('utf8');
        const flags = [...text.matchAll(/^flags\s*:\s*(.*)$/gm)].map((match) => match[1] ?? '');
        if (flags.length)
          facts.avx2 = flags.every((value) => value.split(/\s+/).includes('avx2')) ? 'yes' : 'no';
      } else if (facts.platform === 'darwin') {
        const value = await runOpenCodeNativeProbe(
          '/usr/sbin/sysctl',
          ['-n', 'hw.optional.avx2_0'],
          signal ? { signal } : {}
        );
        facts.avx2 = value === '1' ? 'yes' : value === '0' ? 'no' : 'unknown';
      } else if (facts.platform === 'win32') {
        const shell = path.win32.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        );
        const script =
          'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class OpenCodeCpu { [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature); }\'; if ([OpenCodeCpu]::IsProcessorFeaturePresent(40)) { "1" } else { "0" }';
        const value = await runOpenCodeNativeProbe(
          shell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          signal ? { signal } : {}
        );
        facts.avx2 = value === '1' ? 'yes' : value === '0' ? 'no' : 'unknown';
      }
    })().catch((error) => {
      if (isNativeProbeFatal(error)) throw error;
    }),
  ]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Only Linux kernel-file reads can be abandoned; owned OS commands must settle after close.
    if (facts.platform !== 'linux') await observations;
    else
      await Promise.race([
        observations,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 3500);
        }),
      ]);
  } finally {
    clearTimeout(deadline);
  }
  // A slow abandoned read cannot later mutate the authority returned to a caller.
  signal?.throwIfAborted();
  return { ...facts };
}

const acquiredFacts = new Map<string, Promise<OpenCodeNativeFacts>>();

/** CPU and the running image ABI are process-lifetime facts; reuse bounded acquisition. */
export function detectOpenCodeNativeFacts(signal?: AbortSignal): Promise<OpenCodeNativeFacts> {
  if (signal) return acquireNativeFacts(signal);
  const key = `${process.platform}/${process.arch}`;
  let pending = acquiredFacts.get(key);
  if (!pending) {
    pending = acquireNativeFacts();
    acquiredFacts.set(key, pending);
  }
  return pending.then((facts) => ({ ...facts }));
}
