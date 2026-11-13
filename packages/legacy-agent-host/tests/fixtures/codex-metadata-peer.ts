import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const loginCase = process.env.TEST_LOGIN;
const loginAccount = join(process.env.CODEX_HOME!, 'TEST-login-account.json');
let loginId: string | undefined;
const notifyLogin = (id: string | null, success = true) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'account/login/completed',
      params: { loginId: id, success, error: success ? null : 'TEST-PRIVATE-NATIVE-ERROR' },
    }) + '\n'
  );
const saveLogin = () => writeFileSync(loginAccount, 'true', { mode: 0o600 });
if (loginCase) {
  appendFileSync(
    join(process.env.HOME!, 'TEST-login-processes.ndjson'),
    JSON.stringify({ pid: process.pid }) + '\n',
    { mode: 0o600 }
  );
  setInterval(() => {
    if (!loginId || !existsSync(join(process.env.HOME!, 'TEST-complete-login'))) return;
    saveLogin();
    notifyLogin(loginId);
    loginId = undefined;
  }, 20).unref();
}
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
  if (message.method === 'initialize' && loginCase === 'cancel-before-login') return;
  if (message.method === 'initialize')
    result = {
      codexHome: process.env.TEST_WRONG_NAMESPACE ? '/TEST-foreign' : process.env.CODEX_HOME,
      platformFamily: 'unix',
      platformOs: process.platform,
    };
  else if (message.method === 'initialized') return;
  else if (loginCase && message.method === 'account/login/start') {
    loginId = 'TEST-native-login-' + process.pid;
    if (loginCase === 'overflow') {
      for (let index = 0; index < 9; index++) notifyLogin('TEST-foreign-' + index);
    } else {
      notifyLogin('TEST-foreign');
      notifyLogin(null);
      if (loginCase === 'rejected' ||
        (loginCase === 'rejected-then-pending' && !existsSync(join(process.env.HOME!, 'TEST-rejected-once')))) {
        writeFileSync(join(process.env.HOME!, 'TEST-rejected-once'), 'true', { mode: 0o600 });
        notifyLogin(loginId, false);
      }
      if (['early', 'wrong-account', 'reply-lost'].includes(loginCase)) {
        if (loginCase !== 'wrong-account') saveLogin();
        notifyLogin(loginId);
      }
    }
    if (loginCase === 'reply-lost') return;
    result =
      message.params?.type === 'chatgptDeviceCode'
        ? {
            type: 'chatgptDeviceCode',
            loginId,
            verificationUrl: 'https://example.invalid/device',
            userCode: 'TEST-PRIVATE-CODE',
          }
        : {
            type: 'chatgpt',
            loginId,
            authUrl: 'https://example.invalid/login?state=TEST-private-state',
          };
  } else if (loginCase && message.method === 'account/login/cancel') {
    if (message.params?.loginId !== loginId)
      throw new Error('Fixture cancel must keep original loginId');
    loginId = undefined;
    result = { status: 'canceled' };
  } else if (loginCase && message.method === 'account/logout') {
    writeFileSync(loginAccount, 'false', { mode: 0o600 });
    result = {};
  } else if (process.env.TEST_PROBE && message.method === 'thread/start')
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
      account:
        process.env.TEST_CHATGPT ||
        (existsSync(loginAccount) && readFileSync(loginAccount, 'utf8') === 'true')
          ? process.env.TEST_CODEX_0169
            ? { type: 'chatgpt', email: null, planType: 'sci_plus', workspaceName: 'TEST-private-workspace' }
            : { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' }
          : null,
      requiresOpenaiAuth: true,
      ...(process.env.TEST_CODEX_0169 ? { userId: 'TEST-private-user' } : {}),
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
