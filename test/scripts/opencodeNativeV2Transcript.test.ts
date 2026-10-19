import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { nativeCommandMatch } from '../../scripts/e2e/opencode-native-team-port';
import { projectV2NativeTranscript } from '../../scripts/e2e/opencode-native-v2-transcript';
import { parseSingleBridgeJsonResult, validateBridgeResultEnvelope } from '../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

const expected = { sessionId: 'ses_TESToriginal', selectedModel: 'openrouter/TEST/model', runtimePromptMessageId: 'msg_TESTinput' };
const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'msg_TESTassistant', role: 'assistant',
  providerId: 'openrouter', modelId: 'TEST/model', completedAt: 123, hasError: false,
  errorName: null, errorMessage: null, finishReason: 'stop', toolCalls: [], ...overrides });
const fixture = () => ({ sessionId: expected.sessionId, durableState: 'running', messages: [
  message({ id: expected.runtimePromptMessageId, role: 'user', text: 'PRIVATE_PROMPT token=C:/PRIVATE_PATH' }),
  message({ hasError: true, errorName: 'APICallError', errorMessage: JSON.stringify({ statusCode: 401,
    code: 'invalid_api_key', message: 'PRIVATE_BODY', headers: { authorization: 'PRIVATE_AUTH' } }),
    reasoningText: 'PRIVATE_REASONING', toolCalls: [{ toolName: 'proxy_task_get', isError: true,
      input: { token: 'PRIVATE_TOKEN' }, outputText: 'PRIVATE_OUTPUT' }] }),
] });

