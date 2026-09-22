import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isLeadMember } from '@shared/utils/leadDetection';
import { extractToolPreview, formatToolSummaryFromCalls } from '@shared/utils/toolSummary';
import * as fs from 'fs';
import * as path from 'path';

import { extractLeadSessionMessagesFromJsonl } from './leadSessionMessageExtractor';
import { areLeadSessionFileSignaturesEqual, LeadSessionParseCache } from './LeadSessionParseCache';

import type { InboxMessage, TeamConfig, ToolCallMeta } from '@shared/types';

const MIN_TEXT_LENGTH = 30;
const MAX_LEAD_TEXTS = 150;
const LEAD_SESSION_PARSE_CACHE_SCHEMA_VERSION = 'combined-v2';

interface LeadSessionParseCacheKey {
  jsonlPath: string;
  leadSessionId: string;
  leadName: string;
  maxTexts: number;
  schemaVersion: string;
}

interface LeadSessionFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
}

interface TeamLeadSessionProjectContext {
  projectDir: string;
  config: TeamConfig;
}

export interface TeamLeadSessionMessageReaderProjectResolver {
  getLiveBaseContext(teamName: string): Promise<TeamLeadSessionProjectContext | null>;
  getContext(
    teamName: string,
    options: { includeTeamSubagentSessionDiscovery: false }
  ): Promise<TeamLeadSessionProjectContext | null>;
}

export interface TeamLeadSessionMessageReaderParseCache {
  getIfFresh(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature
  ): InboxMessage[] | null;
  getInFlight(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature
  ): Promise<InboxMessage[]> | null;
  setInFlight(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature,
    promise: Promise<InboxMessage[]>
  ): void;
  clearInFlight(key: LeadSessionParseCacheKey, signature: LeadSessionFileSignature): void;
  set(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature,
    messages: readonly InboxMessage[]
  ): void;
}

export class TeamLeadSessionMessageReader {
  static createParseCache(): TeamLeadSessionMessageReaderParseCache {
    return new LeadSessionParseCache();
  }

  constructor(
    private readonly projectResolver: TeamLeadSessionMessageReaderProjectResolver,
    private readonly leadSessionParseCache: TeamLeadSessionMessageReaderParseCache
  ) {}

  read(teamName: string, config: TeamConfig): Promise<InboxMessage[]> {
    return this.extractLeadSessionTexts(teamName, config);
  }

