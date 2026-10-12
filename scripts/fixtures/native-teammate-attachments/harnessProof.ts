import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  collectStructuredInput,
  type Json,
  type StructuredInputObservation,
} from './harnessSupport.ts';

import type { InboxMessage } from '../../../src/shared/types/team.ts';

export interface NativeState {
  capability: Record<string, Json>;
  admissionSnapshot: Record<string, Json>;
}

export const MEMBER_NAME = 'worker';
const REQUEST_TIMEOUT_MS = 180_000;
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function bounded<T>(
  label: string,
  read: () => Promise<T | null | false | undefined>,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null && value !== false && value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`
  );
}

export async function rows(teamDir: string, member = MEMBER_NAME): Promise<InboxMessage[]> {
  try {
    return JSON.parse(
      await readFile(path.join(teamDir, 'inboxes', `${member}.json`), 'utf8')
    ) as InboxMessage[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readNativeState(teamDir: string, team: string): Promise<NativeState> {
  void team;
  const root = path.join(
    teamDir,
    'members',
    encodeURIComponent(MEMBER_NAME.toLowerCase()),
    '.member-work-sync',
    'runtime-admission'
  );
  const [capability, admissionSnapshot] = await Promise.all([
    readFile(path.join(root, 'capability.json'), 'utf8').then((raw) => JSON.parse(raw)),
    readFile(path.join(root, 'snapshot.json'), 'utf8').then((raw) => JSON.parse(raw)),
  ]);
  return {
    capability: capability as Record<string, Json>,
    admissionSnapshot: admissionSnapshot as Record<string, Json>,
  };
}

export async function waitForAttachmentRow(
  teamDir: string,
  digests: readonly string[],
  existingIds: ReadonlySet<string>
): Promise<InboxMessage> {
  return bounded('persisted native attachment inbox row', async () => {
    const current = await rows(teamDir);
    return (
      current.find(
        (row) =>
          row.messageId &&
          !existingIds.has(row.messageId) &&
          digests.every((sha256) => row.attachments?.some((item) => item.sha256 === sha256))
      ) ?? null
    );
  });
}

interface ClaudeTranscriptRecord {
  uuid?: string;
  parentUuid?: string;
  type?: string;
  teamName?: string;
  agentName?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  subtype?: string;
  codexNativeThreadId?: string;
  codexNativeThreadStatus?: string;
  codexNativeFinalUsageAuthority?: string;
  message?: { content?: Array<{
    type: string;
    text?: string;
    source?: { type?: string; path?: string };
    id?: string;
    name?: string;
    input?: { to?: string; message?: string };
    tool_use_id?: string;
    is_error?: boolean;
    content?: Array<{ type: string; text?: string }>;
  }> };
}

export async function correlateClaudeReply(
  sourcePaths: readonly string[],
  original: InboxMessage,
  userRows: readonly InboxMessage[],
  team: string,
  project: string
): Promise<{ reply: InboxMessage; proof: Json } | null> {
  assert(original.messageId, 'Original attachment message ID is required');
  const expectedDigests = new Set((original.attachments ?? []).map((item) => item.sha256).filter((value): value is string => Boolean(value)));
  assert(expectedDigests.size === 3, 'Claude proof requires all three attachment digests');
  for (const sourcePath of sourcePaths) {
    let raw: string;
    try {
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) continue;
      raw = await readFile(sourcePath, 'utf8');
    } catch { continue; }
    const records = raw.split(/\r?\n/).map((line, index) => {
      try { return { record: JSON.parse(line) as ClaudeTranscriptRecord, line: index + 1 }; }
      catch { return null; }
    }).filter((item): item is { record: ClaudeTranscriptRecord; line: number } => item !== null);
    const byUuid = new Map(records.filter((item) => item.record.uuid).map((item) => [item.record.uuid!, item.record]));
    const input = await collectStructuredInput([sourcePath], expectedDigests, new Set(), original.messageId);
    const originalTurn = records.find(({ record, line }) =>
      record.type === 'user' && record.teamName === team && record.agentName === MEMBER_NAME &&
      record.cwd === project && record.sessionId === path.basename(sourcePath, '.jsonl') &&
      [...expectedDigests].every((digest) => input.some((item) => item.line === line && item.sha256 === digest && item.messageIdObserved))
    );
    if (!originalTurn?.record.uuid) continue;
    for (const { record: result } of records) {
      if (result.teamName !== team || result.agentName !== MEMBER_NAME || result.cwd !== project || result.sessionId !== originalTurn.record.sessionId) continue;
      for (const block of result.message?.content ?? []) {
        if (block.type !== 'tool_result' || block.is_error || !block.tool_use_id) continue;
        const text = block.content?.find((item) => item.type === 'text')?.text;
        if (!text) continue;
        let output: { success?: boolean; routing?: { sender?: string; target?: string; summary?: string; content?: string } };
        try { output = JSON.parse(text) as typeof output; } catch { continue; }
        if (output.success !== true || output.routing?.sender !== MEMBER_NAME || output.routing.target !== '@user' || typeof output.routing.content !== 'string') continue;
        const ancestors: string[] = [];
        let cursor: ClaudeTranscriptRecord | undefined = result;
        while (cursor?.uuid && !ancestors.includes(cursor.uuid)) {
          ancestors.push(cursor.uuid);
          if (cursor.uuid === originalTurn.record.uuid) break;
          cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
        }
        if (ancestors.at(-1) !== originalTurn.record.uuid) continue;
        const ancestryTools = ancestors.flatMap((uuid) =>
          (byUuid.get(uuid)?.message?.content ?? []).filter((item) => item.type === 'tool_use')
        );
        if (ancestryTools.some((tool) => tool.name !== 'ToolSearch' && tool.name !== 'SendMessage')) continue;
        const toolOwner = ancestors.map((uuid) => byUuid.get(uuid)).find((record) =>
          record?.type === 'assistant' && record.teamName === team && record.agentName === MEMBER_NAME &&
          record.cwd === project && record.sessionId === originalTurn.record.sessionId && record.message?.content?.some((tool) =>
            tool.type === 'tool_use' && tool.id === block.tool_use_id && tool.name === 'SendMessage' &&
            tool.input?.to === 'user' && tool.input.message === output.routing?.content
          )
        );
        if (!toolOwner) continue;
        const reply = userRows.find((row) => row.from === MEMBER_NAME && row.text === output.routing!.content && row.summary === output.routing!.summary && Date.parse(row.timestamp) >= Date.parse(original.timestamp));
        if (!reply) continue;
        return { reply, proof: {
          sourcePath, transcriptSha256: createHash('sha256').update(raw).digest('hex'),
          originalMessageId: original.messageId, originalUserUuid: originalTurn.record.uuid,
          originalUserLine: originalTurn.line, structuredInput: input as unknown as Json,
          ancestry: ancestors, ancestryToolNames: ancestryTools.map((tool) => tool.name!),
          toolUseId: block.tool_use_id, toolUseUuid: toolOwner.uuid!,
          successfulResultUuid: result.uuid!, persistedReplyMessageId: reply.messageId ?? null,
          routing: output.routing as unknown as Json,
        } };
      }
    }
  }
  return null;
}

export async function correlateCodexFallback(
  sourcePaths: readonly string[], original: InboxMessage, userRows: readonly InboxMessage[],
  team: string, project: string, retainedImageCopy?: string
): Promise<{ reply: InboxMessage; proof: Json; input: StructuredInputObservation } | null> {
  if (!original.read || !original.messageId || original.attachments?.length !== 1) return null;
  const attachment = original.attachments[0];
  if (!attachment.filePath || !attachment.sha256) return null;
  const imageBytes = await readFile(retainedImageCopy ?? attachment.filePath);
  const digest = createHash('sha256').update(imageBytes).digest('hex');
  if (digest !== attachment.sha256) return null;
  for (const sourcePath of sourcePaths) {
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile() || info.size > 20 * 1024 * 1024) continue;
    const raw = await readFile(sourcePath, 'utf8');
    const records = raw.split(/\r?\n/).flatMap((line, index) => {
      try { return [{ record: JSON.parse(line) as ClaudeTranscriptRecord, line: index + 1 }]; }
      catch { return []; }
    });
    const byUuid = new Map(records.filter((item) => item.record.uuid).map((item) => [item.record.uuid!, item.record]));
    const originalTurn = records.find(({ record }) => record.type === 'user' && record.teamName === team && record.agentName === MEMBER_NAME && record.cwd === project && Array.isArray(record.message?.content) && record.message.content.some((block) => block.type === 'text' && block.text?.includes(`Original User MessageId: ${original.messageId}`)) && record.message?.content?.some((block) => block.type === 'image' && block.source?.type === 'file' && block.source.path === attachment.filePath));
    if (!originalTurn?.record.uuid || !originalTurn.record.sessionId) continue;
    const scoped = (record: ClaudeTranscriptRecord): boolean => record.cwd === project && record.sessionId === originalTurn.record.sessionId;
    for (const { record: assistant } of records) {
      if (assistant.type !== 'assistant' || !assistant.uuid || !scoped(assistant) || !Array.isArray(assistant.message?.content)) continue;
      const ancestry: string[] = [];
      let cursor: ClaudeTranscriptRecord | undefined = assistant;
      while (cursor?.uuid && scoped(cursor) && !ancestry.includes(cursor.uuid)) {
        ancestry.push(cursor.uuid);
        if (cursor.uuid === originalTurn.record.uuid) break;
        cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
      }
      if (ancestry.at(-1) !== originalTurn.record.uuid) continue;
      const turn = ancestry.map((uuid) => byUuid.get(uuid)!);
      if (turn.some((record) => Array.isArray(record.message?.content) && record.message.content.some((block) => block.type === 'tool_use'))) continue;
      const started = turn.find((record) => record.subtype === 'codex_native_thread_status' && record.codexNativeThreadStatus === 'running');
      const summary = records.find(({ record }) => scoped(record) && record.parentUuid === assistant.uuid && record.subtype === 'codex_native_execution_summary' && record.codexNativeFinalUsageAuthority === 'live-turn-completed' && record.codexNativeThreadId === started?.codexNativeThreadId)?.record;
      if (!started?.codexNativeThreadId || !summary?.uuid) continue;
      const completed = records.find(({ record }) => scoped(record) && record.parentUuid === summary.uuid && record.codexNativeThreadStatus === 'completed' && record.codexNativeThreadId === started.codexNativeThreadId)?.record;
      if (!completed?.uuid) continue;
      const text = (assistant.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n\n');
      const compact = text.replace(/\s+/g, ' ').trim();
      if (!compact) continue;
      const expectedSummary = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
      const matches = userRows.filter((row) => row.from === MEMBER_NAME && row.text === text && row.summary === expectedSummary);
      if (matches.length !== 1) continue;
      const input: StructuredInputObservation = { sourcePath, line: originalTurn.line, recordType: 'codex_provider_bound_file_image', blockType: 'image', argumentShape: '{type:image,source:{type:file,path}}', filePath: attachment.filePath, sha256: digest, messageIdObserved: true };
      return { reply: matches[0], input, proof: {
        sourcePath, transcriptSha256: createHash('sha256').update(raw).digest('hex'),
        originalMessageId: original.messageId, originalUserUuid: originalTurn.record.uuid,
        originalRead: true, originalUserLine: originalTurn.line, ancestry, imageTurnToolUses: [],
        assistantUuid: assistant.uuid, executionSummaryUuid: summary.uuid, completedUuid: completed.uuid,
        nativeThreadId: started.codexNativeThreadId, input: input as unknown as Json,
        retainedImageCopy: retainedImageCopy ?? null, persistedReplyMessageId: matches[0].messageId ?? null,
        representation: 'Provider-bound file-image and immutable bytes; completed native thread. No raw API localImage trace is claimed.',
      } };
    }
  }
  return null;
}

export async function verifyExistingCodexRun(): Promise<void> {
  const required = (flag: string): string => {
    const index = process.argv.indexOf(flag);
    assert(index >= 0 && process.argv[index + 1], `${flag} is required`);
    return process.argv[index + 1];
  };
  const packet = JSON.parse(await readFile(required('--verify-existing-codex'), 'utf8')) as {
    team: string; project: string; originalReadProof: InboxMessage;
    expected: { imageToken: string; layoutCode: string; colorOrder: string[] };
    artifacts: Record<string, { sha256: string }>;
  };
  const files = [['--transcript', 'worker-transcript.jsonl'], ['--user-inbox', 'persisted-user-inbox.json'], ['--provider-image', 'provider-image.png']] as const;
  for (const [flag, key] of files) assert.equal(createHash('sha256').update(await readFile(required(flag))).digest('hex'), packet.artifacts[key].sha256, `Frozen ${key} hash must match`);
  const userRows = JSON.parse(await readFile(required('--user-inbox'), 'utf8')) as InboxMessage[];
  const correlated = await correlateCodexFallback([required('--transcript')], packet.originalReadProof, userRows, packet.team, packet.project, required('--provider-image'));
  assert(correlated, 'No original image turn/native completion/read-proof/unique persisted fallback correlation');
  assert(correlated.reply.text.includes(packet.expected.imageToken) && correlated.reply.text.includes(packet.expected.layoutCode), 'Visual markers must match frozen fixtures');
  const positions = packet.expected.colorOrder.map((color) => correlated.reply.text.indexOf(color));
  assert(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), 'Image color order must match');
  console.log(JSON.stringify({ outcome: 'existing-codex-run-verified', original: packet.originalReadProof, reply: correlated.reply, correlation: correlated.proof }, null, 2));
}

export async function verifyExistingClaudeRun(): Promise<void> {
  const required = (flag: string): string => {
    const index = process.argv.indexOf(flag);
    assert(index >= 0 && process.argv[index + 1], `${flag} is required`);
    return process.argv[index + 1];
  };
  const evidence = JSON.parse(await readFile(required('--verify-existing'), 'utf8')) as {
    provider: string; team: string; project: string; fixtureDigests: Record<string, string>;
    generatedExpected: { imageToken: string; textToken: string; pdfToken: string; layoutCode: string; colorOrder: string[] };
  };
  assert.equal(evidence.provider, 'claude');
  const workerRows = JSON.parse(await readFile(required('--worker-inbox'), 'utf8')) as InboxMessage[];
  const userRows = JSON.parse(await readFile(required('--user-inbox'), 'utf8')) as InboxMessage[];
  const original = workerRows.find((row) => row.messageId === required('--message-id'));
  assert(original?.read, 'Persisted original message must have a read proof');
  assert(Object.values(evidence.fixtureDigests).every((digest) => original.attachments?.some((item) => item.sha256 === digest)), 'Original persisted attachment digests must match the frozen fixtures');
  const correlated = await correlateClaudeReply([required('--transcript')], original, userRows, evidence.team, evidence.project);
  assert(correlated, 'No structured-turn/ancestry/tool-result/persisted-row Claude correlation');
  const expected = evidence.generatedExpected;
  for (const token of [expected.imageToken, expected.textToken, expected.pdfToken, expected.layoutCode]) assert(correlated.reply.text.includes(token), 'Reply must match every frozen fixture token');
  const positions = expected.colorOrder.map((color) => correlated.reply.text.indexOf(color));
  assert(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), 'Reply color order must match the image');
  console.log(JSON.stringify({ outcome: 'existing-claude-run-verified', original, reply: correlated.reply, correlation: correlated.proof }, null, 2));
}
