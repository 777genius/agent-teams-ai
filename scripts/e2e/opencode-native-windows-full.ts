/** Real Windows packaged task qualification. Never enables the production gate.
 * Inputs: packaged.exe, SDK cli|bundled, pinned OpenCode.exe, provider/model,
 * explicit host-local TEST auth.json. No ambient credentials are imported.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { redactLaunchFailureArtifactText } from '../../src/main/services/team/TeamLaunchFailureArtifactPack';
import {
  NativeDesktopIpcError,
  prepareNativeDesktop,
  safeIpcFailureDetail,
} from './opencode-native-desktop-host';
import {
  protectWindowsTestDirectory,
  seedWindowsTestModelOutputLimit,
} from './opencode-native-test-auth';
import { waitFor } from './release-updater/cdp.mts';
import type { electronTeamPort } from './opencode-native-team-port';

const execute = promisify(execFile);
// The qualified Windows candidate retains over 82k files and about 15 MiB of digests.
const BUNDLED_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const BUNDLED_MANIFEST_MAX_ENTRIES = 131_072;
const V1_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
// Only existing SDK read-only history/parser modules are imported. In
// particular this never imports the profile/session bridge or prepares a host.
export const V1_OFFLINE_TRANSCRIPT_SCRIPT = String.raw`
import assert from 'node:assert/strict';
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const input=JSON.parse(process.env.OPENCODE_TEST_NATIVE_TRANSCRIPT_INPUT);
const same=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const file=async(p,cap)=>{const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=cap&&same(await realpath(p),p));return readFile(p,'utf8')};
const store=JSON.parse(await file(path.join(input.dataRoot,'opencode','session-store.json'),4194304));
assert(store.schemaVersion===1&&store.records&&typeof store.records==='object'&&!Array.isArray(store.records));
const matches=Object.entries(store.records).filter(([key,r])=>r&&key===r.teamId+'::'+(r.laneId??'primary')+'::'+r.memberName&&r.teamId===input.teamName&&r.memberName===input.member&&r.opencodeSessionId===input.sessionId&&r.runId===input.runId&&same(r.projectPath,input.projectPath));
assert(matches.length===1);
const record=matches[0][1];
assert(typeof record.profileRootKey==='string'&&/^[A-Za-z0-9._-]{1,256}$/.test(record.profileRootKey)&&!['.','..'].includes(record.profileRootKey));
const {OpenCodeOfflineSessionReader}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/OpenCodeOfflineSessionReader.ts')).href);
const {openCodeTranscriptProjector}=await import(pathToFileURL(path.join(input.sdkRoot,'src/services/opencode/OpenCodeTranscriptProjector.ts')).href);
const reader=new OpenCodeOfflineSessionReader(input.dataRoot);
const db=reader.resolveDbPath(record.profileRootKey);
assert(db&&same(await realpath(db),db)&&(await lstat(db)).isFile());
const history=await reader.readSession(record);
assert(history&&history.historyShape==='supported'&&history.historyComplete===true&&history.sessionIdentity?.sessionId===input.sessionId&&same(history.sessionIdentity.directory,input.projectPath));
assert(history.messages.length<=32&&history.rawParts.length<=512);
const projection=openCodeTranscriptProjector.projectSessionMessages({sessionId:input.sessionId,messages:history.messages});
for(const message of projection.messages){
 const raw=history.messages.find(row=>row.info.id===message.id);
 assert(raw);
 if(raw.info.error){message.errorMessage=JSON.stringify(raw.info.error);message.errorName=raw.info.error.name??message.errorName;message.hasError=true}
 message.nativeTokens=raw.info.tokens;
 for(const tool of message.toolCalls){
  const parts=raw.parts.filter(part=>part.type==='tool'&&part.callID===tool.callId);
  assert(parts.length===1);
  tool.nativeStatus=parts[0].state?.status;
  if(parts[0].state?.error)tool.outputText=typeof parts[0].state.error==='string'?parts[0].state.error:JSON.stringify(parts[0].state.error);
 }
}
const output=JSON.stringify({schemaVersion:1,providerId:'opencode',transcript:{...projection,durableState:record.lastKnownDurableState}});
assert(Buffer.byteLength(output)<=2097152);
await writeFile(input.output,output,{flag:'wx',mode:0o600});
`;

/** TEST-only projection of the existing SDK canonical transcript, before Stop.
 * Keep native turn boundaries that the display/task-log projection omits. */
export function projectV1NativeTranscript(
  value: unknown,
  expected: { sessionId: string; teamName: string; taskId: string }
) {
  const record = (input: unknown): Record<string, unknown> =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const root = record(value),
    transcript = record(root.transcript);
  assert(root.schemaVersion === 1 && root.providerId === 'opencode');
  assert(transcript.sessionId === expected.sessionId && Array.isArray(transcript.messages));
  assert(/^test-opencode-[a-zA-Z0-9-]+$/.test(expected.teamName));
  assert(/^[a-f0-9-]{36}$/.test(expected.taskId));
  assert(transcript.messages.length <= 32);
  const messages = transcript.messages.map(record);
  const tools = (message: Record<string, unknown>) => {
    assert(Array.isArray(message.toolCalls) && message.toolCalls.length <= 64);
    return message.toolCalls.map(record);
  };
  const toolName = (input: unknown) => {
    const normalized =
      typeof input === 'string'
        ? input
            .toLowerCase()
            .replace(/^proxy_/, '')
            .replace(/^(?:mcp__agent[-_]teams__|agent[-_]teams_)/, '')
        : '';
    return (
      [
        'task_get',
        'task_list',
        'task_add_comment',
        'task_complete',
        'message_send',
        'read',
        'bash',
        'edit',
        'write',
        'apply_patch',
        'glob',
        'grep',
        'list',
        'question',
        'todoread',
        'todowrite',
        'runtime_bootstrap_checkin',
        'member_briefing',
      ].find((name) => name === normalized) ?? 'other'
    );
  };
  // Native canonical error messages can retain provider JSON that the delivery
  // ledger has already reduced to plain text. Never emit that original JSON.
  const failure = (message: unknown, nativeName?: unknown, allowDetail = false) => {
    const original = typeof message === 'string' ? message : '';
    const text = original.slice(0, 32_768);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      try {
        decoded = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      } catch {
        /* Plain native error message. */
      }
    }
    const parsed = record(decoded),
      error = record(parsed.error);
    const rows = [parsed, error, record(error.data ?? parsed.data)];
    const names = [
      'APIError',
      'APICallError',
      'AI_APICallError',
      'ProviderAuthError',
      'MessageAbortedError',
      'ContextOverflowError',
      'StructuredOutputError',
      'UnknownError',
      'NoOutputGeneratedError',
      'NoObjectGeneratedError',
      'InvalidResponseDataError',
      'TypeValidationError',
      'InvalidPromptError',
      'UnsupportedFunctionalityError',
      'ModelNotFoundError',
    ];
    const codes = [
      'insufficient_credits',
      'insufficient_quota',
      'rate_limit_exceeded',
      'invalid_api_key',
      'context_length_exceeded',
      'max_tokens_exceeded',
      'model_not_found',
      'invalid_request_error',
      'invalid_request',
      'authentication_error',
      'permission_denied',
      'server_error',
      'overloaded_error',
      'billing_error',
    ];
    const integer = (input: unknown, min: number, max: number) =>
      Number.isSafeInteger(input) && Number(input) >= min && Number(input) <= max
        ? Number(input)
        : null;
    const tokens = (pattern: RegExp) => integer(Number(pattern.exec(text)?.[1]), 1, 10_000_000);
    return {
      present: original.length > 0 || typeof nativeName === 'string',
      inspectedCharacters: text.length,
      truncated: original.length > text.length,
      name:
        names.find((name) => nativeName === name || rows.some((row) => row.name === name)) ?? null,
      providerCode: codes.find((code) => rows.some((row) => row.code === code)) ?? null,
      httpStatus:
        rows
          .flatMap((row) => [row.statusCode, row.status, row.code])
          .map((code) => integer(code, 100, 599))
          .find((code) => code !== null) ?? null,
      retryable:
        rows.map((row) => row.isRetryable).find((flag) => typeof flag === 'boolean') ?? null,
      requestedTokens: tokens(/requested(?: up to)?\s+(\d+)\s+tokens/i),
      affordableTokens: tokens(/can only afford\s+(\d+)/i),
      maximumContextTokens: tokens(/maximum context length(?: is| of)?\s+(\d+)\s+tokens/i),
      resultingTokens: tokens(/(?:resulted in|requested)\s+(\d+)\s+tokens/i),
      detail: allowDetail
        ? sanitize(
            rows.map((row) => row.message).find((detail) => typeof detail === 'string') ??
              (typeof decoded === 'string'
                ? decoded
                : decoded === undefined && !text.includes('{') && !text.includes('[')
                  ? original
                  : null)
          )
        : null,
      nativeHttpAndUsage: 'only_if_retained_inside_canonical_error' as const,
    };
  };
  const taskUserIndex = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      typeof message.text === 'string' &&
      message.text.includes(expected.taskId)
  );
  const taskUser = messages[taskUserIndex];
  const nextUserIndex = messages.findIndex(
    (message, index) => index > taskUserIndex && message.role === 'user'
  );
  const taskTurnEndIndex = nextUserIndex < 0 ? messages.length : nextUserIndex;
  const taskUserBinding =
    typeof taskUser?.id === 'string' &&
    taskUser.id.length > 0 &&
    messages.filter((message) => message.id === taskUser.id).length === 1;
  const safeTaskContext =
    taskUserBinding &&
    messages.flatMap(tools).every((tool) => {
      const input = record(tool.input);
      return (
        toolName(tool.toolName) === 'task_get' &&
        input.taskId === expected.taskId &&
        input.teamName === expected.teamName
      );
    });
  const previewAllowed = safeTaskContext;
  const sanitize = (text: unknown) => {
    if (typeof text !== 'string') return null;
    return redactLaunchFailureArtifactText(text)
      .replaceAll(String.fromCharCode(27), '')
      .replace(/[A-Za-z]:[\\/][^\s"'<>),;]*/g, '[path]')
      .replace(/\\\\[^\s"'<>),;]*/g, '[path]')
      .replace(/\/[^\s"'<>),;]+/g, '[path]')
      .replace(/[A-Za-z0-9_+./=-]{24,}/g, '[opaque]')
      .slice(0, 2048);
  };
  const finiteTime = (time: unknown) =>
    typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 8_640_000_000_000_000
      ? time
      : null;
  return {
    source: 'existing_sdk_readonly_offline_history_before_stop' as const,
    sessionMatches: true,
    taskUserIndex,
    taskUserBinding,
    taskTurnEndIndex,
    durableState:
      ['idle', 'running', 'retrying', 'blocked', 'error', 'reply_pending', 'unknown'].find(
        (state) => transcript.durableState === state
      ) ?? 'unknown',
    durableStateSource: 'stored_sdk_record_last_observation' as const,
    nativeToolStateError: 'retained_from_exact_native_tool_part' as const,
    messageCount: messages.length,
    previewPolicy: previewAllowed ? 'owned_task_get_or_no_tools' : 'withheld_unproven_tool_context',
    messages: messages.map((message, index) => ({
      index,
      parentIndex: messages.findIndex(
        (parent) => typeof parent.id === 'string' && parent.id === message.parentId
      ),
      role:
        ['user', 'assistant', 'system', 'tool'].find((role) => message.role === role) ?? 'other',
      agent:
        ['teammate', 'teammate-bootstrap'].find((agent) => message.agent === agent) ??
        (message.agent === null ? null : 'other'),
      createdAt: finiteTime(message.createdAt),
      completedAt: finiteTime(message.completedAt),
      tokens: Object.fromEntries(
        ['input', 'output', 'reasoning'].map((key) => {
          const value = record(message.nativeTokens)[key];
          return [
            key,
            Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000_000
              ? Number(value)
              : null,
          ];
        })
      ),
      finishReason:
        [
          'stop',
          'length',
          'tool-calls',
          'content-filter',
          'error',
          'unknown',
          'end_turn',
          'max_tokens',
          'tool_use',
          'pause_turn',
        ].find((reason) => message.finishReason === reason) ??
        (message.finishReason === null ? null : 'other'),
      hasError: message.hasError === true,
      error: failure(
        message.errorMessage,
        message.errorName,
        safeTaskContext &&
          index > taskUserIndex &&
          index < taskTurnEndIndex &&
          message.parentId === taskUser?.id
      ),
      successorAssistantIndex: messages.findIndex(
        (next, nextIndex) => nextIndex > index && next.role === 'assistant'
      ),
      assistantText:
        message.role === 'assistant' &&
        index > taskUserIndex &&
        index < taskTurnEndIndex &&
        message.parentId === taskUser?.id
          ? previewAllowed
            ? sanitize(message.text)
            : null
          : null,
      tools: tools(message).map((tool) => ({
        name: toolName(tool.toolName),
        status:
          ['running', 'completed', 'errored', 'unknown'].find((status) => tool.status === status) ??
          'other',
        isError: tool.isError === true,
        nativeStatus:
          ['pending', 'running', 'completed', 'error'].find(
            (status) => tool.nativeStatus === status
          ) ?? null,
        startedAt: finiteTime(tool.startedAt),
        completedAt: finiteTime(tool.completedAt),
        error:
          tool.isError === true
            ? failure(
                tool.outputText,
                null,
                safeTaskContext &&
                  index > taskUserIndex &&
                  index < taskTurnEndIndex &&
                  message.parentId === taskUser?.id
              )
            : null,
      })),
    })),
  };
}
let preproofStage = 'arguments';
const preproofFacts: { manifestBytes?: number; manifestEntries?: number } = {};
type App = Awaited<ReturnType<Awaited<ReturnType<typeof prepareNativeDesktop>>['launch']>>;
type Identity = { pid: number; birth: string; executable: string; command: string };
type ProofFailure = {
  stage: string;
  classification: string;
  operation?: string;
  errno?: string;
  detail?: string;
  causes?: ProofFailure[];
};
function proofFailure(error: unknown, stage: string, depth = 0): ProofFailure {
  if (error instanceof NativeDesktopIpcError)
    return {
      stage,
      operation: error.operation,
      classification: error.classification,
      detail: error.detail,
    };
  const result: ProofFailure = { stage, classification: 'unclassified' };
  if (error instanceof Error)
    result.detail = safeIpcFailureDetail(error.message, redactLaunchFailureArtifactText);
  if (error instanceof AggregateError && Array.isArray(error.errors) && depth === 0)
    result.causes = error.errors.slice(0, 3).map((cause: unknown) => proofFailure(cause, stage, 1));
  if (error instanceof assert.AssertionError) result.classification = 'assertion_failed';
  else if (error instanceof Error && error.message.startsWith('Native gate timed out:'))
    result.classification = 'timeout';
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9_]{1,48}$/.test(error.code)
  )
    result.errno = error.code;
  return result;
}
const ps = async (script: string) =>
  execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: Object.fromEntries(
        ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'TMP', 'TEMP']
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]])
      ),
      timeout: 10_000,
      maxBuffer: 16_384,
    }
  );

