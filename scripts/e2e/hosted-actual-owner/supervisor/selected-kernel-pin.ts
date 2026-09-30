import type { FilePin } from '../contracts';
import { exactRecord } from './canonical';

export function parseSelectedKernelPin(value: unknown): FilePin {
  const row = exactRecord(value, ['root', 'relativePath', 'device', 'inode', 'size', 'mode', 'nlink', 'sha256'], 'selected_kernel_pin');
  if (row.root !== 'p3b2' || row.mode !== 0o400 || row.nlink !== 1 ||
    typeof row.relativePath !== 'string' || !/^[\x21-\x7e]{1,511}\.node$/u.test(row.relativePath) ||
    row.relativePath.length >= 512 || row.relativePath.includes('\\') || row.relativePath.includes(':') ||
    !row.relativePath.split('/').every(part => part && part !== '.' && part !== '..') ||
    !Number.isSafeInteger(row.size) || Number(row.size) < 1 || Number(row.size) > 32 * 1024 * 1024 ||
    typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.sha256)) throw new Error('selected_kernel_pin');
  for (const number of [row.device, row.inode]) {
    if (typeof number !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(number) ||
      BigInt(number) > 0xffffffffffffffffn) throw new Error('selected_kernel_pin');
  }
  if (row.inode === '0') throw new Error('selected_kernel_pin');
  return Object.freeze({ ...row }) as unknown as FilePin;
}
