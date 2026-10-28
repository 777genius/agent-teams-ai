import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import runtimeLock from '../../../../runtime.lock.json';

import { successfulTools } from './openCodeMixedTeamEvidence';
import {
  classifyTeamTranscriptGeneration,
  hasV2CommandInvocationWithOuterMarker,
  hasV2Message,
  hasV2TaskCompletion,
  readV2TeamInvocationEvidence,
} from './openCodeV2TeamEvidence';

// Produced by SDK normalizeV2Transcript + OpenCodeLogProjector from a synthetic
// native DTO. This is protocol evidence, never a live execution/authority claim.
const original = JSON.parse(
  readFileSync(path.resolve('test/fixtures/opencode/v2-code-mode-team-evidence.json'), 'utf8')
);
const binding = {
  teamName: 'TEST-team',
  runId: 'TEST-run',
  laneId: 'primary',
  memberName: 'alice',
  runtimeSessionId: 'ses_TESTunixComposite',
  selectedModel: 'TEST-provider/TEST-model',
};
const task = { id: 'TEST-task', owner: 'alice', status: 'completed' };
const message = { from: 'alice', to: 'bob', text: 'ACK:TEST-nonce' };
const command = {
  command: './.TEST-node-runtime sum.test.cjs',
  workdir: '/TEST/project',
  marker: 'ALICE_EXEC:TEST-marker',
};
const fixture = () => structuredClone(original);
const read = (value: unknown) => readV2TeamInvocationEvidence(value, binding);
const assistant = (value: ReturnType<typeof fixture>) => value.data.messages[1];
const checkTask = (value: unknown) => hasV2TaskCompletion(read(value), { taskId: task.id }, task);
const checkMessage = (value: unknown) =>
  hasV2Message(read(value), { to: message.to, text: message.text }, message);
const checkCommand = (value: unknown) =>
  hasV2CommandInvocationWithOuterMarker(read(value), command);

