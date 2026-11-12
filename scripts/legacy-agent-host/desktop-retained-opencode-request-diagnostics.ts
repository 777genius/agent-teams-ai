/** Temporary TEST collector; reads original request diagnostics only after confirmed cleanup. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { RetainedHistoryIdentity } from './desktop-retained-opencode-history-diagnostics.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const events = new Set(['binding_unavailable', 'binary_unavailable', 'binding_no_longer_current',
  'source_failure', 'bridge_failure']);
const stages = new Set(['inactive', 'missing', 'conflicting', 'unreadable', 'ambiguous', 'active', 'stopped',
  'get_transcript', 'project_messages', 'apply_budget', 'build_chunks', 'build_segment',
  'build_cli_env', 'create_output_directory', 'exec', 'read_output', 'parse_output', 'select_transcript']);
const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export async function collectRetainedHistoryRequestDiagnostics(
  root: string, expected: RetainedHistoryIdentity, startedAt: number, endedAt: number
): Promise<Record<string, unknown>> {
  const identityKey = digest([expected.teamName, expected.memberName, expected.laneId]);
  const bindingKey = expected.runtimeRunId === null ? null :
    digest([expected.teamName, expected.memberName, expected.laneId, expected.runtimeRunId, expected.sessionId]);
  const records: Record<string, unknown>[] = [];
  const files: Record<string, unknown>[] = [];
  let matchingCount = 0, rejectedCount = 0;
  for (const name of ['app-errors.1.ndjson', 'app-errors.ndjson']) {
    const file = join(root, 'userData', 'logs', name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 3 * 1024 * 1024) {
        files.push({ name, kind: 'refused', size: info.size }); continue;
      }
      const text = await readFile(file, 'utf8');
      files.push({ name, kind: 'read', bytes: Buffer.byteLength(text) });
      for (const line of text.split('\n')) {
        if (line.length === 0 || line.length > 20_000) continue;
        let row: Record<string, unknown>, data: Record<string, unknown>;
        try {
          row = object(JSON.parse(line));
          if (row.namespace !== 'TEST:RetainedHistoryRequest' || row.level !== 'diagnostic' ||
            typeof row.t !== 'string' || typeof row.message !== 'string') continue;
          const at = Date.parse(row.t);
          if (!Number.isFinite(at) || at < startedAt || at > endedAt) continue;
          data = object(JSON.parse(row.message));
        } catch { continue; }
        if (data.schema !== 'TEST_RETAINED_HISTORY_REQUEST_V1' || data.identityKey !== identityKey) continue;
        matchingCount++;
        if (!events.has(String(data.event)) || !stages.has(String(data.stage)) ||
          typeof data.bindingKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.bindingKey)) {
          rejectedCount++; continue;
        }
        const error = object(data.error);
        // Reconstruct the finite diagnostic schema; never echo a log message or child output.
        const safeError = Object.fromEntries(Object.entries(error).filter(([key, value]) =>
          ['diagnosticAvailable', 'errorKind', 'code', 'errno', 'signal', 'killed', 'stdoutBytes', 'stderrBytes',
            'terminalSource', 'terminalFound', 'tailTruncated', 'terminalKind', 'terminalCode', 'terminalErrno', 'reason'].includes(key) &&
          (value === null || typeof value === 'boolean' ||
            typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value))));
        if (records.length < 12) records.push({
          at: row.t, event: data.event, stage: data.stage, identityKey, bindingKey: data.bindingKey,
          bindingMatchesExpected: bindingKey === null ? null : bindingKey === data.bindingKey,
          error: safeError,
        });
      }
    } catch (error) {
      files.push({ name, kind: 'unreadable', missing: object(error).code === 'ENOENT' });
    }
  }
  return { kind: 'original_request_logs', startedAt, endedAt, identityKey, expectedBindingKey: bindingKey,
    files, matchingCount, rejectedCount, truncated: matchingCount - rejectedCount > records.length, records };
}