describe('bounded public V2 transcript failure observation', () => {
  it('decodes the actual public envelope and emits only finite original-session facts', () => {
    const envelope = { schemaVersion: 1 as const, requestId: 'TEST-cut', command: 'opencode.getRuntimeTranscript' as const };
    const parsed = parseSingleBridgeJsonResult(JSON.stringify({ ...envelope, completedAt: 'TEST-time', durationMs: 1,
      ok: true, diagnostics: [], runtime: { providerId: 'opencode', binaryPath: null,
        binaryFingerprint: null, version: '2.0.32', capabilitySnapshotId: null }, data: fixture() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('TEST decoder refused');
    expect(validateBridgeResultEnvelope(parsed.value, envelope).ok).toBe(true);
    if (!parsed.value.ok) throw new Error('TEST public cut refused');
    const packet = projectV2NativeTranscript(parsed.value.data, expected);
    expect(packet).toMatchObject({ sessionMatches: true, originalInputPresent: true, durableState: 'running',
      messageCount: 2, userCount: 1, assistantCount: 1, completedAssistantCount: 1, matchingModelAssistantCount: 1,
      errorAssistantCount: 1, toolCount: 1, toolErrorCount: 1, toolCategories: ['task_get'],
      assistantFailures: [{ name: 'APICallError', providerCode: 'invalid_api_key', httpStatus: 401 }] });
    expect(JSON.stringify(packet)).not.toMatch(/PRIVATE_|ses_TEST|msg_TEST|TEST\/model|authorization|reasoningText|outputText/);
    expect(packet).not.toHaveProperty('logProjection');
    expect(packet).not.toHaveProperty('seq');
  });
  it('keeps absent native input identity unknown and reports mismatches without granting turn authority', () => {
    expect(projectV2NativeTranscript(fixture(), { ...expected, runtimePromptMessageId: null }).originalInputPresent).toBeNull();
    expect(projectV2NativeTranscript(fixture(), { ...expected, runtimePromptMessageId: 'msg_OTHER' }).originalInputPresent).toBe(false);
    const data = fixture(); data.messages[1].modelId = 'different';
    expect(projectV2NativeTranscript(data, expected)).toMatchObject({ matchingModelAssistantCount: 0,
      differentOrMissingModelAssistantCount: 1 });
  });
  it.each(['foreign', 'state', 'duplicate', 'roles', 'messages', 'tools'])(
    'refuses malformed or foreign %s', kind => {
      const data = fixture();
      if (kind === 'foreign') data.sessionId = 'ses_foreign';
      if (kind === 'state') data.durableState = 'PRIVATE_STATUS';
      if (kind === 'duplicate') data.messages[1].id = data.messages[0].id;
      if (kind === 'roles') data.messages[1].role = 'PRIVATE_ROLE';
      if (kind === 'messages') data.messages = Array.from({ length: 1601 }, (_, index) => message({ id: `msg_${index}` }));
      if (kind === 'tools') data.messages[1].toolCalls = new Array(4097);
      expect(() => projectV2NativeTranscript(data, expected)).toThrow();
    }
  );
  it('rejects accessors, proxies, coercion and cumulative tool overflow before materializing excess tools', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER'); });
    expect(() => projectV2NativeTranscript(Object.defineProperty(fixture(), 'messages', { get: getter }), expected)).toThrow();
    const trap = vi.fn(() => { throw new Error('PRIVATE_PROXY'); });
    expect(() => projectV2NativeTranscript(new Proxy({}, { getOwnPropertyDescriptor: trap }), expected)).toThrow();
    const data = fixture(); data.messages[1].role = { toString: getter } as never;
    expect(() => projectV2NativeTranscript(data, expected)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    const tool = { toolName: 'bash', isError: false };
    const rows = Array.from({ length: 5 }, (_, index) => message({ id: `msg_${index}`, toolCalls: Array(4096).fill(tool) }));
    const overflow = Object.defineProperty([], '0', { get: getter }); overflow.length = 4096;
    rows[4].toolCalls = overflow;
    expect(() => projectV2NativeTranscript({ ...fixture(), messages: rows }, expected)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('keeps the one public command before original Stop and after-Stop filesystem evidence separate', async () => {
    const source = await readFile('scripts/e2e/opencode-native-windows-full.ts', 'utf8');
    const capture = source.indexOf("command: 'opencode.getRuntimeTranscript'");
    const stop = source.indexOf('await stopped(app, recordStop);', capture);
    const after = source.indexOf("proof.runIds.at(-1)!, 'after_original_stop'", stop);
    expect(capture).toBeGreaterThan(0); expect(stop).toBeGreaterThan(capture); expect(after).toBeGreaterThan(stop);
    expect(source).toContain('capture.inputFileRemoved = await unlink(inputFile)');
    expect(source).toContain("await execute(bun, ['--no-env-file', `--config=${bunConfig}`, entry,");
    expect(source).toContain('Raw canonical messages remain only in this bounded child stdout/in-memory parser.');
  });
});

describe('finite canonical command observation', () => {
  const command = { program: 'C:\\TEST-project\\verify.cjs', marker: 'TEST_VERIFIED' };
  const inspect = (messages: Record<string, unknown>[], runtimePromptMessageId: string | null = expected.runtimePromptMessageId) =>
    projectV2NativeTranscript({ sessionId: expected.sessionId, durableState: 'idle', messages }, { ...expected, runtimePromptMessageId, command }).commandObservation!;
  const call = (overrides: Record<string, unknown> = {}) => ({ callId: 'PRIVATE_NATIVE_ID', toolName: 'shell', status: 'completed',
    isError: false, input: { command: `node ${command.program}`, workdir: 'C:\\TEST-project' },
    outputText: `PRIVATE_OUTPUT\n${command.marker}\n`, output: null, ...overrides });
  const row = (id: string, toolCalls: unknown[] = [], role = 'assistant') => message({ id, toolCalls, role });

  it('separates original input window from later input, actual native output and metadata invocation', () => {
    const packet = inspect([
      row('msg_BEFORE', [call()]), row(expected.runtimePromptMessageId, [], 'user'),
      row('msg_WITHIN', [call(), call({ callId: null, source: { kind: 'opencode-v2-code-mode-metadata', outerCallId: 'PRIVATE_OUTER_ID', index: 0 },
        outputText: command.marker, output: [{ type: 'text', text: command.marker }] })]),
      row('msg_NEXT', [], 'user'), row('msg_AFTER', [call({ toolName: 'execute', status: 'PRIVATE_STATUS', isError: true })]),
    ]);
    expect(packet).toMatchObject({ originalInputIndex: 1, nextInputIndex: 3, total: 4, exhaustive: true,
      relationCounts: { before_original: 1, original_window: 2, after_next_input: 1, unknown: 0 } });
    expect(packet.tuples[1]).toMatchObject({ relation: 'original_window', source: 'native', modelMatches: true,
      nativeCallIdPresent: true, status: 'completed', isError: false, outputPresent: true, markerLinePresent: true,
      input: { shell: true, programMatches: true, nodeMatches: true } });
    expect(packet.tuples[2]).toMatchObject({ source: 'code-mode-metadata', nativeCallIdPresent: false,
      outputPresent: null, markerLinePresent: null });
    expect(packet.tuples[3]).toMatchObject({ relation: 'after_next_input', tool: 'execute', status: 'unknown', isError: true });
    expect(JSON.stringify(packet)).not.toMatch(/PRIVATE_|TEST-project|verify\.cjs|TEST_VERIFIED|msg_|outputText|callId|outerCallId/);
    expect(packet.tuples[1]).not.toHaveProperty('resultPaired');
    expect(packet.tuples[1]).not.toHaveProperty('succeeded');
  });

  it('keeps unknown original input relation unknown and caps retained tuples independently of totals', () => {
    const rows = [row('msg_ONLY', Array.from({ length: 10 }, (_, index) => call({ toolName: index === 0 ? 'read' : 'bash', ...(index === 0 ? { input: { path: 'PRIVATE_PATH' } } : {}) })))];
    const packet = inspect(rows, null);
    expect(packet).toMatchObject({ originalInputIndex: null, nextInputIndex: null, total: 9, exhaustive: false,
      relationCounts: { unknown: 9, before_original: 0, original_window: 0, after_next_input: 0 } });
    expect(packet.tuples).toHaveLength(8);
    expect(inspect(rows, 'msg_ABSENT').tuples.every(tuple => tuple.relation === 'unknown')).toBe(true);
    expect(projectV2NativeTranscript(fixture(), expected)).not.toHaveProperty('commandObservation');
  });

  it.each([
    ['shell', 'node C:\\TEST-project\\verify.cjs', undefined],
    ['bash', 'node "C:/TEST-project/verify.cjs"', undefined],
    ['exec', 'NODE.EXE c:/test-project/verify.cjs', undefined],
    ['shell', 'node ./verify.cjs', 'C:\\TEST-project'],
    ['shell', 'node verify.cjs', 'C:/foreign'],
    ['shell', 'echo node C:\\TEST-project\\verify.cjs', undefined],
    ['execute', 'node C:\\TEST-project\\verify.cjs', undefined],
    ['proxy_shell', 'node C:\\TEST-project\\verify.cjs', undefined],
  ])('mirrors existing matcher input predicates for %s / %s', (toolName, inputCommand, workdir) => {
    const tool = call({ toolName, input: { command: inputCommand, workdir } });
    const actual = nativeCommandMatch({ toolCall: { id: 'TEST-call', name: toolName!, input: tool.input } } as never, command.program, command.marker);
    const packet = inspect([row(expected.runtimePromptMessageId, [], 'user'), row('msg_WITHIN', [tool])]);
    expect(packet.tuples[0]?.input).toEqual({ shell: actual.shell, programMatches: actual.programMatches,
      nodeMatches: actual.nodeMatches, commandShape: actual.commandShape });
    if (toolName === 'proxy_shell') expect(packet.tuples[0]?.tool).toBe('other');
  });

  it('uses only own data and retains no raw command, path, output, status or coercion', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER'); });
    const input = Object.defineProperty({ workdir: 'PRIVATE_PATH' }, 'command', { get: getter });
    const tool = call({ input, status: { toString: getter }, outputText: undefined,
      output: [{ type: 'text', text: `PRIVATE_OUTPUT\n${command.marker}` }] });
    const packet = inspect([row(expected.runtimePromptMessageId, [], 'user'), row('msg_WITHIN', [tool])]);
    expect(getter).not.toHaveBeenCalled();
    expect(packet.tuples[0]).toMatchObject({ status: 'unknown', input: { programMatches: false, nodeMatches: false }, markerLinePresent: true });
    expect(JSON.stringify(packet)).not.toContain('PRIVATE_');
    expect(() => inspect([row(expected.runtimePromptMessageId, [], 'user'), row('msg_WITHIN', [call({ input: new Proxy({}, { getOwnPropertyDescriptor: getter }) })])])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const bounded = inspect([row(expected.runtimePromptMessageId, [], 'user'), row('msg_WITHIN', [call({ input: { command: 'X'.repeat(32_769) }, outputText: 'X'.repeat(1_048_577) })])]);
    expect(bounded.tuples[0]).toMatchObject({ input: null, outputPresent: true, markerLinePresent: null });
  });
});
