import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const nativeOption = (key: string) => {
  const selected = process.argv.slice(2).find((arg) => arg.startsWith(key + '='));
  return selected === undefined
    ? undefined
    : (JSON.parse(selected.slice(key.length + 1)) as unknown);
};
if (process.env.TEST_PROBE)
  writeFileSync(join(process.env.HOME!, 'TEST-args.json'), JSON.stringify(process.argv.slice(2)), {
    mode: 0o600,
  });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line) as {
    id?: string;
    method: string;
    params?: Record<string, unknown>;
  };
  appendFileSync(
    join(process.env.HOME!, 'TEST-wire.ndjson'),
    JSON.stringify({ method: message.method, params: message.params }) + '\n',
    { mode: 0o600 }
  );
  let result: unknown;
  if (message.method === 'initialize')
    result = {
      codexHome: process.env.TEST_WRONG_NAMESPACE ? '/TEST-foreign' : process.env.CODEX_HOME,
      platformFamily: 'unix',
      platformOs: process.platform,
    };
  else if (message.method === 'initialized') return;
  else if (process.env.TEST_PROBE && message.method === 'thread/start')
    result = {
      thread: { id: 'TEST-thread' },
      model:
        process.env.TEST_PROBE === 'wrong-model' ? 'TEST-foreign-model' : message.params?.model,
      modelProvider: message.params?.modelProvider ?? 'TEST-local',
      cwd: message.params?.cwd,
      reasoningEffort:
        process.env.TEST_PROBE === 'wrong-effort'
          ? 'TEST-other'
          : (nativeOption('model_reasoning_effort') ?? null),
      serviceTier:
        process.env.TEST_PROBE === 'wrong-tier'
          ? 'TEST-other'
          : (nativeOption('service_tier') ?? null),
    };
  else if (process.env.TEST_PROBE && message.method === 'turn/start') {
    if (process.env.TEST_PROBE === 'reply-lost') process.exit(7);
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'TEST-turn' } } }) +
        '\n'
    );
    const send = (method: string, params: Record<string, unknown>) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    send('turn/started', { threadId: 'TEST-thread', turn: { id: 'TEST-turn' } });
    send('item/agentMessage/delta', {
      threadId: 'TEST-thread',
      turnId: 'TEST-turn',
      itemId: 'TEST-answer',
      delta: 'OK',
    });
    setTimeout(
      () =>
        send('turn/completed', {
          threadId: 'TEST-thread',
          turn: {
            id: 'TEST-turn',
            status: process.env.TEST_PROBE === 'model-failed' ? 'failed' : 'completed',
          },
        }),
      20
    );
    return;
  } else if (message.method === 'account/read')
    result = {
      account: process.env.TEST_CHATGPT
        ? { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' }
        : null,
      requiresOpenaiAuth: true,
    };
  else if (message.method === 'account/rateLimits/read')
    result = {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
        planType: 'plus',
      },
    };
  else if (message.method === 'config/read')
    result = { config: { model: 'TEST-model', model_provider: 'TEST-fixture' } };
  else if (message.method === 'model/list') result = { data: [], nextCursor: null };
  else throw new Error('Unexpected native method');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
lines.once('close', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