async function identity(pid: number): Promise<Identity | null> {
  assert(Number.isSafeInteger(pid) && pid > 1);
  const { stdout } = await ps(
    `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -eq $p){'null';exit}; if(!$p.ExecutablePath -or !$p.CommandLine -or !$p.CreationDate){throw 'Process identity unavailable'}; @{pid=[int]$p.ProcessId;birth=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress`
  );
  const value = JSON.parse(stdout) as Identity | null;
  if (value) assert(value.pid === pid && value.birth && value.executable && value.command);
  return value;
}
const same = (a: Identity | null, b: Identity) =>
  Boolean(
    a &&
    a.pid === b.pid &&
    a.birth === b.birth &&
    a.executable === b.executable &&
    a.command === b.command
  );

async function seedSelectedAuth(file: string, provider: string, directory: string) {
  // Read only the explicitly supplied local file; never emit its content/errors.
  preproofStage = 'auth_directory';
  await mkdir(directory, { recursive: true });
  await protectWindowsTestDirectory(directory);
  let selected: unknown;
  try {
    preproofStage = 'auth_read';
    assert(/(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(file), 'Explicit TEST auth custody required');
    const stat = await lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
    assert.equal(await realpath(file), file);
    const source = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    selected = source[provider];
    assert(selected && typeof selected === 'object' && !Array.isArray(selected));
    const record = selected as Record<string, unknown>;
    const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
    assert(
      (record.type === 'api' && text(record.key)) ||
        (record.type === 'oauth' && (text(record.access) || text(record.refresh)))
    );
  } catch {
    throw new Error('Selected local TEST auth is invalid');
  }
  preproofStage = 'auth_write';
  await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ [provider]: selected }), {
    flag: 'wx',
  });
  // File is created inside the protected owner/SYSTEM-only directory.
}

