import { createHash } from 'node:crypto';

import { TeamOwnerError } from './contracts.js';

export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TeamOwnerError('invalid');
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Same SHA256/version-5 UUID convention as existing taskCreationIdempotency. */
export function effectId(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  const normalized = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${(
    (Number.parseInt(hex[16]!, 16) & 3) |
    8
  ).toString(16)}${hex.slice(17, 32)}`;
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

export function safeSegment(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new TeamOwnerError('invalid');
  return value;
}
