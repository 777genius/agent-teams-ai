/* eslint-disable security/detect-non-literal-fs-filename -- Runtime log paths are derived from validated team/member names under the configured teams base path. */
import { promises as fs } from 'fs';
import path from 'path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { MemberRuntimeLogKind, MemberRuntimeLogTailResponse } from '../../contracts';

const DEFAULT_RUNTIME_LOG_TAIL_BYTES = 128 * 1024;
const MAX_RUNTIME_LOG_TAIL_BYTES = 512 * 1024;
const MIN_RUNTIME_LOG_TAIL_BYTES = 1024;

const RUNTIME_LOG_FILES: Record<MemberRuntimeLogKind, string> = {
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  events: 'runtime.jsonl',
};
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export interface GetMemberRuntimeLogTailInput {
  teamName: string;
  memberName: string;
  kind: MemberRuntimeLogKind;
  maxBytes?: number;
}

export interface MemberRuntimeLogTailReaderOptions {
  teamsBasePath?: string;
}

function sanitizeRuntimeLogSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const normalized = sanitized
    .trim()
    .replace(/[. ]+$/g, '')
    .toLowerCase();
  const stem = normalized.split('.')[0] ?? normalized;
  return WINDOWS_RESERVED_BASENAMES.has(stem) ? `_${sanitized}` : sanitized;
}

function clampMaxBytes(maxBytes: number | undefined): number {
  if (!Number.isFinite(maxBytes ?? NaN)) return DEFAULT_RUNTIME_LOG_TAIL_BYTES;
  return Math.max(
    MIN_RUNTIME_LOG_TAIL_BYTES,
    Math.min(MAX_RUNTIME_LOG_TAIL_BYTES, Math.floor(maxBytes as number))
  );
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function redactRuntimeLogSecrets(content: string): string {
  let redacted = content;

  redacted = redacted.replace(/\b(Authorization\s*:\s*Bearer)\s+([^\s"',;]+)/gi, '$1 [redacted]');
  redacted = redacted.replace(/\b(Bearer)\s+([A-Za-z0-9._~+/=-]{20,})/gi, '$1 [redacted]');
  redacted = redacted.replace(
    /\b((?:OPENAI|ANTHROPIC|CODEX|GEMINI|GOOGLE|OPENROUTER|CLAUDE)[A-Z0-9_]*_(?:API_)?KEY)\s*=\s*("[^"]+"|'[^']+'|[^\s"',;]+)/gi,
    '$1=[redacted]'
  );
  redacted = redacted.replace(
    /(--(?:api-key|token|auth-token|authorization|secret|password)(?:=|\s+))("[^"]+"|'[^']+'|[^\s"',;]+)/gi,
    '$1[redacted]'
  );
  redacted = redacted.replace(
    /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    '[redacted]'
  );

  return redacted;
}

export class MemberRuntimeLogTailReader {
  private readonly teamsBasePath: string;

  constructor(options: MemberRuntimeLogTailReaderOptions = {}) {
    this.teamsBasePath = options.teamsBasePath ?? getTeamsBasePath();
  }

  async getTail(input: GetMemberRuntimeLogTailInput): Promise<MemberRuntimeLogTailResponse> {
    const maxBytes = clampMaxBytes(input.maxBytes);
    const runtimeDir = path.resolve(
      this.teamsBasePath,
      sanitizeRuntimeLogSegment(input.teamName),
      'runtime'
    );
    const filePath = path.resolve(
      runtimeDir,
      `${sanitizeRuntimeLogSegment(input.memberName)}.${RUNTIME_LOG_FILES[input.kind]}`
    );

    if (!isPathInside(runtimeDir, filePath)) {
      throw new Error('Invalid member runtime log path');
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          kind: input.kind,
          content: '',
          truncated: false,
          bytesRead: 0,
          missing: true,
        };
      }
      throw error;
    }

    if (!stat.isFile()) {
      return {
        kind: input.kind,
        content: '',
        truncated: false,
        bytesRead: 0,
        fileSizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        missing: true,
      };
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    let actualBytesRead = 0;

    if (bytesToRead > 0) {
      const handle = await fs.open(filePath, 'r');
      try {
        const result = await handle.read(buffer, 0, bytesToRead, start);
        actualBytesRead = result.bytesRead;
      } finally {
        await handle.close();
      }
    }
    const contentBuffer =
      actualBytesRead === bytesToRead ? buffer : buffer.subarray(0, actualBytesRead);

    return {
      kind: input.kind,
      content: redactRuntimeLogSecrets(contentBuffer.toString('utf8')),
      truncated: stat.size > bytesToRead,
      bytesRead: actualBytesRead,
      fileSizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      missing: false,
    };
  }
}