async function ready(app: App) {
  await waitFor(
    async () => {
      const status = await app.call('getStartupStatus');
      assert(!status.error, 'Owned application initialization failed');
      return status.ready ? true : null;
    },
    'owned application ready',
    180_000
  );
  // Renderer readiness precedes Windows cleanup drainage. Observe the normal
  // startup owner before submitting once; never retry cleanup or a launch.
  await waitFor(
    async () => {
      const state = await app.call('getStartupCleanupState');
      assert(
        state === 'pending' || state === 'complete' || state === 'partial',
        `Owned startup cleanup unavailable: ${state}`
      );
      return state === 'pending' ? null : true;
    },
    'owned startup cleanup drained',
    180_000
  );
}
async function provisioned(app: App, runId: string) {
  await waitFor(
    async () => {
      const status = await app.call('getProvisioningStatus');
      assert(status.state !== 'failed', 'Owned provisioning failed');
      return status.runId === runId && status.state === 'ready' ? true : null;
    },
    'owned team ready',
    420_000
  );
}
type CompletionObservation = {
  taskId: string;
  ownerMatches: boolean;
  exactComment: boolean;
  exactTextAnyAuthor: boolean;
  ownerHasComment: boolean;
  terminalPresent: boolean;
  commentTimeValid: boolean;
  terminalTimeValid: boolean;
  commentBeforeTerminal: boolean;
};
type StopObservation = {
  processAlive: boolean;
  memberCount: number;
  aliveMemberCount: number;
  runId: string | null;
  livenessKinds: string[];
};
type PeerObservation = {
  matched: boolean[];
  routes: { from: string; to: string }[];
  challengeDeliveries: {
    member: 'alice' | 'bob';
    state: 'message_absent' | 'status_unavailable' | 'ledger_absent' | 'observed';
    attempted?: boolean;
    accepted?: boolean | null;
    delivered?: boolean;
    acceptanceUnknown?: boolean | null;
    responsePending?: boolean | null;
    ledgerStatus?: string | null;
    responseState?: string | null;
    reasonCode?: string | null;
    diagnosticCodes?: string[];
  }[];
};
async function completed(
  app: App,
  id: string,
  owner: string,
  comment: string,
  observe: (value: CompletionObservation) => Promise<void>
) {
  await waitFor(
    async () => {
      const task = await app.call('getTask', id);
      assert(task && task.owner === owner, 'Owned task missing or reassigned');
      if (task.status !== 'completed') return null;
      const durable = task.comments?.find((row) => row.author === owner && row.text === comment);
      const terminal = task.historyEvents?.find(
        (event) => event.type === 'status_changed' && event.to === 'completed'
      );
      await observe({
        taskId: id,
        ownerMatches: task.owner === owner,
        exactComment: !!durable,
        exactTextAnyAuthor: !!task.comments?.some((row) => row.text === comment),
        ownerHasComment: !!task.comments?.some((row) => row.author === owner),
        terminalPresent: !!terminal,
        commentTimeValid: !!durable && Number.isFinite(Date.parse(durable.createdAt)),
        terminalTimeValid: !!terminal && Number.isFinite(Date.parse(terminal.timestamp)),
        commentBeforeTerminal:
          !!durable &&
          !!terminal &&
          Date.parse(durable.createdAt) <= Date.parse(terminal.timestamp),
      });
      assert(
        durable &&
          terminal &&
          Number.isFinite(Date.parse(durable.createdAt)) &&
          Number.isFinite(Date.parse(terminal.timestamp)) &&
          Date.parse(durable.createdAt) <= Date.parse(terminal.timestamp),
        'Actual agent durable comment must precede completed history event'
      );
      return true;
    },
    'real task completion with comment',
    420_000
  );
}
function resultHasMarker(content: unknown, marker: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.split(/\r?\n/).includes(marker)) return true;
  // Existing projector serializes V2 native text-content arrays as JSON.
  try {
    const blocks: unknown = JSON.parse(content);
    return (
      Array.isArray(blocks) &&
      blocks.some(
        (block) =>
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string' &&
          block.text.split(/\r?\n/).includes(marker)
      )
    );
  } catch {
    return false;
  }
}
async function commandEvidence(
  app: App,
  taskId: string,
  member: string,
  session: string,
  program: string,
  marker: string,
  version: string,
  expectedModel: string
) {
  return waitFor(
    async () => {
      const stream = await app.call('getTaskLogStream', taskId);
      for (const segment of stream.segments) {
        if (segment.actor.memberName !== member || segment.actor.sessionId !== session) continue;
        for (const chunk of segment.chunks) {
          if (chunk.chunkType !== 'ai') continue;
          const assistantModels = chunk.responses
            .filter((response) => response.type === 'assistant' || response.role === 'assistant')
            .map((response) => response.model)
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
          assert(
            assistantModels.every((value) => value === expectedModel),
            'Actual assistant inference used a different model'
          );
          if (!assistantModels.includes(expectedModel)) continue;
          const native = chunk.toolExecutions.filter((execution) => {
            const command = execution.toolCall.input.command;
            return (
              ['bash', 'shell', 'exec'].includes(execution.toolCall.name) &&
              typeof command === 'string' &&
              command.includes(program) &&
              /\bnode(?:\.exe)?\b/i.test(command)
            );
          });
          const succeeded = (execution: (typeof chunk.toolExecutions)[number]) =>
            execution.result?.toolUseId === execution.toolCall.id &&
            execution.result.isError === false &&
            resultHasMarker(execution.result.content, marker);
          if (native.some(succeeded)) return 'paired-native-shell-result';
          // V2 canonical CodeMode metadata proves an actual native invocation but
          // deliberately provides no child result. Keep the successful composite
          // output separate; never manufacture a paired nested result/status.
          if (
            version.startsWith('2.') &&
            native.length &&
            chunk.toolExecutions.some(
              (execution) => execution.toolCall.name === 'execute' && succeeded(execution)
            )
          )
            return 'code-mode-outer-result-plus-native-invocation';
        }
      }
      return null;
    },
    'actor/session-scoped genuine command evidence',
    180_000
  );
}
async function bundledRuntime(executable: string, manifestFile: string) {
  preproofStage = 'manifest_path';
  assert(
    manifestFile && path.isAbsolute(manifestFile),
    'Qualified bundled runtime manifest required'
  );
  preproofStage = 'manifest_stat';
  const stat = await lstat(manifestFile);
  preproofFacts.manifestBytes = stat.size;
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BUNDLED_MANIFEST_MAX_BYTES);
  preproofStage = 'manifest_read';
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
    sdkSha: string;
    files: Record<string, string>;
  };
  preproofStage = 'manifest_schema';
  assert(
    /^[a-f0-9]{40}$/.test(manifest.sdkSha) &&
      manifest.files &&
      typeof manifest.files === 'object' &&
      !Array.isArray(manifest.files)
  );
  preproofStage = 'runtime_path';
  const base = path.join(path.dirname(await realpath(executable)), 'resources', 'runtime');
  assert.equal((await realpath(base)).toLowerCase(), base.toLowerCase());
  const entries = Object.entries(manifest.files);
  preproofStage = 'manifest_entries';
  preproofFacts.manifestEntries = entries.length;
  assert(
    entries.length > 0 &&
      entries.length <= BUNDLED_MANIFEST_MAX_ENTRIES &&
      manifest.files['COMMIT_SHA'] &&
      manifest.files['claude-multimodel.exe'],
    'Complete bundled executable provenance required'
  );
  const digests: Record<string, string> = {};
  preproofStage = 'runtime_hashes';
  for (const [relative, expected] of entries) {
    assert(
      relative &&
        !relative.includes('\\') &&
        relative.split('/').every((part) => part && part !== '.' && part !== '..') &&
        !path.isAbsolute(relative) &&
        !relative.includes(':')
    );
    assert(/^[a-f0-9]{64}$/.test(expected));
    const file = path.join(base, relative);
    const fileStat = await lstat(file);
    assert(fileStat.isFile() && !fileStat.isSymbolicLink());
    assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    const observed = hash.digest('hex');
    assert.equal(observed, expected, 'Bundled runtime byte mismatch');
    digests[relative] = observed;
  }
  preproofStage = 'runtime_commit';
  assert.equal((await readFile(path.join(base, 'COMMIT_SHA'), 'utf8')).trim(), manifest.sdkSha);
  return { bundledSdkSha: manifest.sdkSha, runtimeDigests: digests };
}
async function exactFile(project: string, name: string, expected?: string) {
  const file = path.join(project, name);
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = await readFile(file);
  if (expected !== undefined) assert.equal(bytes.toString(), expected);
  return createHash('sha256').update(bytes).digest('hex');
}
async function readStopObservation(app: App) {
  const processAlive = await app.call('processAlive');
  const runtime = await app.call('getRuntime');
  const knownKinds = [
    'confirmed_bootstrap',
    'runtime_process',
    'runtime_process_candidate',
    'permission_blocked',
    'shell_only',
    'registered_only',
    'stale_metadata',
    'not_found',
  ];
  const observation: StopObservation = {
    processAlive,
    memberCount: Object.values(runtime.members).length,
    aliveMemberCount: Object.values(runtime.members).filter((member) => member.alive).length,
    runId:
      typeof runtime.runId === 'string' && /^[a-f0-9-]{36}$/i.test(runtime.runId)
        ? runtime.runId
        : null,
    livenessKinds: Object.values(runtime.members).map(
      (member) => knownKinds.find((kind) => kind === member.livenessKind) ?? 'unknown'
    ),
  };
  return { processAlive, runtime, observation };
}
async function stopped(app: App, observe: (value: StopObservation) => Promise<void>) {
  await app.call('stop');
  let previous = '';
  const settled = await waitFor(
    async () => {
      const { processAlive, runtime, observation } = await readStopObservation(app);
      const encoded = JSON.stringify(observation);
      if (encoded !== previous) {
        await observe(observation);
        previous = encoded;
      }
      return !processAlive && Object.values(runtime.members).every((member) => !member.alive)
        ? { processAlive, runtime }
        : null;
    },
    'owned stop runtime projection settled',
    30_000
  );
  assert.equal(settled.processAlive, false);
  assert(Object.values(settled.runtime.members).every((member) => !member.alive));
}

/** Observation only: a fresh desktop TEST root belongs to this one launch.
 * Never emits producer text, paths, session IDs, environment or credentials. */
