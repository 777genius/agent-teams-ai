import { isParsedSystemChunkMessage, isParsedUserChunkMessage, isTextContent } from '@main/types';
import { parseJsonlLine } from '@main/utils/jsonl';
import { createHash } from 'crypto';
import * as fs from 'fs';

import { extractCommandOutputInfo, extractSlashInfo } from '@shared/utils/contentSanitizer';
import { buildSlashCommandMeta } from '@shared/utils/slashCommands';

import type { ParsedMessage } from '@main/types';
import type { CommandOutputMeta, InboxMessage, SlashCommandMeta } from '@shared/types';

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const INITIAL_SCAN_BYTES = 256 * 1024;

interface LeadSessionMessageExtractorOptions {
  jsonlPath: string;
  leadName: string;
  leadSessionId: string;
  maxMessages: number;
}

function getMessageText(message: ParsedMessage): string {
  if (typeof message.content === 'string') {
    return message.content.trim();
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter(isTextContent)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function buildScanKey(message: ParsedMessage, rawLine: string): string {
  if (typeof message.uuid === 'string' && message.uuid.trim()) {
    return message.uuid.trim();
  }

  return `${message.timestamp.toISOString()}\0${rawLine}`;
}

function summarizeCommandOutput(output: string): string {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function buildSlashMetaFromParsedMessage(message: ParsedMessage): SlashCommandMeta | null {
  const slash = extractSlashInfo(getMessageText(message));
  if (!slash) return null;
  return buildSlashCommandMeta(slash.name, slash.args, `/${slash.name}`);
}

function buildCommandOutputMeta(
  pendingSlash: SlashCommandMeta | null,
  stream: CommandOutputMeta['stream']
): CommandOutputMeta {
  return {
    stream,
    commandLabel: pendingSlash?.command ?? '/command',
  };
}

function buildResultMessageId(message: ParsedMessage, output: string): string {
  const uuid = typeof message.uuid === 'string' ? message.uuid.trim() : '';
  if (uuid) {
    return `lead-command-result-${uuid}`;
  }

  return `lead-command-result-${createHash('sha256').update(`${message.timestamp.toISOString()}\n${output}`).digest('hex').slice(0, 16)}`;
}

function canMergeCommandOutput(
  previousMessage: InboxMessage | undefined,
  commandOutput: CommandOutputMeta,
  previousWasCommandOutput: boolean
): previousMessage is InboxMessage & { commandOutput: CommandOutputMeta } {
  if (!previousWasCommandOutput || !previousMessage?.commandOutput) {
    return false;
  }

  return (
    previousMessage.messageKind === 'slash_command_result' &&
    previousMessage.commandOutput.stream === commandOutput.stream &&
    previousMessage.commandOutput.commandLabel === commandOutput.commandLabel
  );
}

export async function extractLeadSessionMessagesFromJsonl({
  jsonlPath,
  leadName,
  leadSessionId,
  maxMessages,
}: LeadSessionMessageExtractorOptions): Promise<InboxMessage[]> {
  if (maxMessages <= 0) return [];

  const parsedMessagesReversed: ParsedMessage[] = [];
  const seenScanKeys = new Set<string>();
  const handle = await fs.promises.open(jsonlPath, 'r');

  try {
    const stat = await handle.stat();
    const fileSize = stat.size;

    let scanBytes = Math.min(INITIAL_SCAN_BYTES, fileSize);
    while (scanBytes <= MAX_SCAN_BYTES) {
      const start = Math.max(0, fileSize - scanBytes);
      const buffer = Buffer.alloc(scanBytes);
      await handle.read(buffer, 0, scanBytes, start);
      const chunk = buffer.toString('utf8');

      const lines = chunk.split(/\r?\n/);
      const fromIndex = start > 0 ? 1 : 0;

      for (let i = lines.length - 1; i >= fromIndex; i--) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;

        let parsed: ParsedMessage | null = null;
        try {
          parsed = parseJsonlLine(trimmed);
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.isSidechain) continue;

        const scanKey = buildScanKey(parsed, trimmed);
        if (seenScanKeys.has(scanKey)) continue;
        seenScanKeys.add(scanKey);
        parsedMessagesReversed.push(parsed);
      }

      if (scanBytes === fileSize) break;
      scanBytes = Math.min(fileSize, scanBytes * 2);
    }
  } finally {
    await handle.close();
  }

  const parsedMessages = parsedMessagesReversed.reverse();
  const extractedMessages: InboxMessage[] = [];
  let pendingSlash: SlashCommandMeta | null = null;
  let previousWasCommandOutput = false;

  for (const message of parsedMessages) {
    if (isParsedUserChunkMessage(message)) {
      pendingSlash = buildSlashMetaFromParsedMessage(message);
      previousWasCommandOutput = false;
      continue;
    }

    if (!isParsedSystemChunkMessage(message)) {
      previousWasCommandOutput = false;
      continue;
    }

    const outputInfo = extractCommandOutputInfo(getMessageText(message));
    if (!outputInfo?.output) {
      previousWasCommandOutput = false;
      continue;
    }

    const commandOutput = buildCommandOutputMeta(pendingSlash, outputInfo.stream);
    const previousMessage = extractedMessages[extractedMessages.length - 1];
    if (canMergeCommandOutput(previousMessage, commandOutput, previousWasCommandOutput)) {
      previousMessage.text = `${previousMessage.text}\n${outputInfo.output}`;
      previousMessage.summary = summarizeCommandOutput(previousMessage.text) || undefined;
      previousWasCommandOutput = true;
      continue;
    }

    extractedMessages.push({
      from: leadName,
      text: outputInfo.output,
      timestamp: message.timestamp.toISOString(),
      read: true,
      source: 'lead_session',
      leadSessionId,
      messageId: buildResultMessageId(message, outputInfo.output),
      messageKind: 'slash_command_result',
      commandOutput,
      summary: summarizeCommandOutput(outputInfo.output) || undefined,
    });
    previousWasCommandOutput = true;
  }

  return extractedMessages.length > maxMessages
    ? extractedMessages.slice(-maxMessages)
    : extractedMessages;
}
