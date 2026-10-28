import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeToolReceipt } from '../native-claude-team/model.ts';

type Row = Record<string, unknown>;
export interface UiTool { name: string; namespace?: string }
export interface UiPalette { tools: UiTool[]; exec?: UiTool }
export const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};

/** Pinned 0.162 Lite puts its actual palette in the first developer additional_tools item. */
export function uiPalette(body: Row): UiPalette {
  const input = (Array.isArray(body.input) ? body.input : []).map(object);
  const additional = input.filter(item => item.type === 'additional_tools');
  let declared = body.tools;
  if (additional.length) {
    assert.equal(additional.length, 1); assert.equal(input[0], additional[0]);
    assert.equal(additional[0]!.role, 'developer');
    assert.ok(typeof additional[0]!.id === 'string' && additional[0]!.id.startsWith('at_'));
    assert.equal(body.tools, undefined, 'one canonical native tool palette');
    declared = additional[0]!.tools;
  }
  assert.ok(Array.isArray(declared), 'actual native palette required');
  const tools: UiTool[] = [], executors: UiTool[] = [];
  const add = (raw: unknown, namespace?: string) => {
    const tool = object(raw); assert.equal(typeof tool.name, 'string');
    const item = { name: String(tool.name), ...(namespace === undefined ? {} : { namespace }) };
    tools.push(item);
    if (tool.type !== 'custom' || tool.name !== 'exec') return;
    assert.ok(namespace === undefined || namespace === 'functions');
    const format = object(tool.format);
    assert.equal(format.type, 'grammar'); assert.equal(format.syntax, 'lark');
    assert.ok(typeof format.definition === 'string' && format.definition.includes('SOURCE'));
    executors.push(item);
  };
  for (const raw of declared) {
    const tool = object(raw);
    if (tool.type === 'namespace') {
      assert.equal(typeof tool.name, 'string'); assert.ok(Array.isArray(tool.tools));
      for (const child of tool.tools) add(child, String(tool.name));
    } else add(tool);
  }
  assert.ok(executors.length <= 1, 'exactly one advertised Code Mode executor');
  return { tools, ...(executors[0] ? { exec: executors[0] } : {}) };
}

const literalEscapes: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
/** JSON data embedded in the fixed TEST script, including non-ASCII separators. */
function codeModeLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new TypeError('TEST Code Mode value is not JSON-serializable');
  return serialized.replace(/[<>\u2028\u2029]/g, (char) => literalEscapes[char]!);
}

/** A single Code Mode call invokes exactly one original authoritative action. */
export function codeModeCall(exec: UiTool, action: { name: string; input: Row }, callId: string): Row {
  assert.match(action.name, /^(?:exec_command|task_create|task_set_owner|task_start|task_add_comment|task_complete|message_send)$/);
  const names = action.name === 'exec_command' ? ['exec_command']
    : [`mcp__team__${action.name}`, `team__${action.name}`];
  const input = `const allowed = ${codeModeLiteral(names)};\n` +
    'const selected = ALL_TOOLS.filter(({ name }) => allowed.includes(name));\n' +
    'if (selected.length !== 1 || typeof tools[selected[0].name] !== "function") throw new Error("TEST exact native tool unavailable");\n' +
    `text(JSON.stringify(await tools[selected[0].name](${codeModeLiteral(action.input)})));`;
  return { type: 'custom_tool_call', call_id: callId, name: exec.name,
    ...(exec.namespace === undefined ? {} : { namespace: exec.namespace }), input };
}

/** Never select the last foreign result, even when its payload would pass a receipt check. */
export function linkedOutput(input: readonly Row[], callId: string, codeMode: boolean, issued?: Row): Row {
  const callType = codeMode ? 'custom_tool_call' : 'function_call';
  const outputType = codeMode ? 'custom_tool_call_output' : 'function_call_output';
  const calls = input.filter(item => item.call_id === callId &&
    ['function_call', 'custom_tool_call'].includes(String(item.type)));
  const outputs = input.filter(item => item.call_id === callId &&
    ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)));
  assert.equal(calls.length, 1, 'one original native call');
  assert.equal(outputs.length, 1, 'one original native result');
  assert.equal(calls[0]!.type, callType); assert.equal(outputs[0]!.type, outputType);
  if (codeMode) {
    assert.equal(calls[0]!.name, 'exec');
    assert.ok(calls[0]!.namespace === undefined || calls[0]!.namespace === 'functions');
  }
  if (issued) {
    for (const key of ['type', 'call_id', 'name', codeMode ? 'input' : 'arguments'])
      assert.equal(calls[0]![key], issued[key], 'exact original emitted call');
    assert.equal(calls[0]!.namespace ?? 'functions', issued.namespace ?? 'functions');
  }
  return outputs[0]!;
}