async function packagedStartupSnapshot(
  testRoot: string,
  dataRoot: string,
  team: string,
  runId: string
) {
  const row = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const one = (value: unknown, allowed: readonly string[]) =>
    allowed.find((item) => item === value) ?? 'unclassified';
  const number = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
      ? Number(value)
      : null;
  const nativeAlias = (input: unknown) => {
    const value = row(input);
    const operations = [
      'assertLive',
      'identity',
      'launch',
      'ownerArchive',
      'ownerAssertDirectory',
      'ownerCloseDirectory',
      'ownerCreatePreparedDatabase',
      'ownerInspectProfileConfig',
      'ownerOpenDirectory',
      'ownerPreparePrivateDirectory',
      'ownerReadMetadata',
      'ownerReadRecord',
      'ownerSelectConfig',
      'ownerValidateSelectedProfile',
      'ownerWriteExclusive',
      'ownerWriteMetadata',
      'ownerWritePreparedAuth',
      'ownerWritePreparedConfig',
      'retire',
      'runStateAcquire',
      'runStateClose',
      'runStateDiscover',
      'runStateListen',
      'runStateOwnerRetired',
      'runStatePoisonConnection',
      'runStateProcessIdentity',
      'runStateReadControllerInbox',
      'runStateReadRecord',
      'runStateReadStop',
      'runStateRequest',
      'runStateReserve',
      'runStateRespond',
      'runStateSelect',
      'runStateValidateEndpoint',
      'runStateWriteRecord',
      'selfImageCustody',
      'send',
    ];
    if (
      Object.keys(value).sort().join(',') !== 'operation,passed,predicate,sourceLine' ||
      value.passed !== false ||
      !operations.some((operation) => operation === value.operation) ||
      !Number.isSafeInteger(value.sourceLine) ||
      Number(value.sourceLine) < 1 ||
      Number(value.sourceLine) > 100000 ||
      !Number.isSafeInteger(value.predicate) ||
      Number(value.predicate) < 0 ||
      Number(value.predicate) > 4
    )
      return null;
    return {
      operation: value.operation,
      sourceLine: value.sourceLine,
      predicate: value.predicate,
      passed: false,
    };
  };
  // The packet commits one immutable SDK graph row; it conveys no path or authority.
  const graphFailure = (input: unknown) => {
    const value = row(input);
    const integer = (item: unknown, min: number, max: number): item is number =>
      Number.isSafeInteger(item) && Number(item) >= min && Number(item) <= max;
    const hash = (item: unknown): item is string =>
      typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
    if (
      ![
        'contentSha256,index,pathSha256,readPhase,total',
        'contentSha256,index,pathSha256,readPhase,realpath,total',
      ].includes(Object.keys(value).sort().join(',')) ||
      (value.readPhase !== 'realpath' && value.readPhase !== 'hash') ||
      !integer(value.total, 1, 65536) ||
      !integer(value.index, 0, value.total - 1) ||
      !hash(value.pathSha256) ||
      !hash(value.contentSha256)
    )
      return null;
    const native = row(value.realpath);
    if (
      value.realpath !== undefined &&
      (Object.keys(native).sort().join(',') !==
        'anchorCount,matchingAnchorIndex,operation,status,win32' ||
        !integer(native.status, 1, 4) ||
        !integer(native.operation, 0, 25) ||
        !integer(native.win32, 0, 0xffffffff) ||
        !integer(native.anchorCount, 0, 4096) ||
        !integer(native.matchingAnchorIndex, -1, native.anchorCount - 1))
    )
      return null;
    return {
      index: value.index,
      total: value.total,
      readPhase: value.readPhase,
      pathSha256: value.pathSha256,
      contentSha256: value.contentSha256,
      ...(value.realpath === undefined
        ? {}
        : {
            realpath: {
              status: native.status,
              operation: native.operation,
              win32: native.win32,
              anchorCount: native.anchorCount,
              matchingAnchorIndex: native.matchingAnchorIndex,
            },
          }),
    };
  };
  const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
    a.dev === b.dev && a.ino === b.ino;
  assert(
    path.basename(testRoot).startsWith('TEST-oc-') &&
      dataRoot === path.join(testRoot, 'runtime-data')
  );
  assert(/^test-opencode-[a-f0-9-]+$/.test(team) && /^[a-f0-9-]{36}$/.test(runId));
  const read = async (directory: string, name: string, plain = false) => {
    try {
      const parent = await lstat(directory, { bigint: true });
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      )
        return null;
      const file = path.join(directory, name),
        before = await lstat(file, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size > 65536n ||
        (await realpath(file)) !== file
      )
        return null;
      const held = await open(file, 'r');
      try {
        if (!same(before, await held.stat({ bigint: true }))) return null;
        const bytes = Buffer.alloc(65537),
          result = await held.read(bytes, 0, bytes.length, 0);
        const after = await held.stat({ bigint: true });
        if (
          result.bytesRead > 65536 ||
          !same(before, after) ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          !same(before, await lstat(file, { bigint: true })) ||
          !same(parent, await lstat(directory, { bigint: true }))
        )
          return null;
        const body = bytes.subarray(0, result.bytesRead).toString('utf8');
        return plain ? { body } : row(JSON.parse(body));
      } finally {
        await held.close();
      }
    } catch {
      return null;
    }
  };
  const stages = [
    'run-owner-entry',
    'windows-cohort',
    'windows-profile',
    'windows-roots',
    'windows-dll',
    'windows-process',
    'windows-owned-pair',
    'windows-published',
    'windows-connected',
    'windows-prepare',
    'windows-assert',
    'waiting-for-prepare',
    'profile-validation',
    'native-validation',
    'graph-validation',
    'runtime-import',
    'server-start',
    'effect-import',
    'selected-oauth-import',
    'scope-acquisition',
    'ready-identity',
  ];
  // Exact producer literals from the SDK's finite native/startup/selected-auth diagnostics.
  const categories = [
    'execution_timeout',
    'execution_cancelled',
    'execution_native_timeout',
    'execution_host_unavailable',
    'execution_identity_mismatch',
    'execution_owner_not_private',
    'execution_containment_filesystem_denied',
    'run_control_process_identity',
    'cleanup_unknown',
    'provider_operation_unknown',
    'provider_auth',
    'provider_quota',
    'timeout',
    'run_acquisition_timeout',
    'run_initialization_timeout',
    'run_control_timeout',
    'run_control_disconnected',
    'run_control_changed',
    'run_control_foreign',
    'run_control_invalid',
    'run_control_frame_too_large',
    'run_owner_stale',
    'run_process_unknown',
    'run_process_changed',
    'run_deadline_expired',
    'run_readiness_changed',
    'run_readiness_unknown',
    'run_operation_unknown',
    'execution_selected_auth_required',
    'execution_selected_auth_unbound',
    'execution_selected_auth_changed',
    'execution_selected_auth_missing',
    'execution_selected_auth_unsupported',
    'execution_selected_auth_location_changed',
    'execution_selected_auth_provider_unknown',
    'execution_selected_auth_existing_or_unsupported',
    'execution_selected_auth_readback_unknown',
    'execution_selected_auth_profile_changed',
    'execution_selected_oauth_readback_unknown',
    'execution_selected_oauth_recovery_required',
    'execution_selected_oauth_windows_unqualified',
    'execution_selected_oauth_provider_unknown',
    'execution_selected_oauth_integration_unknown',
    'execution_selected_oauth_connection_unknown',
    'execution_selected_oauth_model_unknown',
    'execution_lease_not_owned',
    'execution_containment_unqualified',
    'execution_invalid_response',
    'execution_identity_unknown',
    'execution_profile_changed',
    'execution_graph_changed',
    'execution_graph_incomplete',
    'execution_graph_dependency_missing',
    'execution_owner_unknown',
    'execution_owner_record_invalid',
    'execution_path_alias',
    'execution_containment_dll_identity',
    'execution_containment_helper_closed',
    'execution_containment_helper_failed',
    'execution_containment_helper_identity',
    'execution_containment_launcher_denied',
    'execution_containment_pipe_denied',
    'execution_containment_profile_denied',
    'execution_containment_unavailable',
    'execution_native_command_unknown',
    'execution_native_stdio_owner_unknown',
    'execution_native_unknown',
    'execution_owner_alias',
    'execution_owner_archive_identity_mismatch',
    'execution_owner_archive_path_mismatch',
    'execution_owner_archive_reopen_identity_mismatch',
    'execution_owner_archive_unknown',
    'execution_owner_local_volume_required',
    'execution_owner_metadata_budget',
    'execution_owner_metadata_changed',
    'execution_owner_metadata_invalid',
    'execution_owner_metadata_missing',
    'execution_owner_metadata_purpose_invalid',
    'execution_owner_ntfs_required',
    'execution_owner_path_invalid',
    'execution_owner_prepared_invalid',
    'execution_owner_prepared_purpose_invalid',
    'execution_owner_read_only',
    'execution_owner_write_through_pending',
  ];
  const nativeStages = [
    'alias_predicate',
    'process_alive',
    'process_alive_wait',
    'process_image_path',
    'process_image_open',
    'process_birth_changed',
    'private_acl_owner',
    'private_dll_owner',
    'retire_grants',
    'retire_wait',
    'retire_job',
    'assert_mapping',
    'assert_stopped',
    'assert_broker',
    'process_birth',
    'shared_acl_mutex_descriptor',
    'shared_acl_mutex_create',
    'shared_acl_mutex_security',
    'shared_acl_mutex_encoding',
    'shared_acl_mutex_authority',
    'shared_acl_mutex_wait',
    'shared_acl_mutex',
    'owner_archive_nt_rename',
    'owner_canonical_open',
    'owner_directory_create',
    'owner_directory_open',
    'owner_identity_links',
    'owner_identity_reparse',
    'owner_identity_type',
    'owner_metadata_cleanup',
    'owner_metadata_open',
    'owner_metadata_publish',
    'owner_parent_duplicate',
    'owner_prepared_create',
    'owner_verification_open',
    'private_acl_foreign_allow',
    'private_acl_owner_run_data_root',
    'private_acl_owner_run_leaf',
    'private_acl_owner_run_opencode',
    'private_acl_owner_run_runs',
    'private_acl_owner_run_v2',
    'private_image_open',
    'private_image_protected_dacl',
    'private_owner_acquire',
    'private_owner_cohort',
    'private_owner_controller_tasks',
    'private_owner_controller_teams',
    'private_owner_discover_selection',
    'private_owner_reserve_selection',
    'private_owner_selected_selection',
    'private_readonly_root',
    'private_writable_root',
    'private_protected_root',
    'ancestor_metadata_control',
    'ancestor_metadata_foreign',
    'ancestor_metadata_group',
    'ancestor_metadata_member',
    'ancestor_metadata_open',
    'ancestor_metadata_owner',
    'ancestor_metadata_ace',
    'ancestor_metadata_descriptor',
    'ancestor_metadata_security',
    'ancestor_metadata_package',
    'ancestor_metadata_read',
    'ancestor_metadata_changed',
    'ancestor_metadata_cleanup_unproven',
    'ancestor_metadata_intent',
    'ancestor_metadata_acl_size',
    'ancestor_metadata_acl',
    'ancestor_metadata_write',
    'ancestor_metadata_identity',
    'ancestor_metadata_pin',
    'shared_readonly_security',
    'shared_readonly_acl',
    'shared_readonly_owner',
    'shared_readonly_file',
    'shared_readonly_control',
    'shared_readonly_ace',
    'shared_readonly_package',
    'shared_readonly_foreign_write',
    'shared_readonly_grant_open',
    'shared_readonly_grant_read',
    'shared_readonly_grant_merge',
    'shared_readonly_grant_write',
    'shared_readonly_owner_changed',
    'shared_readonly_control_changed',
    'shared_readonly_foreign_changed',
    'shared_readonly_member_missing',
    'retire_broker_state',
    'retire_broker_write',
    'retire_io_join',
    'retire_main_exit',
    'retire_owned_pair',
    'retire_commands',
    'retire_receipt',
    'retire_grants_dll',
    'retire_grants_roots',
    'retire_grants_metadata',
  ];
  const list = async (directory: string, pattern: RegExp) => {
    try {
      if ((await realpath(directory)) !== directory || (await lstat(directory)).isSymbolicLink())
        return [];
      const entries = await opendir(directory),
        names: string[] = [];
      let visited = 0;
      try {
        for await (const entry of entries) {
          if (++visited > 64) break;
          if (pattern.test(entry.name)) names.push(entry.name);
        }
      } finally {
        await entries.close().catch(() => {});
      }
      return names;
    } catch {
      return [];
    }
  };
  // Read the owned launch manifest first; never follow a pointer outside this TEST team.
  const artifacts = path.join(testRoot, 'claude', 'teams', team, 'launch-failure-artifacts');
  const latest = await read(artifacts, 'latest.json');
  let launchManifest: Record<string, unknown> = { observation: 'missing_or_unavailable' };
  if (
    typeof latest?.manifestPath === 'string' &&
    path.basename(latest.manifestPath) === 'manifest.json' &&
    path.dirname(path.dirname(latest.manifestPath)) === artifacts
  ) {
    const manifest = await read(path.dirname(latest.manifestPath), 'manifest.json');
    if (manifest && manifest.teamName === team && manifest.runId === runId) {
      const breadcrumb = row(manifest.bootstrapTransportBreadcrumb);
      launchManifest = {
        observation: 'read',
        classification: one(row(manifest.classification).code, [
          'provider_quota',
          'provider_auth',
          'model_no_bootstrap',
          'process_exited',
          'opencode_runtime_readiness_timeout',
          'opencode_protocol',
          'unknown',
        ]),
        bootstrapSubmitted: breadcrumb.bootstrapSubmitted === true,
        submitRejected: breadcrumb.submitRejected === true,
        memberSpawnStatuses: Object.values(row(manifest.memberSpawnStatuses))
          .slice(0, 4)
          .map((value) => ({
            status: one(row(value).status, [
              'offline',
              'waiting',
              'spawning',
              'online',
              'error',
              'skipped',
            ]),
            launchState: one(row(value).launchState, [
              'starting',
              'runtime_pending_bootstrap',
              'runtime_pending_permission',
              'confirmed_alive',
              'failed_to_start',
              'skipped_for_launch',
            ]),
          })),
      };
    }
  }
  const stdio = [];
  const profilesRoot = path.join(dataRoot, 'opencode', 'v2', 'profiles');
  for (const profile of await list(profilesRoot, /^[a-f0-9]{16}-[a-f0-9-]{36}$/)) {
    const owner = path.join(profilesRoot, profile, '.opencode-v2-execution-owner');
    for (const leaf of await list(owner, /^native-stdio-[a-f0-9-]{36}$/)) {
      const content = await read(path.join(owner, leaf), 'main.stderr', true);
      const body = typeof content?.body === 'string' ? content.body : null;
      let childStartup: Record<string, unknown> | null = null;
      for (const line of body?.split('\n').slice(0, 128) ?? []) {
        try {
          const event = row(JSON.parse(line));
          if (event.event === 'opencode-v2-startup')
            childStartup = {
              stage: one(event.stage, stages),
              reason: one(event.reason, ['timeout', 'failed']),
              cause: one(event.cause, categories),
              errno: one(event.errno, ['EPERM', 'EACCES', 'ENOENT', 'EINVAL', 'UNKNOWN']),
              operation: one(event.operation, ['realpath', 'open', 'read', 'lstat', 'stat']),
              elapsedMs: number(event.elapsedMs),
              graphFailure: graphFailure(event.graphFailure),
            };
        } catch {
          /* Arbitrary stderr never crosses this boundary. */
        }
      }
      stdio.push({
        role: 'original_execution_child_stderr',
        observation: body === null ? 'missing_or_unavailable' : 'read',
        kind:
          body === null
            ? 'unavailable'
            : body.length === 0
              ? 'empty'
              : /Cannot find module|ModuleNotFound|ERR_MODULE_NOT_FOUND/.test(body)
                ? 'module_resolution'
                : /EACCES|Access is denied/.test(body)
                  ? 'access_denied'
                  : 'unclassified',
        childStartup,
      });
      if (stdio.length === 4) break;
    }
    if (stdio.length === 4) break;
  }
  const diagnostics = [];
  const diagnosticRoot = path.join(dataRoot, 'opencode', 'v2', 'provider-diagnostics');
  for (const name of await list(diagnosticRoot, /^[a-f0-9-]{36}\.json$/)) {
    const data = await read(diagnosticRoot, name);
    if (!data) continue;
    const startup = row(data.startup),
      native = row(data.native),
      failure = row(data.failure);
    diagnostics.push({
      scope: 'isolated_TEST_root_not_run_authority',
      role: startup.stage === 'run-owner-entry' ? 'original_run_owner' : 'execution_host',
      phase: one(data.phase, [
        'execution-host-startup',
        'run-owner-initialization',
        'run-member-retirement',
      ]),
      category: one(data.category, categories),
      nativeStage: one(native.stage, nativeStages),
      nativeCode: number(native.nativeCode),
      alias: nativeAlias(data.alias),
      failure: {
        name: one(failure.name, [
          'Error',
          'TypeError',
          'ReferenceError',
          'RangeError',
          'AbortError',
        ]),
        errno: one(failure.errno, [
          'EPERM',
          'EACCES',
          'ENOENT',
          'ENOTDIR',
          'EISDIR',
          'EINVAL',
          'UNKNOWN',
          'EIO',
          'ENOSYS',
        ]),
        operation: one(failure.operation, ['realpath', 'open', 'read', 'lstat', 'stat']),
      },
      startupStage: one(startup.stage, stages),
      startupReason: one(startup.reason, ['timeout', 'failed']),
      startupElapsedMs: number(startup.elapsedMs),
      graphFailure: graphFailure(startup.graphFailure),
      startupExitCode: number(startup.nativeExitCode),
      startupStderrKind: one(startup.nativeStderrKind, [
        'empty',
        'entry_resolution',
        'module_resolution',
        'child_identity',
        'child_pipe',
        'access_denied',
        'pipe_refused',
        'pipe_missing',
        'bun_error',
        'unclassified',
        'unavailable',
      ]),
      startupHistory: Array.isArray(startup.history)
        ? startup.history.slice(0, 24).map((value) => ({
            stage: one(row(value).stage, stages),
            elapsedMs: number(row(value).elapsedMs),
          }))
        : [],
      acquisitionHistory: Array.isArray(row(data.acquisition).history)
        ? (row(data.acquisition).history as unknown[]).slice(0, 24).map((value) => ({
            phase: one(row(value).phase, [
              'preparing',
              'delivery-resolved',
              'profile-validated',
              'native-validated',
              'graph-validated',
              'resolution-prepared',
              'controller-prepared',
              'prepared',
              'mapping',
              'child-bound',
              'start-sent',
              'ready',
              'catalog-ready',
              'auth-ready',
              'selection-ready',
            ]),
            elapsedMs: number(row(value).elapsedMs),
          }))
        : [],
      cleanupPhase: one(row(data.cleanup).phase, [
        'dispose-transport',
        'send-close',
        'force-kill',
        'wait-exit',
        'read-birth',
        'kernel-retirement',
        'process-retirement',
        'closed-ack',
        'kernel-proof',
        'kernel-binding',
      ]),
      initializationPhase: one(row(data.initialization).phase, [
        'MCP-connect',
        'MCP-readback',
        'controller-tools',
        'probe-authority',
      ]),
    });
    if (diagnostics.length === 12) break;
  }
  const runs = [],
    runsRoot = path.join(dataRoot, 'opencode', 'v2', 'runs');
  for (const name of await list(runsRoot, /^[a-f0-9]{32}$/)) {
    const directory = path.join(runsRoot, name),
      state = await read(directory, 'state.json');
    const binding = row(state?.binding);
    if (binding.teamId !== team || binding.runId !== runId) continue;
    const bound = async (file: string) => {
      const data = await read(directory, file);
      return row(data?.binding).teamId === team && row(data?.binding).runId === runId ? data : null;
    };
    const operation = await bound('operation-failure.json'),
      stop = await bound('stop.json');
    const stopReceipt = row(stop?.receipt);
    const stoppedMembers = Array.isArray(stopReceipt.members) ? stopReceipt.members : [];
    runs.push({
      bindingMatches: true,
      state: one(state?.state, ['starting', 'active', 'stopping', 'stopped', 'cleanup_unknown']),
      operation: one(operation?.operation, [
        'status',
        'stop',
        'session.create',
        'session.prompt',
        'session.abort',
      ]),
      category: one(operation?.category, categories),
      stopState: one(stopReceipt.state, ['stopped', 'cleanup_unknown']),
      // Durable stop.json omits the later authenticated owner-retirement observation.
      ownerRetired: typeof stopReceipt.ownerRetired === 'boolean' ? stopReceipt.ownerRetired : null,
      members: Array.isArray(state?.members)
        ? state.members.slice(0, 4).map((value) => {
            const member = row(value);
            const retired = stoppedMembers.find(
              (entry) =>
                typeof member.memberId === 'string' && row(entry).memberId === member.memberId
            );
            const cleanup = row(row(retired).cleanup);
            return {
              state: one(member.state, ['accepted', 'unknown', 'rejected']),
              bootstrapVerified: row(member.bootstrap).verified === true,
              scopeClosed: cleanup.scopeClosed === true,
              processRetired: cleanup.processRetired === true,
              descendantsRetired: cleanup.descendantsRetired === true,
            };
          })
        : [],
    });
    if (runs.length === 4) break;
  }
  return {
    observation: 'before_stop_snapshot_only',
    authority: 'no_authority_minted',
    launchManifest,
    stdio,
    diagnostics,
    runs,
  };
}

