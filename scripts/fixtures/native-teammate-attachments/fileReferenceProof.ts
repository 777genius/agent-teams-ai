import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InboxMessage } from '../../../src/shared/types/team.ts';
import type { Json, StructuredInputObservation } from './harnessSupport.ts';

export async function generateReferenceFixture(runRoot: string) {
  const nonce = randomBytes(16).toString('hex');
  const bytes = Buffer.concat([
    randomBytes(64),
    Buffer.from(`\nNONCE ${nonce}\n`),
    randomBytes(32),
  ]);
  const file = path.join(runRoot, `${randomBytes(10).toString('hex')}.unknown`);
  await writeFile(file, bytes);
  return {
    file,
    nonce,
    length: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | ContentBlock[];
}

interface RecordRow {
  uuid?: string;
  parentUuid?: string;
  type?: string;
  subtype?: string;
  teamName?: string;
  agentName?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  codexNativeThreadId?: string;
  codexNativeThreadStatus?: string;
  codexNativeFinalUsageAuthority?: string;
  toolUseResult?: { exitCode?: number };
  message?: { content?: string | ContentBlock[] };
}

function blocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content)
    ? content.filter((block) => block && typeof block === 'object')
    : [];
}

function textContent(content: string | ContentBlock[] | undefined): string {
  return blocks(content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function originalUserIds(record: RecordRow): string[] {
  if (record.type !== 'user') return [];
  // Tool results are user records too, but cannot establish or cut a human turn.
  return blocks(record.message?.content)
    .filter((block) => block.type === 'text')
    .flatMap((block) =>
      [...(block.text ?? '').matchAll(/^Original User MessageId: ([^\r\n]+)$/gm)].map(
        (match) => match[1]
      )
    );
}

/** Successful saved-byte read, scoped persisted reply, and completion of the same native turn. */
export async function correlateFileReferenceReply(
  sourcePaths: readonly string[],
  original: InboxMessage,
  userRows: readonly InboxMessage[],
  team: string,
  project: string
) {
  const reference = original.fileReferences?.[0];
  if (!reference?.filePath || !reference.sha256 || !original.messageId) return null;
  const bytes = await readFile(reference.filePath);
  assert.equal(bytes.length, reference.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  const nonces = [...bytes.toString('latin1').matchAll(/\nNONCE ([a-f0-9]{32})\n/g)];
  if (nonces.length !== 1) return null;
  const nonce = nonces[0][1];
  const verifiesBytes = (text: string, reply: boolean): boolean => {
    const value = jsonObject(text);
    return (
      value?.binary_length === bytes.length &&
      value.binary_sha256 === reference.sha256 &&
      (reply
        ? value.NONCE === nonce
        : typeof value.bytes_repr === 'string' && value.bytes_repr.includes(`NONCE ${nonce}`))
    );
  };
  for (const sourcePath of sourcePaths) {
    const raw = await readFile(sourcePath, 'utf8').catch(() => '');
    const records = raw.split(/\r?\n/).flatMap((line, index) => {
      const record = jsonObject(line) as RecordRow | null;
      return record ? [{ record, line: index + 1 }] : [];
    });
    const identified = records.filter((item) => item.record.uuid);
    const byId = new Map(identified.map((item) => [item.record.uuid!, item.record]));
    if (byId.size !== identified.length) continue;
    const inbounds = records.filter(
      ({ record }) =>
        record.type === 'user' &&
        record.teamName === team &&
        record.agentName === 'worker' &&
        record.cwd === project &&
        originalUserIds(record).includes(original.messageId!)
    );
    if (inbounds.length !== 1) continue;
    const inbound = inbounds[0];
    if (!inbound.record.uuid || !inbound.record.sessionId) continue;
    const belongs = (record: RecordRow, ancestor = inbound.record.uuid): boolean => {
      const visited = new Set<string>();
      let current: RecordRow | undefined = record;
      while (current?.uuid && !visited.has(current.uuid)) {
        if (
          current.cwd !== project ||
          current.sessionId !== inbound.record.sessionId ||
          current.isSidechain === true ||
          (current.teamName !== undefined && current.teamName !== team) ||
          (current.agentName !== undefined && current.agentName !== 'worker') ||
          originalUserIds(current).some((id) => id !== original.messageId)
        )
          return false;
        if (current.uuid === ancestor) return true;
        visited.add(current.uuid);
        current = current.parentUuid ? byId.get(current.parentUuid) : undefined;
      }
      return false;
    };
    const running = records.find(
      ({ record }) =>
        record.type === 'system' &&
        record.subtype === 'codex_native_thread_status' &&
        record.codexNativeThreadStatus === 'running' &&
        record.codexNativeThreadId &&
        record.parentUuid === inbound.record.uuid &&
        belongs(record)
    );
    if (!running?.record.uuid) continue;
    const summary = records.find(
      ({ record }) =>
        record.type === 'system' &&
        record.subtype === 'codex_native_execution_summary' &&
        record.codexNativeThreadId === running.record.codexNativeThreadId &&
        record.codexNativeFinalUsageAuthority === 'live-turn-completed' &&
        belongs(record, running.record.uuid)
    );
    if (!summary?.record.uuid) continue;
    const completed = records.find(
      ({ record }) =>
        record.type === 'system' &&
        record.subtype === 'codex_native_thread_status' &&
        record.codexNativeThreadStatus === 'completed' &&
        record.codexNativeThreadId === running.record.codexNativeThreadId &&
        belongs(record, summary.record.uuid)
    );
    if (!completed?.record.uuid) continue;
    const toolResult = (tool: RecordRow, id: string) =>
      records.find(
        ({ record }) =>
          record.type === 'user' &&
          record.parentUuid === tool.uuid &&
          belongs(record, running.record.uuid) &&
          blocks(record.message?.content).some(
            (block) =>
              block.type === 'tool_result' && block.tool_use_id === id && block.is_error !== true
          )
      );
    for (const tool of records) {
      if (tool.record.type !== 'assistant' || !belongs(tool.record, running.record.uuid)) continue;
      for (const read of blocks(tool.record.message?.content)) {
        if (
          read.type !== 'tool_use' ||
          !read.id ||
          !/^(?:exec_command|read|read_file|bash|shell|run_command)$/i.test(read.name ?? '') ||
          !(JSON.stringify(read.input) ?? '').includes(reference.filePath)
        )
          continue;
        const result = toolResult(tool.record, read.id);
        const readOutput = blocks(result?.record.message?.content).find(
          (block) =>
            block.type === 'tool_result' && block.tool_use_id === read.id && block.is_error !== true
        );
        if (
          !result?.record.uuid ||
          result.record.toolUseResult?.exitCode !== 0 ||
          !verifiesBytes(textContent(readOutput?.content), false) ||
          !belongs(summary.record, result.record.uuid)
        )
          continue;
        for (const replyTurn of records) {
          if (
            replyTurn.record.type !== 'assistant' ||
            !replyTurn.record.uuid ||
            !belongs(replyTurn.record, result.record.uuid)
          )
            continue;
          for (const relay of blocks(replyTurn.record.message?.content).filter(
            (block) =>
              block.type === 'tool_use' &&
              /^(?:agent-teams_message_send|mcp__agent-teams__message_send)$/.test(block.name ?? '')
          )) {
            const input = relay.input as Record<string, unknown> | undefined;
            if (
              !relay.id ||
              !input ||
              input.teamName !== team ||
              input.to !== 'user' ||
              input.from !== 'worker' ||
              input.source !== 'runtime_delivery' ||
              input.relayOfMessageId !== original.messageId ||
              typeof input.text !== 'string' ||
              !verifiesBytes(input.text, true)
            )
              continue;
            const relayResult = toolResult(replyTurn.record, relay.id);
            const output = blocks(relayResult?.record.message?.content).find(
              (block) =>
                block.type === 'tool_result' &&
                block.tool_use_id === relay.id &&
                block.is_error !== true
            );
            const receipt = jsonObject(textContent(output?.content));
            const delivered = receipt?.message as Record<string, unknown> | undefined;
            if (
              !relayResult?.record.uuid ||
              !belongs(summary.record, relayResult.record.uuid) ||
              receipt?.deliveredToInbox !== true ||
              typeof receipt.messageId !== 'string' ||
              !delivered ||
              delivered.messageId !== receipt.messageId ||
              delivered.from !== 'worker' ||
              delivered.to !== 'user' ||
              delivered.source !== 'runtime_delivery' ||
              delivered.relayOfMessageId !== original.messageId ||
              delivered.text !== input.text
            )
              continue;
            const matches = userRows.filter(
              (row) =>
                row.messageId === receipt.messageId &&
                row.from === 'worker' &&
                row.to === 'user' &&
                row.source === 'runtime_delivery' &&
                row.relayOfMessageId === original.messageId &&
                row.text === input.text
            );
            if (matches.length === 1) return proof(matches[0], replyTurn, relayResult, relay.id);
          }
          const text = textContent(replyTurn.record.message?.content).trim();
          if (!verifiesBytes(text, true) || !belongs(summary.record, replyTurn.record.uuid))
            continue;
          const matches = userRows.filter(
            (row) =>
              row.from === 'worker' &&
              row.text.trim() === text &&
              (!row.relayOfMessageId || row.relayOfMessageId === original.messageId)
          );
          if (matches.length === 1) return proof(matches[0], replyTurn);
        }
        function proof(
          reply: InboxMessage,
          replyTurn: typeof tool,
          relayResult?: typeof tool,
          relayToolId?: string
        ) {
          const input: StructuredInputObservation = {
            sourcePath,
            line: tool.line,
            recordType: 'file_reference_tool_read',
            filePath: reference!.filePath!,
            sha256: reference!.sha256!,
            messageIdObserved: true,
          };
          const observation = (item: typeof tool | undefined) =>
            item ? { line: item.line, uuid: item.record.uuid } : null;
          return {
            reply,
            input,
            proof: {
              sourcePath,
              originalMessageId: original.messageId,
              originalTurnUuid: inbound.record.uuid,
              originalTurn: observation(inbound),
              nativeThreadId: running!.record.codexNativeThreadId,
              running: observation(running),
              toolLine: tool.line,
              read: observation(tool),
              readToolId: read.id,
              readResult: observation(result),
              reply: observation(replyTurn),
              relayToolId,
              relayResult: observation(relayResult),
              persistedReplyMessageId: reply.messageId,
              summary: observation(summary),
              completed: observation(completed),
              toolArguments: [{ name: read.name, input: read.input }],
              savedPath: reference!.filePath,
              sha256: reference!.sha256,
              size: bytes.length,
              nonce,
            } as unknown as Json,
          };
        }
      }
    }
  }
  return null;
}
