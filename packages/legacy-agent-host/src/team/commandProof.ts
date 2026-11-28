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

/** Proof of original canonical input, used only when its echoed receipt is too large. */
export interface TaskSubmissionProof {
  schemaVersion: 1;
  commandSha256: string;
  taskId?: string;
  taskSubjectSha256?: string;
  commentTextSha256?: string;
}
