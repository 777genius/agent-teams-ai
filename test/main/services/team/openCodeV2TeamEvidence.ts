import { types } from 'node:util';

import { isOpenCodeV2RangeVersion } from '../../../../src/features/opencode-compatibility/core/domain/pinnedOpenCodeV2Contract';

type Row = Record<string, unknown>;
export interface V2TeamEvidenceBinding {
  teamName: string;
  runId: string;
  laneId: string;
  memberName: string;
  runtimeSessionId: string;
  selectedModel: string;
}
export type V2TeamInvocationEvidence = Readonly<{ generation: 'v2' }>;
type Invocation = {
  name: string;
  args: Readonly<Record<string, string | undefined>>;
  nativeOutput: string | null;
  outerOutput: string | null;
};
const retained = new WeakMap<
  V2TeamInvocationEvidence,
  {
    binding: Readonly<V2TeamEvidenceBinding>;
    invocations: Invocation[];
  }
>();
const marker = 'v2_native_parent_ids_unavailable';
const fields = ['teamName', 'taskId', 'actor', 'from', 'to', 'text', 'command', 'workdir'] as const;
const shellNames = ['bash', 'shell', 'exec', 'system.bash'];

// These are TEST evidence readers, not a source of runtime authority. The caller
// must obtain the transcript through the exact original run/lane/member request.
function row(value: unknown): Row | null {
  return value !== null &&
    typeof value === 'object' &&
    !types.isProxy(value) &&
    !Array.isArray(value)
    ? (value as Row)
    : null;
}
function own(value: unknown, key: string): unknown {
  const object = row(value);
  if (!object) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  required(!descriptor || 'value' in descriptor);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function list(value: unknown, limit: number): unknown[] | null {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value))
    return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}
function required(condition: unknown): asserts condition {
  if (!condition) throw new Error('V2 original team evidence unavailable');
}
function exactString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0')
  );
}
function args(value: unknown): Invocation['args'] {
  return Object.fromEntries(
    fields.map((key) => {
      const item = own(value, key);
      return [key, typeof item === 'string' ? item : undefined];
    })
  );
}
function sameArgs(left: Invocation['args'], right: Invocation['args']): boolean {
  return fields.every((key) => left[key] === right[key]);
}
function isTeamTool(name: string, operation: 'task_complete' | 'message_send'): boolean {
  return [
    operation,
    `agent-teams.${operation}`,
    `agent-teams_${operation}`,
    `agent_teams_${operation}`,
    `mcp__agent-teams__${operation}`,
  ].includes(name);
}

/** Unknown versions and failed reads cannot fall back to the V1 evidence policy. */
export function classifyTeamTranscriptGeneration(transcript: unknown): 'v1' | 'v2' {
  required(own(transcript, 'ok') === true);
  const runtime = own(transcript, 'runtime');
  required(runtime === undefined || row(runtime));
  const version = own(runtime, 'version');
  if (
    version === undefined ||
    (typeof version === 'string' && /^1\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
  ) {
    const data = own(transcript, 'data');
    required(
      !list(own(data, 'diagnostics'), 8192)?.includes(marker) &&
        !list(own(own(data, 'logProjection'), 'diagnostics'), 8192)?.includes(marker)
    );
    return 'v1';
  }
  // The pinned runtime's V2 range; FULL itself runs only versions qualified on its platform.
  required(typeof version === 'string' && isOpenCodeV2RangeVersion(version));
  return 'v2';
}

function nativePair(
  call: unknown,
  blocks: unknown[]
): { name: string; input: Invocation['args']; output: string | null } | null {
  const id = own(call, 'callId'),
    name = own(call, 'toolName');
  if (
    !exactString(id) ||
    !exactString(name) ||
    own(call, 'source') !== undefined ||
    own(call, 'status') !== 'completed' ||
    own(call, 'isError') !== false
  )
    return null;
  const uses = blocks.filter(
    (block) => own(block, 'type') === 'tool_use' && own(block, 'id') === id
  );
  const results = blocks.filter(
    (block) => own(block, 'type') === 'tool_result' && own(block, 'toolUseId') === id
  );
  if (uses.length !== 1 || results.length !== 1) return null;
  const use = uses[0],
    result = results[0],
    input = args(own(call, 'input'));
  if (
    !row(own(call, 'input')) ||
    !row(own(use, 'input')) ||
    own(use, 'name') !== name ||
    own(use, 'status') !== 'completed' ||
    !sameArgs(input, args(own(use, 'input'))) ||
    own(result, 'toolName') !== name ||
    own(result, 'status') !== 'completed' ||
    own(result, 'isError') !== false
  )
    return null;
  if (
    name === 'execute' &&
    (typeof own(own(call, 'input'), 'code') !== 'string' ||
      own(own(call, 'input'), 'code') !== own(own(use, 'input'), 'code'))
  )
    return null;
  const content = list(own(call, 'output'), 8192);
  if (!content?.length) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (own(item, 'type') === 'text' && typeof own(item, 'text') === 'string')
      texts.push(own(item, 'text') as string);
    else if (
      !(
        own(item, 'type') === 'file' &&
        typeof own(item, 'uri') === 'string' &&
        typeof own(item, 'mime') === 'string'
      )
    )
      return null;
  }
  const output = texts.length ? texts.join('\n') : null;
  if (own(call, 'outputText') !== output || own(result, 'contentText') !== output) return null;
  return { name, input, output };
}

