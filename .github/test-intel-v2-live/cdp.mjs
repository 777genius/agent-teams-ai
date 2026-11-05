// TEST-only CDP helpers for the Linux V2 CI run.
// Usage: node cdp.mjs wait [port]           waits for the renderer preload API
//        node cdp.mjs connect <projectDir> [port]   connects the Kimi provider; the key
//        comes only from KIMI_TEST_API_KEY and is never printed (all output is redacted).
//        node cdp.mjs eval '<expr>' [port]
const [, , mode, arg, portArg] = process.argv;
const port = (mode === 'wait' ? arg : portArg) || '9222';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+|index\.html/.test(t.url));
  if (!page) throw new Error('no renderer page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const evaluate = (expression) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: {
      expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true, returnByValue: true, timeout: 900000 } }));
  });
  return { ws, evaluate };
}

if (mode === 'wait') {
  const deadline = Date.now() + 10 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const { ws, evaluate } = await openPage();
      // The preload exists before main registers its IPC handlers; wait for a real round trip.
      const res = await evaluate('window.electronAPI.openCodeRuntime.getStatus().then((s) => Boolean(s && s.state))');
      ws.close();
      if (res.result?.result?.value === 'true') { console.log('main IPC ready'); process.exit(0); }
      last = JSON.stringify(res.result ?? res).slice(0, 300);
    } catch (error) { last = String(error).slice(0, 300); }
    await sleep(3000);
  }
  console.error(`renderer not ready: ${last}`);
  process.exit(1);
} else if (mode === 'connect') {
  const key = process.env.KIMI_TEST_API_KEY ?? '';
  delete process.env.KIMI_TEST_API_KEY;
  if (!key.trim()) { console.log(JSON.stringify({ error: 'KIMI_TEST_API_KEY is empty' })); process.exit(1); }
  const redact = (text) => text.split(key).join('[REDACTED]');
  const input = { runtimeId: 'opencode', providerId: process.env.KIMI_PROVIDER_ID || 'kimi-code-plan-cn', method: 'api',
    apiKey: key, metadata: {}, authOptionId: 'api:native', projectPath: arg };
  const { ws, evaluate } = await openPage();
  const startedAt = new Date().toISOString();
  const res = await evaluate(`window.electronAPI.runtimeProviderManagement.connectProvider(${JSON.stringify(input)})`);
  ws.close();
  if (res.result?.exceptionDetails) {
    console.log(redact(JSON.stringify({ startedAt, error: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text })));
    process.exit(1);
  }
  const value = res.result?.result?.value ?? JSON.stringify(res);
  let parsed; try { parsed = JSON.parse(value); } catch { parsed = value; }
  console.log(redact(JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), result: parsed }, null, 2)));
  const connected = parsed && typeof parsed === 'object' && !parsed.error && /"state":"connected"/.test(value);
  process.exit(connected ? 0 : 1);
} else if (mode === 'eval') {
  const { ws, evaluate } = await openPage();
  const res = await evaluate(arg);
  ws.close();
  if (res.result?.exceptionDetails) { console.error(JSON.stringify(res.result.exceptionDetails).slice(0, 2000)); process.exit(1); }
  console.log(res.result?.result?.value);
} else {
  console.error('unknown mode');
  process.exit(2);
}
