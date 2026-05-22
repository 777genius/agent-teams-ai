import { promises as fs } from 'fs';
import * as path from 'path';

import { redactBridgeDiagnosticText } from './OpenCodeBridgeCommandClient';

import type { OpenCodeBridgeDiagnosticsSink } from './OpenCodeBridgeCommandClient';
import type { OpenCodeBridgeDiagnosticEvent } from './OpenCodeBridgeCommandContract';

const DEFAULT_MAX_EVENTS_BYTES = 3 * 1024 * 1024;
const MAX_STRING_CHARS = 4_000;

export interface OpenCodeBridgeDiagnosticsStoreOptions {
  directory: string;
  maxEventsBytes?: number;
}

export class OpenCodeBridgeDiagnosticsStore implements OpenCodeBridgeDiagnosticsSink {
  private readonly directory: string;
  private readonly maxEventsBytes: number;

  constructor(options: OpenCodeBridgeDiagnosticsStoreOptions) {
    this.directory = options.directory;
    this.maxEventsBytes = options.maxEventsBytes ?? DEFAULT_MAX_EVENTS_BYTES;
  }

  async append(event: OpenCodeBridgeDiagnosticEvent): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const sanitized = sanitizeDiagnosticEvent(event);
      await fs.writeFile(
        path.join(this.directory, 'latest.json'),
        `${JSON.stringify(sanitized, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
      await this.rotateEventsIfNeeded();
      await fs.appendFile(
        path.join(this.directory, 'events.ndjson'),
        `${JSON.stringify(sanitized)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch {
      // Best-effort diagnostics must never block provider preflight or launch.
    }
  }

  private async rotateEventsIfNeeded(): Promise<void> {
    const eventsPath = path.join(this.directory, 'events.ndjson');
    const stat = await fs.stat(eventsPath).catch(() => null);
    if (!stat || stat.size <= this.maxEventsBytes) {
      return;
    }

    const content = await fs.readFile(eventsPath, 'utf8').catch(() => '');
    const keepBytes = Math.max(0, Math.floor(this.maxEventsBytes / 2));
    const tailLines = selectNdjsonTailLines(content, keepBytes);
    await fs.writeFile(
      eventsPath,
      `${JSON.stringify({
        type: 'opencode_bridge_diagnostics_truncated',
        providerId: 'opencode',
        severity: 'info',
        message: 'truncated previous bridge diagnostics',
        createdAt: new Date().toISOString(),
      })}\n${tailLines.length > 0 ? `${tailLines.join('\n')}\n` : ''}`,
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );
  }
}

function selectNdjsonTailLines(content: string, maxBytes: number): string[] {
  if (maxBytes <= 0) {
    return [];
  }
  const selected: string[] = [];
  let totalBytes = 0;
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const nextBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (selected.length > 0 && totalBytes + nextBytes > maxBytes) {
      break;
    }
    if (selected.length === 0 || totalBytes + nextBytes <= maxBytes) {
      selected.unshift(line);
      totalBytes += nextBytes;
    }
  }
  return selected;
}

function sanitizeDiagnosticEvent(
  event: OpenCodeBridgeDiagnosticEvent
): OpenCodeBridgeDiagnosticEvent {
  return {
    ...event,
    message: sanitizeString(event.message),
    ...(event.teamName ? { teamName: sanitizeString(event.teamName) } : {}),
    ...(event.runId ? { runId: sanitizeString(event.runId) } : {}),
    ...(event.data ? { data: sanitizeRecord(event.data) } : {}),
  };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeRecordEntry(key, entry)])
  );
}

function sanitizeRecordEntry(key: string, entry: unknown): unknown {
  const normalized = key.toLowerCase();
  if (
    normalized === 'stdin' ||
    normalized === 'stdout' ||
    normalized === 'stderr' ||
    normalized === 'input'
  ) {
    return '[omitted]';
  }
  return sanitizeValue(entry);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value && typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeString(value: string): string {
  const redacted = redactBridgeDiagnosticText(value);
  return redacted.length > MAX_STRING_CHARS
    ? `${redacted.slice(0, MAX_STRING_CHARS)}...[truncated]`
    : redacted;
}