/** Keeps metadata invocation evidence separate from native child results, which
 * the official CodeMode protocol does not persist. No child result is invented. */
export function readV2TeamInvocationEvidence(
  transcript: unknown,
  original: V2TeamEvidenceBinding
): V2TeamInvocationEvidence {
  required(classifyTeamTranscriptGeneration(transcript) === 'v2');
  required(
    own(transcript, 'schemaVersion') === 1 &&
      own(transcript, 'command') === 'opencode.getRuntimeTranscript'
  );
  const originalString = (key: keyof V2TeamEvidenceBinding): string => {
    const value = own(original, key);
    required(exactString(value));
    return value;
  };
  const binding: V2TeamEvidenceBinding = {
    teamName: originalString('teamName'),
    runId: originalString('runId'),
    laneId: originalString('laneId'),
    memberName: originalString('memberName'),
    runtimeSessionId: originalString('runtimeSessionId'),
    selectedModel: originalString('selectedModel'),
  };
  required(/^ses_[A-Za-z0-9]+$/.test(binding.runtimeSessionId));
  const data = own(transcript, 'data'),
    projection = own(data, 'logProjection');
  required(
    own(data, 'sessionId') === binding.runtimeSessionId &&
      own(projection, 'sessionId') === binding.runtimeSessionId
  );
  required(
    list(own(data, 'diagnostics'), 8192)?.includes(marker) &&
      list(own(projection, 'diagnostics'), 8192)?.includes(marker)
  );
  const messages = list(own(data, 'messages'), 1600);
  required(messages);
  const invocations: Invocation[] = [];
  let assistants = 0,
    totalCalls = 0;
  const messageIds = new Set<string>();
  for (const message of messages) {
    const id = own(message, 'id');
    required(exactString(id) && /^msg_[A-Za-z0-9]+$/.test(id) && !messageIds.has(id));
    messageIds.add(id);
    const session = own(message, 'sessionId');
    required(session === undefined || session === binding.runtimeSessionId);
    if (own(message, 'role') !== 'assistant') continue;
    assistants++;
    const provider = own(message, 'providerId'),
      model = own(message, 'modelId');
    required(
      exactString(provider) &&
        exactString(model) &&
        `${provider}/${model}` === binding.selectedModel
    );
    const calls = list(own(message, 'toolCalls'), 8192),
      blocks = list(own(message, 'contentBlocks'), 16384);
    required(calls && blocks && (totalCalls += calls.length) <= 65536);
    if (own(message, 'hasError') !== false) continue;
    const native = new Map<string, ReturnType<typeof nativePair>>();
    for (const call of calls) {
      const callId = own(call, 'callId');
      if (!exactString(callId)) continue;
      required(!native.has(callId));
      const pair = nativePair(call, blocks);
      native.set(callId, pair);
      if (pair)
        invocations.push({
          name: pair.name,
          args: pair.input,
          nativeOutput: pair.output,
          outerOutput: null,
        });
    }
    const indices = new Set<string>();
    for (const call of calls) {
      const source = own(call, 'source');
      if (own(source, 'kind') !== 'opencode-v2-code-mode-metadata') continue;
      const outerId = own(source, 'outerCallId'),
        index = own(source, 'index'),
        name = own(call, 'toolName');
      if (
        !exactString(outerId) ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= 4096 ||
        !exactString(name) ||
        own(call, 'callId') !== null ||
        own(call, 'status') !== 'completed' ||
        own(call, 'isError') !== false ||
        own(call, 'output') !== null ||
        own(call, 'outputText') !== null ||
        own(call, 'outputPreview') !== null ||
        own(call, 'startedAt') !== null ||
        own(call, 'completedAt') !== null
      )
        continue;
      const key = `${outerId}:${index}`;
      required(!indices.has(key));
      indices.add(key);
      const outer = native.get(outerId);
      if (outer?.name !== 'execute') continue;
      invocations.push({
        name,
        args: args(own(call, 'input')),
        nativeOutput: null,
        outerOutput: outer.output,
      });
    }
  }
  required(assistants > 0);
  const evidence = Object.freeze({ generation: 'v2' as const });
  retained.set(evidence, { binding: Object.freeze(binding), invocations });
  return evidence;
}

