import { HostTaskSubmissionRefusal, HostTeamOperationError } from '../contracts/taskSubmission';

import { projectHostTaskReceipt } from './projectHostTaskReceipt';

import type { BackendHandle } from '../contracts';
import type {
  AgentBackendApi,
  BackendCommandReceipt,
  BackendOperationRequest,
  BackendOperationResult,
} from '../contracts/operations';
import type { HostTaskProjection } from './projectHostTaskReceipt';

type Command = Omit<BackendOperationRequest, 'handle'>;
interface Submission {
  fingerprint: Promise<string>;
  backend: AgentBackendApi;
  current(): boolean;
  handle?: BackendHandle;
  projection?: HostTaskProjection;
  command?: Command;
  inFlight: boolean;
  effectStarted: boolean;
  completed: boolean;
  attachmentMetadata?: { id: string; filename: string; mimeType: string; size: number }[];
}
// App-lifetime obligations only: no renderer-reload durability, raw attachment cache or history journal.
const submissions = new Map<string, Submission>();
const limit = 256;
function keyFor(team: string, commandId: string): string {
  return JSON.stringify([team, commandId]);
}
function hold(commandId: string, code = 'submission-unresolved'): never {
  throw new HostTeamOperationError(code, 'unknown', commandId);
}
export function canonicalTaskSubmission(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => JSON.parse(canonicalTaskSubmission(item))));
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, JSON.parse(canonicalTaskSubmission(item))])
      )
    );
  return JSON.stringify(value ?? null);
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalTaskSubmission(value))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function verifyTaskReceipt(record: Submission, receipt: BackendCommandReceipt): void {
  const command = record.command;
  if (
    !command ||
    receipt.commandId !== command.commandId ||
    receipt.operation !== command.operation
  )
    hold(command?.commandId ?? receipt.commandId, 'invalid-result');
  if (canonicalTaskSubmission(receipt.taskSubmission) !== canonicalTaskSubmission(command))
    hold(command.commandId, 'invalid-correlation');
  if (receipt.phase === 'rejected' && receipt.taskSubmissionNoEffect === true)
    throw new HostTaskSubmissionRefusal('policy', 'rejected', command.commandId);
  if (receipt.phase !== 'completed') hold(command.commandId);
  if (command.operation === 'task.comment') {
    const payload = command.payload as { taskId: string; text: string; taskRefs?: unknown };
    if (
      !receipt.comment ||
      !receipt.comment.id ||
      receipt.comment.text !== payload.text ||
      (receipt.task && receipt.task.id !== payload.taskId)
    )
      hold(command.commandId, 'invalid-result');
    const metadata = (receipt.comment.attachments ?? []).map(
      ({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size })
    );
    if (
      canonicalTaskSubmission(metadata) !== canonicalTaskSubmission(record.attachmentMetadata ?? [])
    )
      hold(command.commandId, 'invalid-attachments');
    const normalized = (refs: unknown) =>
      Array.isArray(refs)
        ? [
            ...new Set(
              refs.map((ref: { taskId: string; displayId: string; teamName: string }) =>
                canonicalTaskSubmission({
                  taskId: ref.taskId.trim(),
                  displayId: ref.displayId.trim(),
                  teamName: ref.teamName.trim(),
                })
              )
            ),
          ].sort()
        : [];
    if (
      canonicalTaskSubmission(normalized(receipt.comment.taskRefs)) !==
      canonicalTaskSubmission(normalized(payload.taskRefs))
    )
      hold(command.commandId, 'invalid-result');
  } else if (
    command.operation === 'task.create' &&
    (!receipt.task?.id ||
      receipt.task.subject !== (command.payload as { subject: string }).subject.trim())
  )
    hold(command.commandId, 'invalid-result');
  record.completed = true;
}
async function lookup(
  record: Submission,
  commandId: string
): Promise<BackendCommandReceipt | null> {
  if (!record.current() || !record.handle) return hold(commandId, 'context-changed');
  let response;
  try {
    response = await record.backend.invoke({
      handle: record.handle,
      commandId,
      operation: 'command.lookup',
      payload: {},
    });
  } catch {
    return hold(commandId, 'lookup-unavailable');
  }
  if (!record.current()) return hold(commandId, 'context-changed');
  if (!response.ok) return hold(commandId, 'lookup-unavailable');
  if (response.value === null) return null;
  if (!response.value || !('phase' in response.value)) return hold(commandId, 'invalid-result');
  return structuredClone(response.value) as BackendCommandReceipt;
}
export interface HostTaskSubmissionAttempt {
  current(): boolean;
  capture(handle: BackendHandle, projection: HostTaskProjection): void;
  effectStarted(): void;
  command(command: Command): void;
  attachments(metadata: NonNullable<Submission['attachmentMetadata']>): void;
  received(receipt: BackendCommandReceipt): void;
  refused(result: Extract<BackendOperationResult, { ok: false }>): Promise<void>;
}
export async function runRetainedHostTaskSubmission<T>(
  options: {
    key: string;
    commandId: string;
    input: unknown;
    backend: AgentBackendApi;
    current(): boolean;
  },
  first: (attempt: HostTaskSubmissionAttempt) => Promise<T>,
  recover: (receipt: BackendCommandReceipt) => T
): Promise<T> {
  const key = keyFor(options.key, options.commandId);
  let record = submissions.get(key);
  if (record?.inFlight) return hold(options.commandId, 'submission-pending');
  const fingerprint = digest(options.input);
  if (record) {
    record.inFlight = true;
    try {
      if ((await fingerprint) !== (await record.fingerprint))
        return hold(options.commandId, 'submission-payload-conflict');
      const receipt = await lookup(record, options.commandId);
      if (!receipt) return hold(options.commandId);
      verifyTaskReceipt(record, receipt);
      return recover(projectHostTaskReceipt(receipt, record.projection!));
    } catch (error) {
      if (
        error instanceof HostTaskSubmissionRefusal &&
        record.current() &&
        submissions.get(key) === record
      )
        submissions.delete(key);
      throw error;
    } finally {
      record.inFlight = false;
    }
  }
  if (!options.current()) return hold(options.commandId, 'context-changed');
  if (submissions.size >= limit) return hold(options.commandId, 'submission-capacity');
  record = {
    fingerprint,
    backend: options.backend,
    current: options.current,
    inFlight: true,
    effectStarted: false,
    completed: false,
  };
  submissions.set(key, record);
  const original = record;
  const attempt: HostTaskSubmissionAttempt = {
    current: original.current,
    capture(handle, projection) {
      original.handle = structuredClone(handle);
      original.projection = structuredClone(projection);
    },
    command(command) {
      original.command = structuredClone(command);
    },
    effectStarted() {
      original.effectStarted = true;
    },
    attachments(metadata) {
      original.attachmentMetadata = structuredClone(metadata);
    },
    received(receipt) {
      verifyTaskReceipt(original, receipt);
    },
    async refused(result) {
      // Only an initial finite facade refusal can ask the original authority to prove no admission.
      if (result.outcome === 'not-dispatched')
        throw new HostTaskSubmissionRefusal(result.code, 'not-dispatched', options.commandId);
      if (
        result.outcome === 'rejected' &&
        ['invalid', 'forbidden', 'conflict'].includes(result.code) &&
        (await lookup(original, options.commandId)) === null
      )
        throw new HostTaskSubmissionRefusal(result.code, 'rejected', options.commandId);
    },
  };
  try {
    await fingerprint;
    return await first(attempt);
  } catch (error) {
    if (
      original.current() &&
      submissions.get(key) === original &&
      (error instanceof HostTaskSubmissionRefusal ||
        (!original.effectStarted &&
          error instanceof HostTeamOperationError &&
          error.outcome === 'not-dispatched' &&
          error.code !== 'context-changed'))
    ) {
      submissions.delete(key);
      if (!(error instanceof HostTaskSubmissionRefusal))
        throw new HostTaskSubmissionRefusal(error.code, 'not-dispatched', options.commandId);
    }
    throw error;
  } finally {
    original.inFlight = false;
  }
}
/** Local ACK after the existing UI/store workflow clears its original intent; no new RPC. */
export function acknowledgeHostTaskSubmission(team: string, commandId: string): void {
  const key = keyFor(team, commandId),
    record = submissions.get(key);
  if (record?.completed && !record.inFlight && record.current()) submissions.delete(key);
}
export function __resetRetainedTaskSubmissionsForTests(): void {
  submissions.clear();
}
