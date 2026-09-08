import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
function safeId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,120}$/.test(value) ? value : null;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function classifyFailure(error: unknown): string {
  // Inspect in memory, persist only a finite enum. Never persist provider messages/bodies.
  let text: string | undefined;
  try {
    text = error instanceof Error ? `${error.name} ${error.message}` : JSON.stringify(error);
  } catch {
    return 'unclassified';
  }
  for (const [pattern, classification] of [
    [/MessageAbortedError|message_aborted/, 'message_aborted'],
    [/ERR_ACCESS_DENIED|permission denied|permission.*reject|EACCES/i, 'permission_denied'],
    [/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i, 'runtime_connection_lost'],
    [/timeout|timed out/i, 'observation_timeout'],
    [/401|403|authentication|unauthorized/i, 'authentication_failed'],
    [/AssertionError|expected .* to /i, 'assertion_failed'],
    [/cleanup.*not confirmed/i, 'cleanup_unconfirmed'],
  ] as const) {
    if (pattern.test(text ?? '')) return classification;
  }
  return 'unclassified';
}
export function transcriptMetadata(transcript: unknown) {
  const root = record(transcript);
  const data = record(root.data);
  const raw = data.messages;
  const messages = (Array.isArray(raw) ? raw : [])
    .map(record)
    .filter((message) => message.role === 'assistant');
  const terminalAborted = messages.some(
    (message) =>
      message.errorName === 'MessageAbortedError' ||
      (Array.isArray(message.contentBlocks) &&
        message.contentBlocks.some((value) => {
          const block = record(value);
          return block.type === 'error' && block.name === 'MessageAbortedError';
        }))
  );
  return {
    available: Array.isArray(raw),
    terminalAborted,
    classification: terminalAborted
      ? 'message_aborted'
      : data.error || root.error
        ? classifyFailure(data.error ?? root.error)
        : null,
    durableState: ['idle', 'busy', 'stale', 'stopped'].includes(String(data.durableState))
      ? data.durableState
      : null,
    messageCount: messages.length,
    messages: messages.slice(-12).map((message) => ({
      id: safeId(message.id),
      hasError: message.hasError === true,
      error: message.errorName ? classifyFailure(message.errorName) : null,
      tools: (Array.isArray(message.contentBlocks) ? message.contentBlocks : [])
        .map(record)
        .filter((block) => block.type === 'tool_use' || block.type === 'tool_result')
        .slice(-24)
        .map((block) => ({
          id: safeId(block.id ?? block.toolUseId),
          name: /^(?:agent[-_]teams[_-])?(?:bash|read|write|edit|shell|exec|task_complete|message_send|task_get|task_list|task_update)$/.test(
            String(block.name ?? block.toolName)
          )
            ? (block.name ?? block.toolName)
            : 'other',
          status: ['completed', 'running', 'errored', 'unknown'].includes(String(block.status))
            ? block.status
            : null,
          isError: block.isError === true,
          error: block.isError === true ? classifyFailure(block.contentText) : null,
        })),
    })),
  };
}
export function snapshotMetadata(snapshot: unknown, selectedModel: string) {
  const root = record(snapshot),
    members = record(root.members);
  return {
    runId: safeId(root.runId),
    members: ['alice', 'bob'].map((name) => {
      const member = record(members[name]);
      return {
        name,
        alive: member.alive === true,
        sessionId: safeId(member.runtimeSessionId),
        pid: finite(member.runtimePid ?? member.pid),
        modelMatches: member.runtimeModel === selectedModel,
      };
    }),
  };
}
export function cleanupMetadata(cleanup: unknown, projectPath: string) {
  const root = record(cleanup);
  return {
    cleaned: finite(root.cleaned),
    remaining: finite(root.remaining),
    diagnostics: (Array.isArray(root.diagnostics) ? root.diagnostics : [])
      .slice(0, 12)
      .map(classifyFailure),
    hosts: (Array.isArray(root.hosts) ? root.hosts : [])
      .map(record)
      .filter((host) => host.projectPath === projectPath)
      .slice(0, 12)
      .map((host) => ({
        pid: finite(host.pid),
        leaseCount: finite(host.leaseCount),
        action: [
          'disposed',
          'removed_dead',
          'kept_active',
          'kept_leased',
          'kept_recent',
          'kept_filtered',
          'failed',
        ].includes(String(host.action))
          ? host.action
          : 'unknown',
        reason: classifyFailure(host.reason),
      })),
  };
}
export async function ownedRegistryMetadata(dataHome: string, projectPath: string) {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(dataHome, 'opencode', 'host-registry.json'), 'utf8')
    );
    const hosts = Object.values(record(record(raw).hosts))
      .map(record)
      .filter((host) => host.projectPath === projectPath);
    return {
      available: true,
      hosts: hosts.slice(0, 12).map((host) => ({
        pid: finite(host.pid),
        port: finite(host.port),
        leases: Object.values(record(host.leases))
          .map(record)
          .slice(0, 12)
          .map((lease) => ({
            teamId: safeId(lease.teamId),
            runId: safeId(lease.runId),
            sessionId: safeId(lease.sessionId),
          })),
      })),
    };
  } catch (error) {
    return { available: false, classification: classifyFailure(error) };
  }
}