export function hasV2TaskCompletion(
  evidence: V2TeamInvocationEvidence,
  expected: { taskId: string },
  actualTask: unknown
): boolean {
  const state = retained.get(evidence),
    taskId = own(expected, 'taskId');
  return (
    !!state &&
    exactString(taskId) &&
    own(actualTask, 'id') === taskId &&
    own(actualTask, 'owner') === state.binding.memberName &&
    own(actualTask, 'status') === 'completed' &&
    state.invocations.some(
      (call) =>
        isTeamTool(call.name, 'task_complete') &&
        call.args.teamName === state.binding.teamName &&
        call.args.taskId === taskId &&
        call.args.actor === state.binding.memberName
    )
  );
}

export function hasV2Message(
  evidence: V2TeamInvocationEvidence,
  expected: { to: string; text: string },
  actualInboxMessage: unknown
): boolean {
  const state = retained.get(evidence),
    to = own(expected, 'to'),
    text = own(expected, 'text');
  return (
    !!state &&
    exactString(to) &&
    exactString(text) &&
    own(actualInboxMessage, 'from') === state.binding.memberName &&
    own(actualInboxMessage, 'to') === to &&
    own(actualInboxMessage, 'text') === text &&
    state.invocations.some(
      (call) =>
        isTeamTool(call.name, 'message_send') &&
        call.args.teamName === state.binding.teamName &&
        call.args.from === state.binding.memberName &&
        call.args.to === to &&
        call.args.text === text
    )
  );
}

/** A matching invocation plus its actual same-assistant native output is only
 * composite evidence. The FULL test must also verify the real files/process. */
export function hasV2CommandInvocationWithOuterMarker(
  evidence: V2TeamInvocationEvidence,
  expected: { command: string; workdir: string; marker: string }
): boolean {
  const state = retained.get(evidence),
    command = own(expected, 'command'),
    workdir = own(expected, 'workdir'),
    line = own(expected, 'marker');
  return (
    !!state &&
    exactString(command) &&
    exactString(workdir) &&
    exactString(line) &&
    !/[\r\n]/.test(line) &&
    state.invocations.some(
      (call) =>
        shellNames.includes(call.name) &&
        call.args.command === command &&
        call.args.workdir === workdir &&
        (call.nativeOutput ?? call.outerOutput)?.split(/\r?\n/).includes(line) === true
    )
  );
}
