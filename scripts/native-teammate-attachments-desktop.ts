#!/usr/bin/env -S pnpm exec tsx
/**
 * Real-provider native teammate attachment proof.
 *
 * Coordinator-owned execution only. This harness launches the desktop app,
 * creates one disposable TEST team, drives the visible composer with existing
 * CDP primitives, and never installs, mocks, or invokes a synthetic model.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Existing owned-renderer CDP transport. No parallel CDP wrapper is introduced.
// @ts-expect-error Existing JavaScript CDP client has no declaration file.
import { CdpClient } from './e2e/comment-notification/cdp.mjs';
import {
  generateArtifacts,
  type GeneratedArtifacts,
} from './fixtures/native-teammate-attachments/generate.ts';
import {
  callTeamCleanup,
  collectReturnedProviderPaths,
  collectStructuredInput,
  isProcessAlive,
  ownedRuntimeProcesses,
  terminateOwnedApp,
  type CleanupEvidence,
  type HarnessCdp as Cdp,
  type Json,
  type StructuredInputObservation,
} from './fixtures/native-teammate-attachments/harnessSupport.ts';

import type {
  InboxMessage,
  MemberLogSummary,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamCreateResponse,
} from '../src/shared/types/team.ts';

type Provider = 'claude' | 'codex';

interface Args {
  provider: Provider;
  runtimeSource: string;
  scratchRoot: string;
  model?: string;
  keep: boolean;
}

interface NativeState {
  capability: Record<string, Json>;
  admissionSnapshot: Record<string, Json>;
}

interface NativeReadyState {
  state: NativeState & { runtimeSnapshot: TeamAgentRuntimeSnapshot };
  pid: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMBER_NAME = 'worker';
const REQUEST_TIMEOUT_MS = 180_000;
const COMPOSER_ATTACHMENT_INPUT_SELECTOR =
  'div[role="group"] .message-composer-flat-toolbar input[type="file"][multiple]';
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    assert(args[index + 1], `Missing value for ${name}`);
    return args[index + 1];
  };
  const provider = value('--provider');
  assert(provider === 'claude' || provider === 'codex', '--provider must be claude or codex');
  const runtimeSource = value('--runtime-source');
  const scratchRoot = value('--scratch-root');
  assert(runtimeSource, '--runtime-source is required');
  assert(scratchRoot, '--scratch-root is required');
  return {
    provider,
    runtimeSource,
    scratchRoot,
    model: value('--model'),
    keep: args.includes('--keep'),
  };
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

async function bounded<T>(
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

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function gitIdentity(cwd: string): Promise<Record<string, string>> {
  const run = async (args: string[]): Promise<string> => {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
  };
  return {
    commit: await run(['rev-parse', 'HEAD']),
    tree: await run(['rev-parse', '--show-toplevel']),
    statusPorcelain: await run(['status', '--porcelain']),
  };
}

async function assertOwnedScratch(root: string): Promise<string> {
  const resolved = await realpath(root);
  const approvedMacRoot = '/Volumes/Transcend/dev/TEST-native-teammate-attachments-20261012-e2e';
  assert(
    process.platform === 'darwin'
      ? resolved === approvedMacRoot
      : resolved.startsWith('/srv/workers/'),
    process.platform === 'darwin'
      ? `Scratch root must be the approved macOS TEST directory: ${approvedMacRoot}`
      : 'Scratch root must be canonical job-owned /srv/workers/ TEST space'
  );
  return resolved;
}

async function startApp(
  args: Args,
  runRoot: string,
  tmpRoot: string
): Promise<{ child: ChildProcess; logs: string[]; env: NodeJS.ProcessEnv; port: number; cdp: Cdp }> {
  const runtimeSource = await realpath(args.runtimeSource);
  const original = { ...process.env };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(runRoot, 'user-data'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtimeSource,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    TMPDIR: tmpRoot,
    npm_config_cache: path.join(runRoot, 'npm-cache'),
    ELECTRON_CACHE: path.join(runRoot, 'electron-cache'),
  };
  await Promise.all(
    [env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR!, env.TMPDIR!, env.npm_config_cache!, env.ELECTRON_CACHE!].map(
      (dir) => mkdir(dir, { recursive: true })
    )
  );
  if (process.platform === 'darwin') {
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT'] as const) {
      assert.equal(env[key], original[key], `macOS auth root ${key} must remain unchanged`);
    }
    assert(!Object.hasOwn(env, 'CLAUDE_CONFIG_DIR') || env.CLAUDE_CONFIG_DIR === original.CLAUDE_CONFIG_DIR);
  }
  const child = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      if (logs.length > 400) logs.shift();
    });
  }
  let renderer: { port: number; cdp: Cdp } | null = null;
  try {
    renderer = await bounded<{ port: number; cdp: Cdp }>('owned dev:mcp CDP endpoint', async () => {
      if (child.exitCode !== null) throw new Error(`Owned dev:mcp exited ${child.exitCode}`);
      const match = logs
        .join('')
        .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//);
      if (!match) return null;
      const targets = (await fetch(`http://127.0.0.1:${match[1]}/json/list`).then((response) =>
        response.json()
      )) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      for (const target of targets.filter((item) => item.type === 'page')) {
        const cdp = (await CdpClient.connect(target.webSocketDebuggerUrl)) as Cdp;
        try {
          if (await cdp.evaluate<boolean>('Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)')) {
            return { port: Number(match[1]), cdp };
          }
        } finally {
          if (!(await cdp.evaluate<boolean>('Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)').catch(() => false))) {
            await cdp.close().catch(() => undefined);
          }
        }
      }
      return null;
    });
    assert(renderer, 'Owned renderer was not selected');
    await renderer.cdp.send('Runtime.enable');
    await renderer.cdp.send('Page.enable');
    await bounded(
      'desktop API',
      () =>
        renderer!.cdp.evaluate<boolean>(
          'Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)'
        ),
      60_000
    );
    await bounded(
      'desktop startup',
      () =>
        renderer!.cdp.evaluate<boolean>(
          '(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()'
        ),
      60_000
    );
    return { child, logs, env, port: renderer.port, cdp: renderer.cdp };
  } catch (error) {
    const cleanupErrors: Error[] = [];
    await renderer?.cdp.close().catch((cleanupError) => {
      cleanupErrors.push(new Error(`startup CDP cleanup failed: ${String(cleanupError)}`));
    });
    const appCleanup = await terminateOwnedApp(child);
    if (!appCleanup.terminated) {
      cleanupErrors.push(
        new Error(`startup app cleanup failed: ${appCleanup.error ?? 'unknown error'}`)
      );
    }
    await writeFile(path.join(runRoot, 'evidence', 'app.log'), logs.join('')).catch((logError) => {
      cleanupErrors.push(new Error(`startup app log write failed: ${String(logError)}`));
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Owned desktop startup and cleanup both failed'
      );
    }
    throw error;
  }
}

async function click(cdp: Cdp, expression: string): Promise<void> {
  const point = await cdp.evaluate<{ x: number; y: number } | null>(
    `(() => { const element = ${expression}; if (!(element instanceof HTMLElement)) return null; element.scrollIntoView({ block: 'nearest' }); const rect = element.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2; const hit = document.elementFromPoint(x, y); return hit && element.contains(hit) ? { x, y } : null; })()`
  );
  assert(point, `Missing visible click target: ${expression}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1,
    });
  }
}

async function fillComposer(cdp: Cdp, text: string): Promise<void> {
  await bounded('visible composer textarea', async () =>
    cdp.evaluate<boolean>('Boolean(document.querySelector(\'textarea[id^="compose-"]\'))')
  );
  await click(cdp, 'document.querySelector(\'textarea[id^="compose-"]\')');
  await cdp.send('Input.insertText', { text });
}

async function clickSend(cdp: Cdp): Promise<void> {
  const sendExpression = `document.querySelector('.message-composer-send-button')`;
  await bounded('visible enabled composer send button', () =>
    cdp.evaluate<boolean>(
      `(() => { const button = ${sendExpression}; return button instanceof HTMLButtonElement && button.offsetParent !== null && !button.matches(':disabled'); })()`
    )
  );
  await click(cdp, `document.querySelector('textarea[id^="compose-"]')`);
  assert(
    await cdp.evaluate<boolean>(`document.activeElement?.matches('textarea[id^="compose-"]') ?? false`),
    'Composer textarea must be focused before sending'
  );
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
    });
  }
}

async function selectRecipient(cdp: Cdp, member: string): Promise<void> {
  const chatRowExpression = `Array.from(document.querySelectorAll('button')).find((button) => button.offsetParent !== null && button.getAttribute('aria-label')?.startsWith(${literal(`${member},`)}))`;
  await bounded(`visible personal chat row ${member}`, () =>
    cdp.evaluate<boolean>(`Boolean(${chatRowExpression})`)
  );
  await click(cdp, chatRowExpression);
  await bounded(`enabled personal composer for ${member}`, () =>
    cdp.evaluate<boolean>(
      `(() => { const textarea = document.querySelector('textarea[id^="compose-"]'); const locked = document.querySelector('.message-composer-target-selectors'); const back = Array.from(document.querySelectorAll('button')).find((button) => button.offsetParent !== null && button.getAttribute('aria-label') === 'Back to chats'); return Boolean(back) && !document.querySelector('.message-composer-recipient-selector') && locked?.textContent?.trim() === ${literal(member)} && textarea instanceof HTMLTextAreaElement && textarea.offsetParent !== null && !textarea.matches(':disabled') && !textarea.readOnly; })()`
    )
  );
}

async function stageFiles(cdp: Cdp, files: readonly string[]): Promise<void> {
  const documentNode = (await cdp.send('DOM.getDocument', { depth: 1 })) as {
    root: { nodeId: number };
  };
  const input = (await cdp.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: COMPOSER_ATTACHMENT_INPUT_SELECTOR,
  })) as { nodeId: number };
  assert(input.nodeId > 0, 'Visible composer file input was not found');
  await cdp.send('DOM.setFileInputFiles', {
    nodeId: input.nodeId,
    files: [...files],
  });
  await bounded(
    'visible attachment previews',
    () =>
      cdp.evaluate<boolean>(
        `document.querySelectorAll('button[aria-label^="Remove "]').length >= ${files.length}`
      ),
    30_000
  );
}

async function createTeam(
  cdp: Cdp,
  request: TeamCreateRequest
): Promise<TeamCreateResponse> {
  const key = `nativeAttachmentTeamCreate_${randomUUID().replaceAll('-', '')}`;
  await cdp.evaluate(
    `(() => { const target = window; target[${literal(key)}] = { done: false }; window.electronAPI.teams.createTeam(${literal(request)}).then((value) => { target[${literal(key)}] = { done: true, value }; }, (error) => { target[${literal(key)}] = { done: true, error: String(error) }; }); return true; })()`
  );
  const result = await bounded('actual teams.createTeam IPC completion', () =>
    cdp.evaluate<{ value?: TeamCreateResponse; error?: string } | null>(
      `(() => { const result = window[${literal(key)}]; return result?.done ? result : null; })()`
    )
  );
  if (result.error !== undefined) throw new Error(result.error);
  assert(result.value, 'teams.createTeam completed without a response');
  return result.value;
}

async function rows(teamDir: string, member = MEMBER_NAME): Promise<InboxMessage[]> {
  try {
    return JSON.parse(
      await readFile(path.join(teamDir, 'inboxes', `${member}.json`), 'utf8')
    ) as InboxMessage[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readNativeState(teamDir: string, team: string): Promise<NativeState> {
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

async function waitForAttachmentRow(
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

async function correlateClaudeReply(
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

async function correlateCodexFallback(
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

async function verifyExistingCodexRun(): Promise<void> {
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

async function verifyExistingClaudeRun(): Promise<void> {
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

async function main(): Promise<void> {
  const args = parseArgs();
  const scratch = await assertOwnedScratch(args.scratchRoot);
  const runtimeSource = await realpath(args.runtimeSource);
  const runRoot = await mkdtemp(path.join(scratch, `native-attachments-${args.provider}-TEST-`));
  const evidenceRoot = path.join(runRoot, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const startedAt = Date.now();
  const runId = randomUUID();
  const team = `test-na-${randomBytes(7).toString('hex')}`;
  const project = path.join(scratch, `TEST-native-project-${randomBytes(8).toString('hex')}`);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'README.md'), '# Disposable native attachment TEST project\n');
  const evidence: Record<string, Json> = {
    schemaVersion: 1,
    startedAt: new Date(startedAt).toISOString(),
    runId,
    provider: args.provider,
    platform: process.platform,
    scratchRoot: scratch,
    runRoot,
    project,
    team,
    runtimeSource,
    sourceIdentity: {
      app: await gitIdentity(repoRoot),
      runtime: await gitIdentity(path.dirname(runtimeSource)),
      runtimeLock: JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8')),
    },
    timeline: [] as Json[],
  };
  const timeline = async (event: Record<string, Json>): Promise<void> => {
    (evidence.timeline as Json[]).push({ at: new Date().toISOString(), ...event });
    await json(path.join(evidenceRoot, 'evidence.json'), evidence);
  };
  let app: ChildProcess | undefined;
  let appLogs: string[] = [];
  let cdp: Cdp | undefined;
  let artifacts: GeneratedArtifacts;
  let readyState: NativeReadyState | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let tmpRoot = path.join(runRoot, 'tmp');
  const cleanup: CleanupEvidence = {
    teamAttempted: false,
    runtimeSnapshotAvailableBefore: false,
    ownedRuntimeProcesses: [],
    ownedRuntimeTerminal: false,
    app: { terminated: false },
    project: args.keep ? 'kept' : 'removed',
    errors: [],
  };
  try {
    if (process.platform === 'darwin') {
      tmpRoot = await mkdtemp('/private/tmp/na-e2e-');
      evidence.ownedShortTmpRoot = tmpRoot;
    }
    const started = await startApp(args, runRoot, tmpRoot);
    app = started.child;
    appLogs = started.logs;
    cdp = started.cdp;
    artifacts = await generateArtifacts(cdp, runRoot);
    evidence.generatedExpected = artifacts.expected as unknown as Json;
    evidence.fixtureDigests = artifacts.digests;
    await timeline({ phase: 'start' });
    await timeline({ phase: 'desktop-ready', port: started.port });
    const request: TeamCreateRequest = {
      teamName: team,
      cwd: project,
      providerId: args.provider === 'claude' ? 'anthropic' : 'codex',
      ...(args.model ? { model: args.model } : {}),
      syncModelsWithLead: false,
      skipPermissions: true,
      prompt:
        'Disposable TEST-only run. Remain idle: do not create or inspect files, and do not create or assign tasks. Reply READY, then wait for user direct messages. Work only inside this TEST project; do not inspect other paths.',
      members: [
        {
          name: MEMBER_NAME,
          providerId: args.provider === 'claude' ? 'anthropic' : 'codex',
          ...(args.model ? { model: args.model } : {}),
          role: 'Native attachment E2E worker',
        },
      ],
    };
    cleanup.teamAttempted = true;
    const launch = await createTeam(cdp, request);
    await timeline({
      phase: 'team-created',
      request: JSON.parse(JSON.stringify(request)) as Json,
      launch: JSON.parse(JSON.stringify(launch)) as Json,
    });
    await bounded('owned team in dev store', async () => {
      await cdp!.evaluate(
        `(async () => { const state = window.__agentTeamsDevStore.getState(); await state.fetchTeams(); return window.__agentTeamsDevStore.getState().teams.some((team) => team.teamName === ${literal(team)}); })()`
      );
      return cdp!.evaluate<boolean>(
        `window.__agentTeamsDevStore.getState().teams.some((team) => team.teamName === ${literal(team)})`
      );
    });
    await cdp.evaluate(
      `(async () => { const state = window.__agentTeamsDevStore.getState(); state.openTeamTab(${literal(team)}, ${literal(project)}); await state.selectTeam(${literal(team)}, { skipProjectAutoSelect: true }); state.setMessagesPanelMode('sidebar'); })()`
    );
    const teamDir = path.join(
      started.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT ??
        process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT ??
        path.join(os.homedir(), '.claude'),
      'teams',
      team
    );
    readyState = await bounded<NativeReadyState>('current native attachment runtime readiness', async () => {
      const state = await readNativeState(teamDir, team).catch(() => null);
      const runtime = await cdp!.evaluate<TeamAgentRuntimeSnapshot>(
        `window.electronAPI.teams.getTeamAgentRuntime(${literal(team)})`
      );
      const member = runtime.members[MEMBER_NAME];
      if (!state || !member?.alive) return null;
      const pid = member.runtimePid ?? member.pid;
      if (!pid || state.capability.pid !== pid || state.capability.nativeInboxAttachmentsVersion !== 1) return null;
      return { state: { ...state, runtimeSnapshot: runtime }, pid };
    });
    evidence.runtimeIdentity = readyState as unknown as Json;
    await timeline({ phase: 'native-ready', pid: readyState.pid });
    await bounded('selected team provisioning ready', () =>
      cdp!.evaluate<boolean>(
        `(() => { const state = window.__agentTeamsDevStore.getState(); const runId = state.currentProvisioningRunIdByTeam[${literal(team)}]; return state.provisioningRuns[runId]?.state === 'ready'; })()`
      )
    );
    await timeline({ phase: 'team-ui-ready' });
    await cdp.evaluate(
      `(async () => { const state = window.__agentTeamsDevStore.getState(); state.openTeamTab(${literal(team)}, ${literal(project)}); await state.selectTeam(${literal(team)}, { skipProjectAutoSelect: true }); state.setMessagesPanelMode('sidebar'); })()`
    );
    await bounded('rendered owned team tab after provisioning', () =>
      cdp!.evaluate<boolean>(
        `(() => { const state = window.__agentTeamsDevStore.getState(); const pane = state.paneLayout.panes.find((item) => item.id === state.paneLayout.focusedPaneId); const tab = pane?.tabs.find((item) => item.id === pane.activeTabId); return tab?.type === 'team' && tab.teamName === ${literal(team)} && state.selectedTeamName === ${literal(team)} && Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).some((element) => element instanceof HTMLElement && element.offsetParent !== null && element.textContent?.includes(${literal(team)})); })()`
      )
    );
    await selectRecipient(cdp, MEMBER_NAME);
    await bounded('real composer attachment control enabled', async () =>
      cdp!.evaluate<boolean>(
        `(() => { const input = document.querySelector(${literal(COMPOSER_ATTACHMENT_INPUT_SELECTOR)}); const button = input?.nextElementSibling; return Boolean(button instanceof HTMLButtonElement && button.querySelector('svg.lucide-paperclip') && !button.matches(':disabled') && button.offsetParent !== null); })()`
      )
    );
    let admissionStatus = 'idle';
    if (args.provider === 'codex') {
      await fillComposer(
        cdp,
        'Run the shell command `sleep 15` exactly once inside this TEST project, then reply TURN COMPLETE. Do not inspect or modify any other files.'
      );
      await clickSend(cdp);
      await bounded('actual busy admission state', async () => {
        const state = await readNativeState(teamDir, team).catch(() => null);
        if (state?.admissionSnapshot.status === 'running') {
          admissionStatus = 'running';
          return true;
        }
        return false;
      });
      await timeline({ phase: 'busy-observed', admissionStatus });
    }
    const existingIds = new Set<string>(
      (await rows(teamDir))
        .map((row) => row.messageId)
        .filter((id): id is string => Boolean(id))
    );
    const attachmentFiles =
      args.provider === 'claude'
        ? [artifacts.files.image, artifacts.files.text, artifacts.files.pdf]
        : [artifacts.files.image];
    await stageFiles(cdp, attachmentFiles);
    await fillComposer(
      cdp,
      args.provider === 'claude'
        ? 'Inspect every attached file directly. Return one JSON object with keys image_token, color_order, layout_code, text_token, and pdf_token. Use only content visible inside the attachments; do not use filenames or tool file reads.'
        : 'Inspect the attached image directly. Return one JSON object with keys image_token, color_order, and layout_code. Use only content visible inside the image; do not use filenames or tool file reads.'
    );
    await clickSend(cdp);
    const digestSet =
      args.provider === 'claude'
        ? Object.values(artifacts.digests)
        : [artifacts.digests.image];
    const original = await waitForAttachmentRow(teamDir, digestSet, existingIds);
    const originalMessageId = original.messageId ?? '';
    const originalReadAtSend = original.read;
    await json(path.join(evidenceRoot, 'original-attachment-row.json'), original);
    await timeline({ phase: 'attachment-admitted', original: original as unknown as Json });
    if (args.provider === 'codex') {
      assert.equal(originalReadAtSend, false, 'busy attachment message must remain unread');
      assert.equal(admissionStatus, 'running', 'Codex attachment must arrive during an observed active turn');
      await timeline({ phase: 'busy-unread-observed', messageId: originalMessageId });
      await bounded('idle after the active harmless turn', async () => {
        const state = await readNativeState(teamDir, team).catch(() => null);
        return state?.admissionSnapshot.status !== 'running';
      });
      await timeline({ phase: 'idle-observed', messageId: originalMessageId });
    }
    const readProof = await bounded('native inbox read proof', async () => {
      const current = (await rows(teamDir)).find((row) => row.messageId === original.messageId);
      return current?.read === true ? current : null;
    });
    await json(path.join(evidenceRoot, 'original-read-proof.json'), readProof);
    let logs: MemberLogSummary[] = [];
    let sourcePaths: string[] = [];
    let claudeCorrelation: Json = null;
    let codexCorrelation: Json = null;
    let codexFileInput: StructuredInputObservation | null = null;
    const reply = await bounded('correlated persisted native reply', async () => {
      const userRows = await rows(teamDir, 'user');
      await json(path.join(evidenceRoot, 'observed-user-inbox.json'), userRows);
      if (args.provider === 'codex') {
        const relay = userRows.find((row) => row.from === MEMBER_NAME && row.relayOfMessageId === original.messageId);
        if (relay) return relay;
      }
      logs = await cdp!.evaluate<MemberLogSummary[]>(
        `window.electronAPI.teams.getMemberLogs(${literal(team)}, ${literal(MEMBER_NAME)})`
      );
      sourcePaths = collectReturnedProviderPaths(logs, readyState?.state);
      await json(path.join(evidenceRoot, 'returned-provider-paths.json'), sourcePaths);
      if (args.provider === 'codex') {
        const fallback = await correlateCodexFallback(sourcePaths, readProof, userRows, team, project);
        if (!fallback) return null;
        codexCorrelation = fallback.proof;
        codexFileInput = fallback.input;
        return fallback.reply;
      }
      const correlated = await correlateClaudeReply(sourcePaths, original, userRows, team, project);
      if (!correlated) return null;
      claudeCorrelation = correlated.proof;
      return correlated.reply;
    });
    await json(path.join(evidenceRoot, 'correlated-reply.json'), { reply, claudeCorrelation, codexCorrelation });
    if (args.provider === 'codex') {
      logs = await cdp.evaluate<MemberLogSummary[]>(
        `window.electronAPI.teams.getMemberLogs(${literal(team)}, ${literal(MEMBER_NAME)})`
      );
      sourcePaths = collectReturnedProviderPaths(logs, readyState?.state);
    }
    const expectedPaths = new Set(
      (original.attachments ?? []).map((item) => item.filePath)
        .filter((item): item is string => Boolean(item)).map((item) => path.resolve(item))
    );
    const expectedDigests = new Set(
      (original.attachments ?? []).map((item) => item.sha256)
        .filter((item): item is string => Boolean(item))
    );
    const providerInput = await collectStructuredInput(sourcePaths, expectedDigests, expectedPaths, original.messageId!);
    if (codexFileInput) providerInput.push(codexFileInput);
    assert(providerInput.some((item) => item.messageIdObserved), 'provider input was not correlated to the original message ID');
    if (args.provider === 'claude') {
      assert(
        providerInput.some(
          (item) => item.sha256 === artifacts.digests.image && item.encoding === 'base64'
        ),
        'Claude base64 image input was not observed'
      );
      assert(
        providerInput.some(
          (item) => item.sha256 === artifacts.digests.pdf && item.encoding === 'base64'
        ),
        'Claude base64 PDF input was not observed'
      );
      assert(
        providerInput.some(
          (item) => item.sha256 === artifacts.digests.text && item.encoding === 'utf8'
        ),
        'Claude UTF8 text input digest was not observed'
      );
    } else {
      const localImage = providerInput.find(
        (item) =>
          ((item.recordType === 'codex_turn_start_localImage' && item.argumentShape === '{type:localImage,path}') ||
            (item.recordType === 'codex_provider_bound_file_image' && codexCorrelation !== null)) &&
          item.filePath &&
          expectedPaths.has(path.resolve(item.filePath))
      );
      assert(localImage, 'Codex native localImage or completed provider-bound file-image proof was not observed');
      assert.equal(localImage.sha256, artifacts.digests.image, 'Codex image bytes changed after admission');
    }
    const replyText = reply.text;
    assert(replyText.includes(artifacts.expected.imageToken), 'reply did not identify image token');
    assert(replyText.includes(artifacts.expected.layoutCode), 'reply did not identify image layout');
    const colorIndexes = artifacts.expected.colorOrder.map((color) => replyText.indexOf(color));
    assert(
      colorIndexes.every((index) => index >= 0) &&
        colorIndexes.every((index, order) => order === 0 || index > colorIndexes[order - 1]),
      'reply did not preserve visible color order'
    );
    if (args.provider === 'claude') {
      assert(replyText.includes(artifacts.expected.textToken), 'reply did not identify text marker');
      assert(replyText.includes(artifacts.expected.pdfToken), 'reply did not identify PDF marker');
    }
    await cdp.screenshot(path.join(evidenceRoot, 'desktop.png'));
    evidence.result = {
      outcome: 'source-live-verified',
      messageId: original.messageId,
      attachmentIds: (original.attachments ?? []).map((item) => item.id),
      persistedAttachments: original.attachments,
      originalReadAtSend,
      readProof: { messageId: readProof.messageId, read: readProof.read, timestamp: readProof.timestamp },
      reply: { messageId: reply.messageId, relayOfMessageId: reply.relayOfMessageId, text: replyText },
      providerInput,
      claudeCorrelation,
      codexCorrelation,
      memberLogs: logs,
    } as unknown as Json;
    await timeline({ phase: 'verified', result: evidence.result });
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    await cdp?.screenshot(path.join(evidenceRoot, 'failure.png')).catch(() => undefined);
    evidence.failure = {
      message: error instanceof Error ? error.stack : String(error),
      body: await cdp?.evaluate<string>('document.body.innerText').catch(() => undefined),
    } as unknown as Json;
    await timeline({ phase: 'failed', error: evidence.failure }).catch((timelineError) => {
      cleanup.errors.push(`failure evidence write: ${String(timelineError)}`);
    });
  } finally {
    if (cleanup.teamAttempted && cdp) {
      let beforeSnapshot: TeamAgentRuntimeSnapshot | null = null;
      try {
        beforeSnapshot = await cdp.evaluate<TeamAgentRuntimeSnapshot>(
          `window.electronAPI.teams.getTeamAgentRuntime(${literal(team)})`
        );
        cleanup.runtimeSnapshotAvailableBefore = true;
      } catch (error) {
        cleanup.errors.push(`owned runtime snapshot before cleanup: ${String(error)}`);
      }
      cleanup.ownedRuntimeProcesses = ownedRuntimeProcesses(beforeSnapshot).map((item) => ({
        ...item,
        aliveBefore: isProcessAlive(item.pid),
        aliveAfter: true,
        terminal: false,
      }));
      const stopResult = await callTeamCleanup(cdp, 'stop', team);
      const deleteResult = await callTeamCleanup(cdp, 'deleteTeam', team);
      cleanup.stop = stopResult;
      cleanup.delete = deleteResult;
      await delay(250);
      for (const proof of cleanup.ownedRuntimeProcesses) {
        proof.aliveAfter = isProcessAlive(proof.pid);
        proof.terminal = !proof.aliveAfter;
      }
      cleanup.ownedRuntimeTerminal =
        cleanup.runtimeSnapshotAvailableBefore &&
        cleanup.ownedRuntimeProcesses.every((proof) => proof.terminal);
      if (!stopResult.ok) cleanup.errors.push(`team stop failed: ${stopResult.error}`);
      if (!deleteResult.ok) cleanup.errors.push(`team delete failed: ${deleteResult.error}`);
      if (!cleanup.ownedRuntimeTerminal) {
        cleanup.errors.push('owned team runtime terminal proof was not established');
      }
    } else if (cleanup.teamAttempted) {
      cleanup.errors.push('team cleanup could not run because the owned CDP handle was unavailable');
    } else {
      cleanup.ownedRuntimeTerminal = true;
    }
    await cdp?.close().catch((error) => {
      cleanup.errors.push(`owned CDP close failed: ${String(error)}`);
    });
    if (app) {
      cleanup.app = await terminateOwnedApp(app);
      if (!cleanup.app.terminated) {
        cleanup.errors.push(`owned app termination failed: ${cleanup.app.error ?? 'unknown error'}`);
      }
    }
    if (process.platform === 'darwin' && evidence.ownedShortTmpRoot) {
      evidence.ownedShortTmpCleanup = 'retained';
      if (cleanup.app.terminated && cleanup.ownedRuntimeTerminal) {
        try {
          await rm(tmpRoot, { recursive: true, force: true });
          evidence.ownedShortTmpCleanup = 'removed';
        } catch (error) {
          cleanup.errors.push(`owned short temp removal failed: ${String(error)}`);
        }
      }
    }
    try {
      if (app) await writeFile(path.join(evidenceRoot, 'app.log'), appLogs.join(''));
    } catch (error) {
      cleanup.errors.push(`app log write failed: ${String(error)}`);
    }
    if (args.keep) cleanup.project = 'kept';
    else {
      try {
        await rm(project, { recursive: true, force: true });
        cleanup.project = 'removed';
      } catch (error) {
        cleanup.project = 'remove-failed';
        cleanup.errors.push(`TEST project removal failed: ${String(error)}`);
      }
    }
    await timeline({ phase: 'cleanup', cleanup: cleanup as unknown as Json }).catch((error) => {
      cleanup.errors.push(`cleanup evidence write failed: ${String(error)}`);
    });
    try {
      await json(path.join(evidenceRoot, 'result.json'), {
        ...evidence,
        cleanup: cleanup as unknown as Json,
      });
    } catch (error) {
      cleanup.errors.push(`result evidence write failed: ${String(error)}`);
    }
  }
  if (hasPrimaryError) {
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanup.errors.map((error) => new Error(error))],
        'Native attachment E2E and owned cleanup both failed'
      );
    }
    throw primaryError;
  }
  if (cleanup.errors.length > 0) {
    throw new AggregateError(
      cleanup.errors.map((error) => new Error(error)),
      'Native attachment E2E completed but owned cleanup failed'
    );
  }
}

(process.argv.includes('--verify-existing-codex') ? verifyExistingCodexRun() : process.argv.includes('--verify-existing') ? verifyExistingClaudeRun() : main()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
