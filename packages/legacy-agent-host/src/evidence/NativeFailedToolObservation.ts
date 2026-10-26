import { resolve } from 'node:path';
import { digest } from '../team/identity.js';
import type { CodexAfterRequest } from './codexCaptureContracts.js';
import type { OpenCodeAfterRequest } from './opencodeCaptureContracts.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
import type { RuntimeInputEvidenceBinding } from './bindRuntimeInputEvidence.js';
import type { TaskToolEvidenceBinding } from './bindTaskToolEvidence.js';
import type { TaskEvidenceJournal } from './TaskEvidenceJournal.js';

type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);
const exitCode = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
type Selection =
  | { kind: 'none' }
  | { kind: 'gap'; reason: string }
  | { kind: 'failed'; toolUseId: string; native: Readonly<Row> };
export const hasNativeCommand = (item: unknown): boolean =>
  !!object(item) && Object.hasOwn(item as object, 'nativeCommand');

/** The containing input may succeed; the selected native command's outcome is independent. */
export function selectCodexFailedTool(request: CodexAfterRequest, workspace: string): Selection {
  const commands = request.items.filter(hasNativeCommand);
  if (!commands.length) return { kind: 'none' };
  const gap = (): Selection => ({ kind: 'gap', reason: 'unqualified-native-command-pairs' });
  if (
    ![request.threadId, request.turnId, request.windowRef].every(id) ||
    commands.length % 2 ||
    commands.length > 64
  )
    return gap();
  const seen = new Set<string>();
  let failed: Extract<Selection, { kind: 'failed' }> | undefined;
  for (let index = 0; index < commands.length; index += 2) {
    const start = commands[index]!,
      end = commands[index + 1]!;
    const a = object(object(start)?.nativeCommand),
      b = object(object(end)?.nativeCommand);
    if (
      !a ||
      !b ||
      !id(start.itemId) ||
      start.itemId !== end.itemId ||
      seen.has(start.itemId) ||
      start.phase !== 'started' ||
      end.phase !== 'completed' ||
      start.status !== 'inProgress' ||
      !['completed', 'failed'].includes(end.status) ||
      a.exitCode !== null ||
      a.isError !== false ||
      !exitCode(b.exitCode) ||
      typeof b.isError !== 'boolean'
    )
      return gap();
    seen.add(start.itemId);
    if (b.exitCode === 0 && end.status === 'completed' && !b.isError) continue;
    if (b.exitCode === 0 || !b.isError || failed) return gap();
    // Root-only eligibility belongs to the new failed tuple. Known successful
    // commands from other directories still defer to the existing fileChange proof.
    if (
      typeof a.command !== 'string' ||
      !a.command ||
      a.command.length > 65536 ||
      a.command !== b.command ||
      a.cwd !== workspace ||
      b.cwd !== workspace
    )
      return gap();
    failed = {
      kind: 'failed',
      toolUseId: end.itemId,
      native: Object.freeze({
        provider: 'codex',
        threadId: request.threadId,
        turnId: request.turnId,
        windowRef: request.windowRef,
        itemId: end.itemId,
        status: end.status,
        exitCode: b.exitCode,
        commandSha256: digest(b.command),
        inputOutcome: request.outcome,
      }),
    };
  }
  // One known failed execution only; mixed effects never acquire timing-based authorship.
  return failed ? (request.items.length === 2 ? failed : gap()) : { kind: 'none' };
}

export function selectOpenCodeFailedTool(
  request: OpenCodeAfterRequest,
  workspace: string
): Selection {
  const tools = request.items.filter((item) => item.tool === 'bash');
  if (!tools.length) return { kind: 'none' };
  const failed = tools.filter((item) => {
    const value = object(item.metadata)?.exit;
    return item.status === 'errored' || (exitCode(value) && value !== 0);
  });
  if (!failed.length) return { kind: 'none' };
  const gap = (): Selection => ({ kind: 'gap', reason: 'unqualified-native-bash-window' });
  if (request.items.length !== 1 || failed.length !== 1) return gap();
  const item = failed[0]!,
    input = object(item.input),
    metadata = object(item.metadata);
  if (
    ![
      request.nativeSessionId,
      request.nativeInputId,
      request.windowRef,
      item.messageId,
      item.partId,
      item.callId,
    ].every(id) ||
    !/^ses_.+/u.test(request.nativeSessionId) ||
    !/^msg_.+/u.test(request.nativeInputId) ||
    !/^msg_.+/u.test(item.messageId) ||
    !/^prt_.+/u.test(item.partId) ||
    item.messageId === request.nativeInputId ||
    !['completed', 'errored'].includes(item.status) ||
    typeof input?.command !== 'string' ||
    !input.command ||
    input.command.length > 65536 ||
    (input.workdir !== undefined &&
      (typeof input.workdir !== 'string' || resolve(workspace, input.workdir) !== workspace)) ||
    !exitCode(metadata?.exit) ||
    metadata.exit === 0 ||
    !Number.isSafeInteger(item.startedAt) ||
    !Number.isSafeInteger(item.completedAt) ||
    item.startedAt! < 0 ||
    item.completedAt! < item.startedAt!
  )
    return gap();
  return {
    kind: 'failed',
    toolUseId: item.callId,
    native: Object.freeze({
      provider: 'opencode',
      nativeSessionId: request.nativeSessionId,
      nativeInputId: request.nativeInputId,
      windowRef: request.windowRef,
      messageId: item.messageId,
      partId: item.partId,
      callId: item.callId,
      status: item.status,
      exitCode: metadata.exit,
      commandSha256: digest(input.command),
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      inputOutcome: request.outcome,
    }),
  };
}

/** Observed bytes under the original window, never proof of shell/external-writer authorship. */
export function retainFailedToolObservations(options: {
  selected: Extract<Selection, { kind: 'failed' }>;
  binding: RuntimeInputEvidenceBinding;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  warnings: readonly string[];
  journal: TaskEvidenceJournal;
  guard(): void;
}): void {
  const binding: TaskToolEvidenceBinding = Object.freeze({
    ...options.binding,
    toolUseId: options.selected.toolUseId,
    toolName: 'Bash',
    native: options.selected.native,
  });
  const warnings = [
    ...options.warnings,
    'Native failed-tool window bytes are partial observations; authorship and external exclusivity are unqualified.',
  ];
  for (const path of new Set([...options.before.files.keys(), ...options.after.files.keys()])) {
    const before = options.before.files.get(path) ?? {
      reason: 'Preimage was not captured before the effect.',
    };
    const after = options.after.files.get(path) ?? { reason: 'Final content was not captured.' };
    if (
      (before.exists === false && after.exists === false) ||
      (before.sha256 && before.sha256 === after.sha256)
    )
      continue;
    options.guard();
    options.journal.event(binding, path, before, after, 'failed', warnings, options.guard);
  }
  options.journal.notice(binding, 'native-failed-tool-window', warnings.at(-1)!, options.guard, {
    capturePhase: 'input-failed-tool',
    outcome: 'failed',
    nativeToolOutcome: options.selected.native,
    reviewableComplete: false,
  });
}