  private async getLeadSessionJsonlPaths(projectDir: string): Promise<Map<string, string>> {
    const jsonlPaths = new Map<string, string>();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return jsonlPaths;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length).trim();
      if (!sessionId || jsonlPaths.has(sessionId)) continue;
      jsonlPaths.set(sessionId, path.join(projectDir, entry.name));
    }

    return jsonlPaths;
  }

  private getRecentLeadSessionIds(config: TeamConfig): string[] {
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    const pushSessionId = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const sessionId = value.trim();
      if (!sessionId || seen.has(sessionId)) return;
      seen.add(sessionId);
      sessionIds.push(sessionId);
    };

    pushSessionId(config.leadSessionId);
    if (Array.isArray(config.sessionHistory)) {
      for (let i = config.sessionHistory.length - 1; i >= 0; i--) {
        pushSessionId(config.sessionHistory[i]);
      }
    }

    return sessionIds;
  }

  private async readLeadSessionJsonlTailLines(jsonlPath: string): Promise<string[]> {
    const MAX_SCAN_BYTES = 8 * 1024 * 1024;
    const handle = await fs.promises.open(jsonlPath, 'r');
    try {
      const stat = await handle.stat();
      const fileSize = stat.size;
      const scanBytes = Math.min(MAX_SCAN_BYTES, fileSize);
      const start = Math.max(0, fileSize - scanBytes);
      const buffer = Buffer.alloc(scanBytes);
      await handle.read(buffer, 0, scanBytes, start);
      const chunk = buffer.toString('utf8');

      const lines = chunk.split(/\r?\n/);
      const fromIndex = start > 0 ? 1 : 0;
      return lines
        .slice(fromIndex)
        .map((line) => line.trim())
        .filter(Boolean);
    } finally {
      await handle.close();
    }
  }

  private async extractLeadAssistantTextsFromJsonlLines(
    rawLines: readonly string[],
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]> {
    if (maxTexts <= 0) return [];
    const seenMessageIds = new Set<string>();
    const texts: InboxMessage[] = [];
    let syntheticBuffer: {
      firstMsg: Record<string, unknown>;
      firstMessage: Record<string, unknown>;
      timestamp: string;
      parts: string[];
    } | null = null;

    const collectToolCallsAfterIndex = (index: number): ToolCallMeta[] | undefined => {
      const toolCallsList: ToolCallMeta[] = [];
      const lookaheadLimit = Math.min(index + 200, rawLines.length);
      for (let j = index + 1; j < lookaheadLimit; j++) {
        const tLine = rawLines[j]?.trim();
        if (!tLine) continue;
        let tMsg: Record<string, unknown>;
        try {
          tMsg = JSON.parse(tLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (tMsg.type !== 'assistant') break;
        const tMessage = (tMsg.message ?? tMsg) as Record<string, unknown>;
        const tContent = tMessage.content;
        if (!Array.isArray(tContent)) continue;
        const tBlocks = tContent as Record<string, unknown>[];
        if (tBlocks.some((b) => b.type === 'text')) break;
        for (const b of tBlocks) {
          if (b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'SendMessage') {
            const input = (b.input ?? {}) as Record<string, unknown>;
            toolCallsList.push({
              name: b.name,
              preview: extractToolPreview(b.name, input),
            });
          }
        }
      }
      return toolCallsList.length > 0 ? toolCallsList : undefined;
    };

    const pushLeadText = (
      msg: Record<string, unknown>,
      message: Record<string, unknown>,
      combined: string,
      timestamp: string,
      toolCalls?: ToolCallMeta[],
      streamGroup = false
    ): void => {
      if (combined.length < MIN_TEXT_LENGTH) return;

      const entryUuid = typeof msg.uuid === 'string' ? msg.uuid.trim() : '';
      const assistantMessageId = typeof message.id === 'string' ? message.id.trim() : '';
      const stableMessageId = entryUuid
        ? streamGroup
          ? `lead-thought-stream-${entryUuid}`
          : `lead-thought-${entryUuid}`
        : assistantMessageId
          ? `lead-thought-msg-${assistantMessageId}`
          : null;

      const textPrefix = combined
        .slice(0, 50)
        .replace(/[^\p{L}\p{N}]/gu, '')
        .slice(0, 20);

      const messageId =
        stableMessageId ?? `lead-session-${leadSessionId}-${timestamp}-${textPrefix}`;
      if (seenMessageIds.has(messageId)) return;
      seenMessageIds.add(messageId);

      const toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
      texts.push({
        from: leadName,
        text: combined,
        timestamp,
        read: true,
        source: 'lead_session',
        leadSessionId,
        messageId,
        toolSummary,
        toolCalls,
      });
    };

    const flushSyntheticBuffer = (): void => {
      if (!syntheticBuffer) return;
      const combined = stripAgentBlocks(syntheticBuffer.parts.join('')).trim();
      pushLeadText(
        syntheticBuffer.firstMsg,
        syntheticBuffer.firstMessage,
        combined,
        syntheticBuffer.timestamp,
        undefined,
        true
      );
      syntheticBuffer = null;
    };

    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i]?.trim();
      if (!trimmed) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (msg.type !== 'assistant') {
        flushSyntheticBuffer();
        continue;
      }

      const message = (msg.message ?? msg) as Record<string, unknown>;
      const content = message.content;
      if (!Array.isArray(content)) {
        flushSyntheticBuffer();
        continue;
      }

      const textParts: string[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        textParts.push(block.text);
      }

      if (textParts.length === 0) {
        if ((content as Record<string, unknown>[]).some((block) => block.type === 'tool_use')) {
          flushSyntheticBuffer();
        }
        continue;
      }

      const timestamp =
        typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();
      const isSyntheticChunk = message.model === '<synthetic>' && message.type === 'message';
      if (isSyntheticChunk) {
        if (!syntheticBuffer) {
          syntheticBuffer = {
            firstMsg: msg,
            firstMessage: message,
            timestamp,
            parts: [],
          };
        }
        syntheticBuffer.parts.push(textParts.join(''));
        continue;
      }

      flushSyntheticBuffer();
      const combined = stripAgentBlocks(textParts.join('\n')).trim();
      pushLeadText(msg, message, combined, timestamp, collectToolCallsAfterIndex(i));
    }

    flushSyntheticBuffer();
    return texts.length > maxTexts ? texts.slice(-maxTexts) : texts;
  }

  private async extractLeadSessionTextsFromJsonl(
    jsonlPath: string,
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]> {
    const cacheKey: LeadSessionParseCacheKey = {
      jsonlPath,
      leadName,
      leadSessionId,
      maxTexts,
      schemaVersion: LEAD_SESSION_PARSE_CACHE_SCHEMA_VERSION,
    };
    const preParseSignature = await this.getLeadSessionFileSignature(jsonlPath);
    if (preParseSignature) {
      const cached = this.leadSessionParseCache.getIfFresh(cacheKey, preParseSignature);
      if (cached) {
        return cached;
      }

      const inFlight = this.leadSessionParseCache.getInFlight(cacheKey, preParseSignature);
      if (inFlight) {
        return inFlight;
      }
    }

    const parse = async (): Promise<InboxMessage[]> => {
      const rawLines = await this.readLeadSessionJsonlTailLines(jsonlPath);
      const [assistantTexts, commandResults] = await Promise.all([
        this.extractLeadAssistantTextsFromJsonlLines(rawLines, leadName, leadSessionId, maxTexts),
        extractLeadSessionMessagesFromJsonl({
          jsonlPath,
          leadName,
          leadSessionId,
          maxMessages: maxTexts,
          rawLines,
        }),
      ]);
      const combined = [...assistantTexts, ...commandResults];
      combined.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      return combined.length > maxTexts ? combined.slice(-maxTexts) : combined;
    };

    if (!preParseSignature) {
      return parse();
    }

    let resolveInFlight!: (messages: InboxMessage[]) => void;
    let rejectInFlight!: (error: unknown) => void;
    const parsePromise = new Promise<InboxMessage[]>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    this.leadSessionParseCache.setInFlight(cacheKey, preParseSignature, parsePromise);
    void parse().then(resolveInFlight, rejectInFlight);

    try {
      const combined = await parsePromise;
      const postParseSignature = await this.getLeadSessionFileSignature(jsonlPath);
      if (
        postParseSignature &&
        areLeadSessionFileSignaturesEqual(preParseSignature, postParseSignature)
      ) {
        this.leadSessionParseCache.set(cacheKey, postParseSignature, combined);
      }
      return combined;
    } finally {
      this.leadSessionParseCache.clearInFlight(cacheKey, preParseSignature);
    }
  }

  private async getLeadSessionFileSignature(
    jsonlPath: string
  ): Promise<LeadSessionFileSignature | null> {
    try {
      const stat = await fs.promises.stat(jsonlPath);
      if (!stat.isFile()) {
        return null;
      }
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(Number.isFinite(stat.ctimeMs) ? { ctimeMs: stat.ctimeMs } : {}),
      };
    } catch {
      return null;
    }
  }

  private async extractLeadSessionTexts(
    teamName: string,
    config: TeamConfig
  ): Promise<InboxMessage[]> {
    const knownLeadSessionIds = this.getRecentLeadSessionIds(config);
    if (knownLeadSessionIds.length === 0) {
      return [];
    }
    const sessionIds = knownLeadSessionIds;
    if (sessionIds.length === 0) {
      return [];
    }

    let transcriptContext = await this.projectResolver.getLiveBaseContext(teamName);
    if (!transcriptContext) {
      transcriptContext = await this.projectResolver.getContext(teamName, {
        includeTeamSubagentSessionDiscovery: false,
      });
    }
    if (!transcriptContext) {
      return [];
    }

    let availableJsonlPaths = await this.getLeadSessionJsonlPaths(transcriptContext.projectDir);
    const primaryLeadSessionId = sessionIds[0];
    const hasPrimaryLeadSessionPath = (): boolean =>
      Boolean(primaryLeadSessionId && availableJsonlPaths.has(primaryLeadSessionId));
    if (!hasPrimaryLeadSessionPath()) {
      const fallbackContext = await this.projectResolver.getContext(teamName, {
        includeTeamSubagentSessionDiscovery: false,
      });
      if (fallbackContext) {
        transcriptContext = fallbackContext;
        availableJsonlPaths = await this.getLeadSessionJsonlPaths(transcriptContext.projectDir);
      }
    }
    if (availableJsonlPaths.size === 0) {
      return [];
    }

    const leadName =
      transcriptContext.config.members?.find((m) => isLeadMember(m))?.name ?? 'team-lead';
    const texts: InboxMessage[] = [];
    for (const sessionId of sessionIds) {
      if (texts.length >= MAX_LEAD_TEXTS) break;
      const jsonlPath = availableJsonlPaths.get(sessionId);
      if (!jsonlPath) continue;
      const remaining = MAX_LEAD_TEXTS - texts.length;
      const sessionTexts = await this.extractLeadSessionTextsFromJsonl(
        jsonlPath,
        leadName,
        sessionId,
        remaining
      );
      if (sessionTexts.length > 0) {
        texts.push(...sessionTexts);
      }
    }

    texts.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return texts.length > MAX_LEAD_TEXTS ? texts.slice(-MAX_LEAD_TEXTS) : texts;
  }
}