describe('V2 composite team evidence', () => {
  // Generation evidence follows the pinned range; a runtime without V2 qualifies no version.
  it.each([
    ...new Set([
      runtimeLock.opencodeV2.range.minimum,
      ...Object.values(runtimeLock.opencodeV2.qualified).flat(),
    ]),
  ])(
    'accepts the actual canonical producer shape for %s without inventing child results',
    (version) => {
      const value = fixture();
      value.runtime.version = version;
      const evidence = read(value);
      expect(classifyTeamTranscriptGeneration(value)).toBe('v2');
      expect(hasV2TaskCompletion(evidence, { taskId: task.id }, task)).toBe(true);
      expect(hasV2Message(evidence, { to: message.to, text: message.text }, message)).toBe(true);
      expect(hasV2CommandInvocationWithOuterMarker(evidence, command)).toBe(true);
      // The V1 reader still excludes metadata child IDs/results, as it must.
      expect(successfulTools(value).map((call) => call.name)).toEqual(['execute']);
      expect(
        assistant(value)
          .toolCalls.slice(1)
          .every(
            (call: { callId: unknown; output: unknown }) =>
              call.callId === null && call.output === null
          )
      ).toBe(true);
      expect(evidence).toEqual({ generation: 'v2' });
    }
  );

  it('preserves positive legacy classification and refuses failed/unknown V2 reads', () => {
    expect(classifyTeamTranscriptGeneration({ ok: true })).toBe('v1');
    expect(classifyTeamTranscriptGeneration({ ok: true, runtime: { version: '1.2.34' } })).toBe(
      'v1'
    );
    for (const version of [
      null,
      '',
      '2',
      '2.0.32-rc.1',
      'opencode v2.0.32',
      '3.0.0',
      2,
      {},
      ['1.2.3'],
    ]) {
      expect(() => classifyTeamTranscriptGeneration({ ok: true, runtime: { version } })).toThrow(
        'V2 original team evidence unavailable'
      );
    }
    expect(() => classifyTeamTranscriptGeneration({ ok: false })).toThrow();
    expect(() => readV2TeamInvocationEvidence({ ok: true }, binding)).toThrow();
    const missingVersion = fixture();
    delete missingVersion.runtime.version;
    expect(() => classifyTeamTranscriptGeneration(missingVersion)).toThrow();
    missingVersion.runtime.version = '1.2.34';
    expect(() => classifyTeamTranscriptGeneration(missingVersion)).toThrow();
  });

  it.each(['transcript', 'projection'])('requires the %s producer marker', (where) => {
    const value = fixture();
    (where === 'transcript' ? value.data : value.data.logProjection).diagnostics = [];
    expect(() => read(value)).toThrow();
  });

  it('requires original session, exact selected model and nonempty held bindings', () => {
    for (const key of ['session', 'projection', 'message', 'model', 'schema', 'command']) {
      const value = fixture();
      if (key === 'session') value.data.sessionId = 'ses_foreign';
      if (key === 'projection') value.data.logProjection.sessionId = 'ses_foreign';
      if (key === 'message') assistant(value).sessionId = 'ses_foreign';
      if (key === 'model') assistant(value).modelId = 'fallback';
      if (key === 'schema') value.schemaVersion = 2;
      if (key === 'command') value.command = 'opencode.sendMessage';
      expect(() => read(value)).toThrow();
    }
    for (const key of Object.keys(binding)) {
      expect(() => readV2TeamInvocationEvidence(fixture(), { ...binding, [key]: '' })).toThrow();
      expect(() =>
        readV2TeamInvocationEvidence(fixture(), { ...binding, [key]: ' padded ' })
      ).toThrow();
    }
    const value = fixture();
    value.data.messages.push({
      ...assistant(value),
      id: 'msg_foreignAssistant',
      modelId: 'fallback',
    });
    expect(() => read(value)).toThrow();
  });

  it('does not read user-injected calls or raw text as invocations', () => {
    const value = fixture();
    assistant(value).role = 'user';
    value.data.messages.push({
      ...assistant(fixture()),
      id: 'msg_cleanAssistant',
      toolCalls: [],
      contentBlocks: [],
    });
    expect(checkTask(value)).toBe(false);
    expect(checkMessage(value)).toBe(false);
    expect(checkCommand(value)).toBe(false);
    const textOnly = fixture();
    assistant(textOnly).toolCalls = [];
    assistant(textOnly).contentBlocks = [
      { type: 'text', text: JSON.stringify(assistant(fixture()).toolCalls) },
    ];
    expect(checkTask(textOnly)).toBe(false);
  });

  it.each([
    'missing',
    'foreign',
    'other-assistant',
    'wrong-name',
    'missing-result',
    'duplicate-result',
    'result-running',
    'result-error',
    'output-mismatch',
  ])('requires a real same-assistant outer execute pair: %s', (mode) => {
    const value = fixture(),
      current = assistant(value);
    if (mode === 'missing') current.toolCalls.shift();
    if (mode === 'foreign') current.toolCalls[1].source.outerCallId = 'foreign';
    if (mode === 'other-assistant') {
      value.data.messages.push({
        ...current,
        id: 'msg_otherAssistant',
        toolCalls: [current.toolCalls.shift()],
      });
      current.contentBlocks = current.contentBlocks.slice(2);
    }
    if (mode === 'wrong-name') current.toolCalls[0].toolName = 'other';
    if (mode === 'missing-result') current.contentBlocks.splice(1, 1);
    if (mode === 'duplicate-result') current.contentBlocks.push(current.contentBlocks[1]);
    if (mode === 'result-running') current.contentBlocks[1].status = 'running';
    if (mode === 'result-error') current.contentBlocks[1].isError = true;
    if (mode === 'output-mismatch') current.contentBlocks[1].contentText = 'forged marker';
    expect(checkCommand(value)).toBe(false);
    if (mode !== 'foreign') expect(checkTask(value)).toBe(false);
  });

  it.each([
    'running',
    'errored',
    'hasError',
    'fabricated-id',
    'fabricated-output',
    'fabricated-outputText',
    'fabricated-time',
  ])('refuses invalid metadata invocation state: %s', (mode) => {
    const value = fixture();
    for (const [index, call] of assistant(value).toolCalls.slice(1).entries()) {
      if (mode === 'running' || mode === 'errored') call.status = mode;
      if (mode === 'hasError') call.isError = true;
      if (mode === 'fabricated-id') call.callId = `invented-child-${index}`;
      if (mode === 'fabricated-output') call.output = [{ type: 'text', text: command.marker }];
      if (mode === 'fabricated-outputText') call.outputText = command.marker;
      if (mode === 'fabricated-time') call.completedAt = 25;
    }
    expect(checkTask(value)).toBe(false);
    expect(checkMessage(value)).toBe(false);
    expect(checkCommand(value)).toBe(false);
  });

  it.each(['running', 'errored', 'error'])('refuses non-successful outer execution: %s', (mode) => {
    const value = fixture();
    if (mode === 'error') assistant(value).toolCalls[0].isError = true;
    else assistant(value).toolCalls[0].status = mode;
    expect(checkTask(value)).toBe(false);
    expect(checkMessage(value)).toBe(false);
    expect(checkCommand(value)).toBe(false);
  });

  it('requires exact structured invocation identity as well as actual durable task state', () => {
    const evidence = read(fixture());
    for (const actual of [
      undefined,
      {},
      { ...task, id: 'other' },
      { ...task, owner: 'bob' },
      { ...task, status: 'in_progress' },
    ]) {
      expect(hasV2TaskCompletion(evidence, { taskId: task.id }, actual)).toBe(false);
    }
    for (const [key, replacement] of [
      ['teamName', 'other'],
      ['taskId', 'other'],
      ['actor', 'bob'],
    ]) {
      const value = fixture();
      assistant(value).toolCalls[2].input[key] = replacement;
      expect(checkTask(value)).toBe(false);
    }
    const value = fixture();
    assistant(value).toolCalls[2].toolName = 'untrusted.agent-teams.task_complete';
    expect(checkTask(value)).toBe(false);
  });

  it('requires the actual inbox sender/recipient/exact nonce, not invocation metadata alone', () => {
    const evidence = read(fixture());
    for (const actual of [
      undefined,
      {},
      { ...message, from: 'bob' },
      { ...message, to: 'user' },
      { ...message, text: `${message.text} suffix` },
    ]) {
      expect(hasV2Message(evidence, { to: message.to, text: message.text }, actual)).toBe(false);
    }
    for (const [key, replacement] of [
      ['teamName', 'other'],
      ['from', 'bob'],
      ['to', 'user'],
      ['text', `${message.text} suffix`],
    ]) {
      const value = fixture();
      assistant(value).toolCalls[3].input[key] = replacement;
      expect(checkMessage(value)).toBe(false);
    }
  });

  it('requires exact shell command/workdir and a complete output marker line in that same outer call', () => {
    const evidence = read(fixture());
    for (const expected of [
      { ...command, command: 'echo marker' },
      { ...command, workdir: '/foreign' },
      { ...command, marker: 'TEST-marker' },
      { ...command, marker: `${command.marker}\nother` },
    ]) {
      expect(hasV2CommandInvocationWithOuterMarker(evidence, expected)).toBe(false);
    }
    const value = fixture();
    assistant(value).toolCalls[1].toolName = 'unknown.shell';
    expect(checkCommand(value)).toBe(false);
    const unrelated = fixture(),
      current = assistant(unrelated);
    const other = structuredClone(current);
    other.id = 'msg_unrelatedOutput';
    other.toolCalls = [other.toolCalls[0]];
    other.contentBlocks = other.contentBlocks.slice(0, 2);
    unrelated.data.messages.push(other);
    current.toolCalls[0].output[0].text = 'no marker here';
    current.toolCalls[0].outputText = 'no marker here';
    current.contentBlocks[1].contentText = 'no marker here';
    expect(checkCommand(unrelated)).toBe(false);
  });

  it('supports a real paired direct native shell without promoting metadata into V1 success', () => {
    const value = fixture(),
      current = assistant(value),
      native = current.toolCalls[0];
    native.toolName = 'shell';
    native.input = { command: command.command, workdir: command.workdir };
    current.toolCalls = [native];
    current.contentBlocks = current.contentBlocks.slice(0, 2);
    current.contentBlocks[0].name = 'shell';
    current.contentBlocks[0].input = native.input;
    current.contentBlocks[1].toolName = 'shell';
    expect(checkCommand(value)).toBe(true);
    expect(checkTask(value)).toBe(false);
  });

  it('captures evidence immutably and rejects unminted tokens, proxies and accessors without invoking them', () => {
    const value = fixture(),
      evidence = read(value);
    assistant(value).toolCalls[2].input.actor = 'bob';
    expect(hasV2TaskCompletion(evidence, { taskId: task.id }, task)).toBe(true);
    expect(hasV2TaskCompletion({ generation: 'v2' }, { taskId: task.id }, task)).toBe(false);
    let calls = 0;
    const getter = {
      ok: true,
      get runtime() {
        calls++;
        throw new Error('secret');
      },
    };
    expect(() => classifyTeamTranscriptGeneration(getter)).toThrow(
      'V2 original team evidence unavailable'
    );
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error('secret');
        },
        getOwnPropertyDescriptor() {
          calls++;
          throw new Error('secret');
        },
      }
    );
    expect(() => read(proxy)).toThrow('V2 original team evidence unavailable');
    expect(() => classifyTeamTranscriptGeneration({ ok: true, runtime: proxy })).toThrow();
    expect(hasV2TaskCompletion(evidence, { taskId: task.id }, proxy)).toBe(false);
    const model = fixture();
    assistant(model).providerId = {
      toString() {
        calls++;
        throw new Error('secret');
      },
    };
    expect(() => read(model)).toThrow();
    expect(calls).toBe(0);
  });
});