const completedHeader = /^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/;
export function codeModeResult(output: unknown): Row {
  let printed: string;
  if (typeof output === 'string') {
    const header = /^Script completed\nWall time \d+\.\d seconds\nOutput:\n/.exec(output);
    assert.ok(header); printed = output.slice(header[0].length);
  } else {
    assert.ok(Array.isArray(output)); assert.equal(output.length, 2);
    const [header, result] = output.map(object);
    assert.equal(header!.type, 'input_text'); assert.equal(result!.type, 'input_text');
    assert.equal(typeof header!.text, 'string'); assert.match(String(header!.text), completedHeader);
    assert.equal(typeof result!.text, 'string'); printed = String(result!.text);
  }
  assert.ok(Buffer.byteLength(printed) <= 256 * 1024);
  return object(JSON.parse(printed));
}

export function codeModeReceipt(result: Row): Row {
  assert.ok(result.isError === undefined || result.isError === false, 'native MCP result is not an error');
  assert.ok(Array.isArray(result.content), 'actual MCP content is retained');
  const receipt = nativeToolReceipt(result.content);
  if (result.structuredContent !== undefined) {
    const structured = object(result.structuredContent);
    assert.deepEqual(nativeToolReceipt(JSON.stringify(structured)), receipt,
      'native MCP text and structured receipt agree');
  }
  return receipt;
}

export function commandExit(output: unknown, codeMode: boolean, expected: 0 | 7): number {
  if (!codeMode) {
    assert.equal(typeof output, 'string');
    assert.match(String(output), new RegExp(`Process exited with code ${expected}(?:\\D|$)`));
    return expected;
  }
  const result = object(output);
  assert.equal('session_id' in result, false, 'no yielded/resumable command result');
  assert.equal(result.exit_code, expected); assert.equal(typeof result.output, 'string');
  assert.ok(typeof result.wall_time_seconds === 'number' &&
    Number.isFinite(result.wall_time_seconds) && result.wall_time_seconds >= 0);
  assert.ok(typeof result.chunk_id === 'string' && result.chunk_id.length > 0);
  return expected;
}

export function originalCallIds(input: readonly Row[]): string[] {
  const calls = input.filter(item => ['function_call', 'custom_tool_call'].includes(String(item.type)) &&
    typeof item.call_id === 'string' && /^native_CODEX_TEAM_ONE_[0-6]$/.test(item.call_id));
  const ids = calls.map(item => String(item.call_id));
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => `native_CODEX_TEAM_ONE_${i}`));
  for (const call of calls) linkedOutput(input, String(call.call_id), call.type === 'custom_tool_call');
  return ids;
}

/** Raw bounded TEST requests only; auth headers and ambient native configuration are never copied. */
export function retainUiRequest(directory: string, index: number, bytes: Buffer, route: string, lite?: string) {
  assert.match(directory, /\/TEST-desktop-backend-[^/]+$/);
  assert.equal(realpathSync(directory), directory); assert.ok(lstatSync(directory).isDirectory());
  assert.ok(Number.isSafeInteger(index) && index >= 1 && index <= 24);
  assert.ok(bytes.length < 2_000_000);
  const stem = `codex-native-request-${String(index).padStart(2, '0')}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let census: Row = { parsed: false };
  try {
    const body = object(JSON.parse(bytes.toString('utf8')));
    const input = Array.isArray(body.input) ? body.input.map(object) : [];
    const additional = input[0]?.type === 'additional_tools' ? input[0] : undefined;
    const palette = additional?.tools ?? body.tools;
    census = { parsed: true, model: body.model, reasoningEffort: object(body.reasoning ?? {}).effort,
      inputCount: input.length, input: input.slice(0, 256).map(item => ({
        type: item.type, role: item.role, callId: item.call_id,
      })), paletteSource: additional ? 'input[0].additional_tools' : 'body.tools',
      palette: (Array.isArray(palette) ? palette : []).slice(0, 128).map(raw => {
        const tool = object(raw);
        return { type: tool.type, name: tool.name,
          tools: Array.isArray(tool.tools) ? tool.tools.map(child => {
            const row = object(child); return { type: row.type, name: row.name, format: row.format };
          }) : undefined };
      }) };
  } catch { /* The original raw bytes survive even malformed JSON; the oracle rejects it afterward. */ }
  const fact = { index, bytes: bytes.length, sha256, route: route.split('?', 1)[0],
    hadQuery: route.includes('?'), lite: lite ?? null, census };
  writeFileSync(join(directory, `${stem}.json`), bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, `${stem}-census.json`), JSON.stringify(fact, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  return fact;
}