async function main() {
  assert.equal(process.platform, 'win32');
  const [executable, sdk, binary, model, authFile, mode] = process.argv.slice(2);
  assert(mode === undefined || mode === '--short', 'Unknown Windows proof mode');
  const short = mode === '--short';
  const members = short ? ['alice'] : ['alice', 'bob'];
  assert(
    executable && sdk && binary && model && authFile && process.argv.length === (short ? 8 : 7)
  );
  for (const file of [executable, binary, authFile]) assert(path.isAbsolute(file));
  assert(sdk === 'bundled' || path.isAbsolute(sdk));
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model));
  preproofStage = 'desktop_prepare';
  const desktop = await prepareNativeDesktop();
  preproofStage = 'desktop_private_acl';
  await protectWindowsTestDirectory(desktop.root);
  preproofStage = 'selected_paths';
  if (sdk !== 'bundled') desktop.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = await realpath(sdk);
  desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = await realpath(binary);
  await seedSelectedAuth(
    authFile,
    model.split('/')[0],
    path.join(desktop.env.XDG_DATA_HOME!, 'opencode')
  );
  await seedWindowsTestModelOutputLimit(path.join(desktop.env.XDG_CONFIG_HOME!, 'opencode'), model);
  preproofStage = 'version_read';
  const measured = await execute(desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH!, ['--version'], {
    env: desktop.env,
    cwd: desktop.root,
    timeout: 20_000,
    maxBuffer: 4096,
  });
  preproofStage = 'version_validate';
  const version = /^(?:opencode\s*v?\s*)?(\d+\.\d+\.\d+)$/.exec(measured.stdout.trim())?.[1];
  assert(
    version && (/^1\./.test(version) || ['2.0.0', '2.0.21'].includes(version)),
    'Approved OpenCode version required'
  );
  const bundled =
    sdk === 'bundled'
      ? await bundledRuntime(
          executable,
          process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
        )
      : { bundledSdkSha: '', runtimeDigests: {} };
  const taskOwners = new Map<string, 'alice' | 'bob'>();
  const nativeSessions = new Map<string, string>();
  const proofFile = path.join(desktop.root, 'proof.json');
  const proof = {
    scope: short ? 'Windows real packaged short task only' : 'Windows real packaged full team',
    status: 'running',
    stage: 'startup',
    teamName: desktop.teamName,
    model,
    version,
    sdkSelection: sdk === 'bundled' ? 'bundled without override' : 'explicit SDK override',
    ...bundled,
    taskFailureSnapshot: null as null | {
      unavailable: boolean;
      tasks: Awaited<
        ReturnType<ReturnType<typeof electronTeamPort>['getSafeTaskFailureSnapshot']>
      >[];
    },
    nativeTranscriptFailure: null as null | {
      observation: 'captured' | 'unavailable';
      member: 'alice' | 'bob';
      stage: 'source_sdk' | 'image_hash' | 'offline_read' | 'file_read' | 'projection';
      packet?: ReturnType<typeof projectV1NativeTranscript>;
      failure?: {
        classification: string;
        exitCode: number | null;
        signal: string | null;
        killed: boolean;
      };
      rawFileRemoved?: boolean;
    },
    completionObservations: [] as CompletionObservation[],
    stopObservations: [] as StopObservation[],
    stopFailureObservationUnavailable: null as boolean | null,
    stopFailureSnapshot: null as Awaited<
      ReturnType<ReturnType<typeof electronTeamPort>['getSafeStopFailure']>
    > | null,
    peerObservation: null as PeerObservation | null,
    commandEvidenceConfirmed: [] as { member: string; kind: string }[],
    runIds: [] as string[],
    taskIds: [] as string[],
    fileHashes: {} as Record<string, string>,
    peersConfirmed: false,
    heldStopConfirmed: false,
    persistenceConfirmed: false,
    heldAssignmentReleasedAfterPersistence: false,
    relaunchConfirmed: false,
    finalStopConfirmed: false,
    failure: null as ProofFailure | null,
    launchFailure: null as Record<string, string | boolean> | null,
    startupFailureSnapshot: null as unknown,
    cleanupFailures: [] as ProofFailure[],
  };
  const checkpoint = async (stage: string) => {
    proof.stage = stage;
    await writeFile(proofFile, JSON.stringify(proof, null, 2));
  };
  const recordCompletion = async (value: CompletionObservation) => {
    proof.completionObservations.push(value);
    await checkpoint(proof.stage);
  };
  const recordStop = async (value: StopObservation) => {
    proof.stopObservations.push(value);
    await checkpoint(proof.stage);
  };
  preproofStage = 'proof_write';
  await checkpoint('startup');
  preproofStage = 'scenario';
  let app = await desktop.launch(executable).catch(async (error: unknown) => {
    proof.status = 'failed';
    proof.failure = proofFailure(error, 'startup');
    await checkpoint('startup');
    throw new Error('Owned Electron startup failed; preserve its TEST proof');
  });
  let teamActive = false;
  const heldProcesses: Identity[] = [];
  const closeApp = async () => {
    try {
      await app.close();
    } catch (error) {
      proof.status = 'failed';
      proof.cleanupFailures.push(proofFailure(error, 'app_cleanup'));
      await checkpoint('app-cleanup');
    }
    if (!proof.failure && proof.cleanupFailures.length)
      throw new Error('Windows native cleanup failed; preserve its TEST proof');
  };
  try {
    await checkpoint('scripts');
    const nonce = { alice: randomUUID(), bob: randomUUID(), new: randomUUID() };
    const base = `Work only inside ${desktop.projectPath}. Never delegate, install packages, detach processes or change host verification scripts. Use team tools for peer messages and task comments. When a peer sends CHALLENGE:<token>, reply to that sender ACK:<token> exactly. Never reply to ACK.`;
    const command = (name: string) => {
      const program = path.join(desktop.projectPath, name);
      assert(
        [...program].every((char) => char.charCodeAt(0) >= 32) && !/["%!^&<>|`$]/.test(program),
        'Literal Windows TEST command path required'
      );
      // JSON string escaping doubles backslashes in cmd/PowerShell arguments.
      return `node "${program}"`;
    };
    const checkSum = `const a=require('node:assert/strict');a.equal(process.platform,'win32');const sum=require('./sum.cjs');a.equal(sum([]),0);a.equal(sum([2,-5,7]),4);a.equal(sum([1.5,2.5]),4);a.equal(sum([-2,-3]),-5);for(const v of [null,[NaN],[Infinity],['1']])a.throws(()=>sum(v),TypeError);`;
    await writeFile(
      path.join(desktop.projectPath, 'alice-verify.cjs'),
      `const fs=require('node:fs');${checkSum}fs.writeFileSync('alice-result.txt',${JSON.stringify(nonce.alice + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.alice)});`
    );
    await writeFile(
      path.join(desktop.projectPath, 'bob-verify.cjs'),
      `require('./sum.test.cjs');require('node:fs').writeFileSync('bob-result.txt',${JSON.stringify(nonce.bob + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.bob)});`
    );
    await writeFile(
      path.join(desktop.projectPath, 'host-verify.cjs'),
      checkSum + `require('./sum.test.cjs');`
    );
    const verificationHashes = Object.fromEntries(
      await Promise.all(
        ['alice-verify.cjs', 'bob-verify.cjs', 'host-verify.cjs'].map(async (name) => [
          name,
          await exactFile(desktop.projectPath, name),
        ])
      )
    );
    const verifyScripts = async () => {
      for (const [name, hash] of Object.entries(verificationHashes))
        assert.equal(
          await exactFile(desktop.projectPath, name),
          hash,
          'Host verification program changed'
        );
    };
    await checkpoint('ready');
    await ready(app);
    await checkpoint('create_team');
    teamActive = true; // An uncertain admission is still ours to stop, never resubmit.
    const launch = await app.call('createTeam', {
      teamName: desktop.teamName,
      cwd: desktop.projectPath,
      providerId: 'opencode',
      model,
      skipPermissions: true,
      prompt: base + ' Wait for a board task.',
      members: members.map((name) => ({
        name,
        role: 'Developer',
        providerId: 'opencode',
        model,
      })),
    });
    proof.runIds.push(launch.runId);
    await checkpoint('provision');
    await provisioned(app, launch.runId);
    await checkpoint('runtime');
    const initial = await app.call('getRuntime');
    assert.equal(initial.runId, launch.runId);
    const sessions = members.map((name) => {
      const member = initial.members[name];
      assert(member?.alive && member.runtimeModel === model && member.runtimeSessionId);
      nativeSessions.set(name, member.runtimeSessionId);
      return member.runtimeSessionId;
    });
    assert.equal(new Set(sessions).size, members.length);
    await checkpoint('tasks');
    const alice = await app.call('createTask', {
      subject: 'Implement and verify sum',
      owner: 'alice',
      startImmediately: true,
      prompt: `${base}\nOwn only sum.cjs and alice-result.txt. Export sum(array) as module.exports; accept only an array of finite numbers, throw TypeError otherwise. Read alice-verify.cjs, create sum.cjs, then run ${command('alice-verify.cjs')}. ${short ? '' : `Send bob CHALLENGE:${nonce.alice} with agent-teams_message_send.`} Before task_complete add task_add_comment from alice text TASK_COMMENT:${nonce.alice}. Complete only after successful command.`,
    });
    proof.taskIds.push(alice.id);
    taskOwners.set(alice.id, 'alice');
    await completed(app, alice.id, 'alice', `TASK_COMMENT:${nonce.alice}`, recordCompletion);
    const aliceCommandEvidence = await commandEvidence(
      app,
      alice.id,
      'alice',
      sessions[0],
      path.join(desktop.projectPath, 'alice-verify.cjs'),
      'COMMAND_EXEC:' + nonce.alice,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'alice', kind: aliceCommandEvidence });
    if (short) {
      proof.fileHashes['alice-result.txt'] = await exactFile(
        desktop.projectPath,
        'alice-result.txt',
        nonce.alice + '\n'
      );
      proof.fileHashes['sum.cjs'] = await exactFile(desktop.projectPath, 'sum.cjs');
      await verifyScripts();
      const verifier = path.join(desktop.projectPath, 'host-short-verify.cjs');
      await writeFile(verifier, checkSum);
      await execute(process.execPath, [verifier], {
        cwd: desktop.projectPath,
        env: desktop.env,
        timeout: 20_000,
        maxBuffer: 16_384,
      });
      await stopped(app, recordStop);
      teamActive = false;
      await app.close();
      if (sdk === 'bundled')
        assert.deepEqual(
          await bundledRuntime(
            executable,
            process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
          ),
          bundled
        );
      proof.finalStopConfirmed = true;
      proof.status = 'passed';
      await checkpoint('short-complete');
      console.log(`Windows short proof: ${proofFile}`);
      return;
    }
    const bob = await app.call('createTask', {
      subject: 'Independently test sum',
      owner: 'bob',
      startImmediately: true,
      prompt: `${base}\nOwn only sum.test.cjs and bob-result.txt. Read sum.cjs, do not modify it. Write sum.test.cjs using node:assert/strict, covering []=>0,[2,-5,7]=>4,[1.5,2.5]=>4,[-2,-3]=>-5 and TypeError for null,[NaN],[Infinity],['1']. Run ${command('bob-verify.cjs')}. Send alice CHALLENGE:${nonce.bob} with agent-teams_message_send. Before task_complete add task_add_comment from bob text TASK_COMMENT:${nonce.bob}. Complete only after successful command.`,
    });
    proof.taskIds.push(bob.id);
    taskOwners.set(bob.id, 'bob');
    await completed(app, bob.id, 'bob', `TASK_COMMENT:${nonce.bob}`, recordCompletion);
    const bobCommandEvidence = await commandEvidence(
      app,
      bob.id,
      'bob',
      sessions[1],
      path.join(desktop.projectPath, 'bob-verify.cjs'),
      'COMMAND_EXEC:' + nonce.bob,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'bob', kind: bobCommandEvidence });
    for (const name of ['alice', 'bob'] as const)
      proof.fileHashes[`${name}-result.txt`] = await exactFile(
        desktop.projectPath,
        `${name}-result.txt`,
        nonce[name] + '\n'
      );
    for (const name of ['sum.cjs', 'sum.test.cjs'])
      proof.fileHashes[name] = await exactFile(desktop.projectPath, name);
    await verifyScripts();
    await execute(process.execPath, [path.join(desktop.projectPath, 'host-verify.cjs')], {
      cwd: desktop.projectPath,
      env: desktop.env,
      timeout: 20_000,
      maxBuffer: 16_384,
    });
    // Read the real paginated message API, never construct peer messages on behalf of agents.
    let previousPeerObservation = '';
    await waitFor(
      async () => {
        let cursor: string | undefined;
        const rows: { from: string; to?: string; text: string; messageId?: string }[] = [];
        const seen = new Set<string>();
        for (let page = 0; page < 20; page++) {
          const result = await app.call('getMessagesPage', { cursor, limit: 100 });
          rows.push(...result.messages);
          if (!result.hasMore) break;
          assert(result.nextCursor && !seen.has(result.nextCursor), 'Invalid message pagination');
          seen.add(result.nextCursor);
          cursor = result.nextCursor;
          assert(page < 19, 'Message proof truncated');
        }
        const matched = [
          ['alice', 'bob', `CHALLENGE:${nonce.alice}`],
          ['bob', 'alice', `ACK:${nonce.alice}`],
          ['bob', 'alice', `CHALLENGE:${nonce.bob}`],
          ['alice', 'bob', `ACK:${nonce.bob}`],
        ].map(([from, to, text]) =>
          rows.some((row) => row.from === from && row.to === to && row.text === text)
        );
        const member = (value: string | undefined) =>
          ['alice', 'bob', 'team-lead', 'user'].find((name) => name === value) ?? 'other';
        const routes = [...new Set(rows.map((row) => `${member(row.from)}:${member(row.to)}`))]
          .sort()
          .map((route) => {
            const [from, to] = route.split(':');
            return { from, to };
          });
        // Read only existing public delivery state for the two real challenges.
        // Never relay, wake, resend or retain diagnostic text/provider data here.
        const challengeDeliveries = await Promise.all(
          (['alice', 'bob'] as const).map(async (member) => {
            const recipient = member === 'alice' ? 'bob' : 'alice';
            const original = rows.find(
              (row) =>
                row.from === member &&
                row.to === recipient &&
                row.text === `CHALLENGE:${nonce[member]}`
            );
            if (!original?.messageId) return { member, state: 'message_absent' as const };
            try {
              const status = await app.call('getOpenCodeRuntimeDeliveryStatus', original.messageId);
              if (!status) return { member, state: 'ledger_absent' as const };
              const ledgerStatus =
                [
                  'pending',
                  'accepted',
                  'responded',
                  'unanswered',
                  'retry_scheduled',
                  'retried',
                  'failed_retryable',
                  'failed_terminal',
                ].find((value) => value === status.ledgerStatus) ?? null;
              const responseState =
                [
                  'not_observed',
                  'pending',
                  'prompt_not_indexed',
                  'responded_tool_call',
                  'responded_visible_message',
                  'responded_non_visible_tool',
                  'responded_plain_text',
                  'permission_blocked',
                  'tool_error',
                  'empty_assistant_turn',
                  'prompt_delivered_no_assistant_message',
                  'session_stale',
                  'session_error',
                  'reconcile_failed',
                ].find((value) => value === status.responseState) ?? null;
              return {
                member,
                state: 'observed' as const,
                attempted: status.attempted === true,
                accepted: status.accepted ?? null,
                delivered: status.delivered === true,
                acceptanceUnknown: status.acceptanceUnknown ?? null,
                responsePending: status.responsePending ?? null,
                ledgerStatus,
                responseState,
                reasonCode: status.reasonCode,
                diagnosticCodes: status.diagnosticCodes,
              };
            } catch {
              return { member, state: 'status_unavailable' as const };
            }
          })
        );
        const observation = { matched, routes, challengeDeliveries };
        const encoded = JSON.stringify(observation);
        if (encoded !== previousPeerObservation) {
          proof.peerObservation = observation;
          await checkpoint(proof.stage);
          previousPeerObservation = encoded;
        }
        return matched.every(Boolean) ? true : null;
      },
      'actual peer challenge and acknowledgements',
      240_000
    );
    proof.peersConfirmed = true;
    const hold = async (label: string) => {
      const token = randomUUID();
      const name = `held-${label}.cjs`;
      const marker = path.join(desktop.projectPath, `held-${label}.json`);
      const program = path.join(desktop.projectPath, name);
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(token)}}));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});setInterval(()=>{},1000);`;
      await writeFile(program, script);
      const task = await app.call('createTask', {
        subject: 'Hold owned foreground command',
        owner: 'alice',
        startImmediately: true,
        prompt: `${base}\nRun ${command(name)} in foreground with timeout 660000ms. Do not edit the script, detach, delegate or complete this task. The host stops this team.`,
      });
      proof.taskIds.push(task.id);
      taskOwners.set(task.id, 'alice');
      const started = await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(marker, 'utf8')) as { pid: number; nonce: string };
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
              return null;
            throw error;
          }
        },
        'held actual native command',
        300_000
      );
      assert.equal(started.nonce, token);
      const original = await identity(started.pid);
      assert(
        original &&
          path.basename(original.executable).toLowerCase() === 'node.exe' &&
          original.command.includes(program),
        'Held process must be our exact TEST Node program'
      );
      heldProcesses.push(original);
      assert.equal(await readFile(program, 'utf8'), script);
      assert.equal((await app.call('getTask', task.id))?.status, 'in_progress');
      assert(same(await identity(original.pid), original), 'Held process gone before stop');
      await stopped(app, recordStop);
      teamActive = false;
      await waitFor(
        async () => {
          const observed = await identity(original.pid);
          return !observed || observed.birth !== original.birth ? true : null;
        },
        'physical owned process retirement',
        20_000
      );
      const retained = await app.call('getTask', task.id);
      assert(retained && ['pending', 'in_progress'].includes(retained.status));
      return { task, marker, markerBytes: await readFile(marker, 'utf8') };
    };
    await checkpoint('held-stop');
    const held = await hold('initial');
    proof.heldStopConfirmed = true;
    await app.close();
    assert(/^[a-zA-Z0-9_-]+$/.test(held.task.id));
    const retainedPath = path.join(
      desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!,
      'tasks',
      desktop.teamName,
      held.task.id + '.json'
    );
    const retained = JSON.parse(await readFile(retainedPath, 'utf8')) as {
      id: string;
      owner: string | null;
      status: string;
    };
    assert.equal(retained.id, held.task.id);
    app = await desktop.launch(executable);
    await ready(app);
    assert.equal(await app.call('processAlive'), false);
    assert(Object.values((await app.call('getRuntime')).members).every((member) => !member.alive));
    const loaded = (await app.call('getData')).tasks.find((task) => task.id === held.task.id);
    assert(loaded && loaded.owner === retained.owner && loaded.status === retained.status);
    assert.deepEqual(JSON.parse(await readFile(retainedPath, 'utf8')), retained);
    assert.equal(await readFile(held.marker, 'utf8'), held.markerBytes);
    proof.persistenceConfirmed = true;
    await checkpoint('restart-persistence');
    // Only after unchanged-owner persistence is proved, deliberately release
    // this forever-held TEST assignment before asking for a fresh team run.
    await app.call('updateTaskOwner', held.task.id, null);
    proof.heldAssignmentReleasedAfterPersistence = true;
    await checkpoint('relaunch');
    teamActive = true;
    const relaunch = await app.call('launchTeam', {
      teamName: desktop.teamName,
      cwd: desktop.projectPath,
      providerId: 'opencode',
      model,
      skipPermissions: true,
    });
    assert.notEqual(relaunch.runId, launch.runId);
    proof.runIds.push(relaunch.runId);
    await provisioned(app, relaunch.runId);
    const fresh = await app.call('getRuntime');
    assert.equal(fresh.runId, relaunch.runId);
    const newSessions = ['alice', 'bob'].map((name) => {
      const member = fresh.members[name];
      assert(
        member?.alive &&
          member.runtimeModel === model &&
          member.runtimeSessionId &&
          !sessions.includes(member.runtimeSessionId)
      );
      nativeSessions.set(name, member.runtimeSessionId);
      return member.runtimeSessionId;
    });
    assert.equal(new Set(newSessions).size, 2);
    await writeFile(
      path.join(desktop.projectPath, 'new-verify.cjs'),
      `require('node:assert/strict').equal(process.platform,'win32');require('node:fs').writeFileSync('new-result.txt',${JSON.stringify(nonce.new + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.new)});`
    );
    verificationHashes['new-verify.cjs'] = await exactFile(desktop.projectPath, 'new-verify.cjs');
    const task = await app.call('createTask', {
      subject: 'Verify fresh run after restart',
      owner: 'alice',
      startImmediately: true,
      prompt: `${base}\nRun ${command('new-verify.cjs')}. Add task_add_comment from alice text TASK_COMMENT:${nonce.new}, then task_complete after successful command.`,
    });
    proof.taskIds.push(task.id);
    taskOwners.set(task.id, 'alice');
    await completed(app, task.id, 'alice', `TASK_COMMENT:${nonce.new}`, recordCompletion);
    const freshCommandEvidence = await commandEvidence(
      app,
      task.id,
      'alice',
      newSessions[0],
      path.join(desktop.projectPath, 'new-verify.cjs'),
      'COMMAND_EXEC:' + nonce.new,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'alice-fresh', kind: freshCommandEvidence });
    proof.fileHashes['new-result.txt'] = await exactFile(
      desktop.projectPath,
      'new-result.txt',
      nonce.new + '\n'
    );
    proof.relaunchConfirmed = true;
    await checkpoint('final-stop');
    await hold('final');
    proof.finalStopConfirmed = true;
    assert.equal(
      await readFile(held.marker, 'utf8'),
      held.markerBytes,
      'Old stopped input replayed'
    );
    for (const name of ['alice', 'bob'] as const)
      await exactFile(desktop.projectPath, `${name}-result.txt`, nonce[name] + '\n');
    await verifyScripts();
    if (sdk === 'bundled')
      assert.deepEqual(
        await bundledRuntime(
          executable,
          process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
        ),
        bundled
      );
  } catch (error: unknown) {
    proof.status = 'failed';
    proof.failure ??= proofFailure(error, proof.stage);
    const latestTasks = proof.taskIds.slice(-2).flatMap((id) => {
      const owner = taskOwners.get(id);
      return owner ? [{ id, owner }] : [];
    });
    const failedTask = latestTasks.at(-1);
    const nativeSession = failedTask && nativeSessions.get(failedTask.owner);
    if (version.startsWith('1.') && sdk === 'bundled' && failedTask && nativeSession) {
      // Read the exact native persistence through existing SDK parser modules,
      // without preparing a profile/host or importing a prompt-capable service.
      const output = path.join(desktop.root, `native-transcript-${randomUUID()}.json`);
      const bunConfig = output + '.bunfig.toml';
      let captureStage: NonNullable<typeof proof.nativeTranscriptFailure>['stage'] = 'source_sdk';
      try {
        const sdkRoot = process.env.OPENCODE_NATIVE_DIAGNOSTIC_SDK_ROOT;
        assert(
          sdkRoot && path.isAbsolute(sdkRoot) && /(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(sdkRoot)
        );
        const gitOptions = {
          env: desktop.env,
          cwd: desktop.projectPath,
          timeout: 5000,
          maxBuffer: 4096,
        };
        assert.equal(
          (await execute('git', ['-C', sdkRoot, 'rev-parse', 'HEAD'], gitOptions)).stdout.trim(),
          bundled.bundledSdkSha
        );
        const sourceClosure = [
          'OpenCodeOfflineSessionReader',
          'OpenCodeTranscriptProjector',
          'OpenCodeManagedPaths',
          'OpenCodeBridgePath',
          'OpenCodeAppManagedBootstrapMessage',
        ].flatMap((name) => ['ts', 'js'].map((ext) => `src/services/opencode/${name}.${ext}`));
        assert.equal(
          (
            await execute(
              'git',
              [
                '-C',
                sdkRoot,
                'status',
                '--porcelain',
                '--untracked-files=all',
                '--ignored=matching',
                '--',
                ...sourceClosure,
              ],
              gitOptions
            )
          ).stdout,
          ''
        );
        captureStage = 'image_hash';
        const bun = path.join(
          path.dirname(await realpath(executable)),
          'resources',
          'runtime',
          'bun',
          'bun.exe'
        );
        const cliStat = await lstat(bun);
        assert(
          cliStat.isFile() &&
            !cliStat.isSymbolicLink() &&
            (await realpath(bun)).toLowerCase() === bun.toLowerCase()
        );
        const cliHash = createHash('sha256');
        for await (const bytes of createReadStream(bun)) cliHash.update(bytes);
        assert.equal(cliHash.digest('hex'), bundled.runtimeDigests['bun/bun.exe']);
        await writeFile(bunConfig, '', { flag: 'wx', mode: 0o600 });
        captureStage = 'offline_read';
        await execute(
          bun,
          ['--no-env-file', `--config=${bunConfig}`, '--eval', V1_OFFLINE_TRANSCRIPT_SCRIPT],
          {
            env: {
              ...desktop.env,
              OPENCODE_TEST_NATIVE_TRANSCRIPT_INPUT: JSON.stringify({
                sdkRoot,
                dataRoot: desktop.env.CLAUDE_MULTIMODEL_DATA_HOME,
                projectPath: desktop.projectPath,
                teamName: desktop.teamName,
                member: failedTask.owner,
                sessionId: nativeSession,
                runId: proof.runIds.at(-1),
                output,
              }),
            },
            cwd: desktop.projectPath,
            timeout: 20_000,
            maxBuffer: 16_384,
          }
        );
        captureStage = 'file_read';
        const stat = await lstat(output);
        assert(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1 &&
            stat.size <= V1_TRANSCRIPT_MAX_BYTES &&
            (await realpath(output)) === output
        );
        captureStage = 'projection';
        proof.nativeTranscriptFailure = {
          observation: 'captured',
          member: failedTask.owner,
          stage: captureStage,
          packet: projectV1NativeTranscript(JSON.parse(await readFile(output, 'utf8')), {
            sessionId: nativeSession,
            teamName: desktop.teamName,
            taskId: failedTask.id,
          }),
        };
      } catch (captureError: unknown) {
        const failure =
          captureError && typeof captureError === 'object'
            ? (captureError as Record<string, unknown>)
            : {};
        proof.nativeTranscriptFailure = {
          observation: 'unavailable',
          member: failedTask.owner,
          stage: captureStage,
          failure: {
            classification:
              captureError instanceof assert.AssertionError
                ? 'assertion_failed'
                : ([
                    'ENOENT',
                    'EACCES',
                    'EPERM',
                    'ETIMEDOUT',
                    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                  ].find((code) => failure.code === code) ??
                  (failure.killed === true
                    ? 'process_killed'
                    : Number.isSafeInteger(failure.code)
                      ? 'process_exit'
                      : 'unknown')),
            exitCode: Number.isSafeInteger(failure.code) ? Number(failure.code) : null,
            signal:
              ['SIGTERM', 'SIGKILL', 'SIGABRT'].find((signal) => failure.signal === signal) ?? null,
            killed: failure.killed === true,
          },
        };
      } finally {
        // Raw canonical messages include tool payloads and never enter proof.json.
        const removed = await unlink(output).then(
          () => true,
          (failure: unknown) =>
            typeof failure === 'object' &&
            failure !== null &&
            'code' in failure &&
            failure.code === 'ENOENT'
        );
        if (proof.nativeTranscriptFailure) proof.nativeTranscriptFailure.rawFileRemoved = removed;
        await unlink(bunConfig).catch(() => undefined);
      }
    }
    if (latestTasks.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tasks = await Promise.race([
          Promise.all(
            latestTasks.map(({ id, owner }) => app.call('getSafeTaskFailureSnapshot', id, owner))
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('TEST failure snapshot expired')), 10_000);
          }),
        ]);
        proof.taskFailureSnapshot = { unavailable: false, tasks };
      } catch {
        proof.taskFailureSnapshot = { unavailable: true, tasks: [] };
      } finally {
        clearTimeout(timer);
      }
    }
    if (proof.stage === 'create_team' || proof.stage === 'provision') {
      if (version.startsWith('2.') && proof.runIds.length) {
        let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          proof.startupFailureSnapshot = await Promise.race([
            packagedStartupSnapshot(
              desktop.root,
              desktop.env.CLAUDE_MULTIMODEL_DATA_HOME!,
              desktop.teamName,
              proof.runIds.at(-1)!
            ),
            new Promise((resolve) => {
              snapshotTimer = setTimeout(() => resolve({ observation: 'unavailable' }), 8000);
            }),
          ]);
        } catch {
          proof.startupFailureSnapshot = { observation: 'unavailable' };
        } finally {
          clearTimeout(snapshotTimer);
        }
      }
      try {
        const diagnostics = await app.call('getSafeLaunchFailure');
        const boundaries = ['not_submitted', 'project_registration', 'team_create', 'created'];
        const codes = [
          'workspace_trust_required',
          'transport_rejected',
          'stdin_missing',
          'provider_quota',
          'provider_auth',
          'opencode_runtime_readiness_timeout',
          'process_readiness_timeout',
          'opencode_protocol',
          'model_no_bootstrap',
          'process_exited',
          'unknown',
        ];
        proof.launchFailure = {
          boundary: boundaries.find((value) => value === diagnostics.boundary) ?? 'unknown',
        };
        if ('classification' in diagnostics)
          proof.launchFailure.classification =
            codes.find((value) => value === diagnostics.classification) ?? 'unknown';
        for (const key of [
          'bootstrapSubmitted',
          'submitRejected',
          'diagnosticsUnavailable',
        ] as const)
          if (key in diagnostics) proof.launchFailure[key] = diagnostics[key] === true;
      } catch {
        proof.launchFailure = { diagnosticsUnavailable: true };
      }
    }
    await checkpoint(proof.stage);
    throw new Error(
      'Windows full task qualification failed; preserve its TEST proof and auth custody'
    );
  } finally {
    try {
      if (teamActive) {
        try {
          await stopped(app, recordStop);
        } catch (error: unknown) {
          proof.status = 'failed';
          proof.cleanupFailures.push(proofFailure(error, 'team_stop'));
          await checkpoint(proof.stage);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const [observationRead, failureRead] = await Promise.race([
              Promise.allSettled([
                readStopObservation(app),
                app.call('getSafeStopFailure').then((value) => {
                  proof.stopFailureSnapshot = value;
                  return value;
                }),
              ]),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('TEST stop observation expired')),
                  10_000
                );
              }),
            ]);
            proof.stopFailureSnapshot =
              failureRead.status === 'fulfilled' ? failureRead.value : null;
            proof.stopFailureObservationUnavailable = observationRead.status === 'rejected';
            if (observationRead.status === 'fulfilled')
              await recordStop(observationRead.value.observation);
          } catch {
            proof.stopFailureObservationUnavailable = true;
          } finally {
            clearTimeout(timer);
          }
          await checkpoint(proof.stage);
        }
      }
    } finally {
      try {
        for (const original of heldProcesses) {
          const observed = await identity(original.pid);
          assert(
            !observed || observed.birth !== original.birth,
            'Owned held process survived normal stop; retain failed TEST state'
          );
        }
      } catch (error: unknown) {
        proof.status = 'failed';
        proof.cleanupFailures.push(proofFailure(error, 'held_process_cleanup'));
        await checkpoint(proof.stage);
      } finally {
        await closeApp();
      }
    }
  }
  proof.status = 'passed';
  await checkpoint('complete');
  console.log(`Windows full proof: ${proofFile}`);
}
const entryUrl = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (
  entryUrl &&
  (process.platform === 'win32'
    ? import.meta.url.toLowerCase() === entryUrl.toLowerCase()
    : import.meta.url === entryUrl)
)
  void main().catch((error: unknown) => {
    console.error(
      'Windows full qualification failed; preserve TEST state',
      JSON.stringify({ ...proofFailure(error, preproofStage), ...preproofFacts })
    );
    process.exitCode = 1;
  });
