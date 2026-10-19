import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

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
