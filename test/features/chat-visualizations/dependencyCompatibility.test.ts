import { agUIAdapter, processStreamedMessage } from '@openuidev/react-headless';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

afterEach(() => vi.unstubAllGlobals());

it('preserves AG-UI text and tool wire events through the installed headless consumer', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  type Message = Parameters<Parameters<typeof processStreamedMessage>[0]['createMessage']>[0];
  const messages = new Map<string, Message>();
  const publish = (message: Message) => {
    messages.set(message.id, message);
  };
  const markToolExecuting = vi.fn();
  const clearToolExecuting = vi.fn();
  const events = [
    { type: 'TEXT_MESSAGE_START', messageId: 'assistant', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'assistant', delta: 'Hello ' },
    { type: 'TEXT_MESSAGE_CHUNK', messageId: 'assistant', delta: 'world' },
    { type: 'TEXT_MESSAGE_END', messageId: 'assistant' },
    { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'lookup' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: '{"id":1}' },
    { type: 'TOOL_CALL_END', toolCallId: 'tool' },
    {
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'tool',
      messageId: 'result',
      role: 'tool',
      content: 'found',
    },
  ];
  const response = new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  );
  await processStreamedMessage({
    response,
    adapter: agUIAdapter(),
    createMessage: publish,
    updateMessage: publish,
    markToolExecuting,
    clearToolExecuting,
  });
  const assistant = [...messages.values()].find((message) => message.role === 'assistant');
  expect(assistant?.content).toBe('Hello world');
  expect(assistant?.toolCalls).toMatchObject([
    { id: 'tool', function: { name: 'lookup', arguments: '{"id":1}' } },
  ]);
  expect([...messages.values()]).toContainEqual(
    expect.objectContaining({ role: 'tool', content: 'found', toolCallId: 'tool' })
  );
  expect(markToolExecuting).toHaveBeenCalledWith('tool');
  expect(clearToolExecuting).toHaveBeenCalledWith('tool');
});

it('rejects oversized constrained Zod collections before parsing their elements', async () => {
  let parsed = 0;
  const element = z.number().transform((value) => {
    parsed++;
    return value;
  });
  const cases = [
    [z.array(element).max(1), [1, 2]],
    [z.array(element).length(1), [1, 2]],
    [z.set(element).max(1), new Set([1, 2])],
    [
      z.map(element, element).max(1),
      new Map([
        [1, 1],
        [2, 2],
      ]),
    ],
  ] as const;
  for (const [schema, input] of cases) {
    expect(schema.safeParse(input).error?.issues).toMatchObject([{ code: 'too_big' }]);
    expect((await schema.safeParseAsync(input)).error?.issues).toMatchObject([{ code: 'too_big' }]);
  }
  expect(parsed).toBe(0);
  expect(z.array(element).max(1).parse([1])).toEqual([1]);
  expect(parsed).toBe(1);
});
