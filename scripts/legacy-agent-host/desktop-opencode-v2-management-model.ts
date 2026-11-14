import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const desktopV2SelectedKey = 'TEST-desktop-v2-selected-key-never-a-real-secret';
export const desktopV2RejectedKey = 'TEST-desktop-v2-rejected-key-never-a-real-secret';
export const desktopV2ProviderId = 'test-local';
const expected = [
  { step: 'reject-key', model: 'TEST-model', key: desktopV2RejectedKey, outcome: 'refused' },
  { step: 'connect-key', model: 'TEST-model', key: desktopV2SelectedKey, outcome: 'OK' },
  { step: 'global-default', model: 'TEST-model', key: desktopV2SelectedKey, outcome: 'OK' },
  { step: 'project-default', model: 'TEST-project-model', key: desktopV2SelectedKey, outcome: 'OK' },
  { step: 'project-test', model: 'TEST-project-model', key: desktopV2SelectedKey, outcome: 'OK' },
] as const;
export type DesktopV2ManagementStep = typeof expected[number]['step'];

/** Five original UI intents reach the actual V2 engine; passive reads cannot consume a model request. */
export async function startDesktopV2ManagementModel() {
  const requests: { step: DesktopV2ManagementStep; model: string; tools: number;
    authorizationMatched: boolean; promptMatched: boolean; outcome: string }[] = [];
  const failures: string[] = [];
  let completed = 0, active: typeof expected[number] | undefined;
  let observeProbe: ((step: DesktopV2ManagementStep) => Promise<void>) | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0);
      const intent = active;
      assert.ok(intent && observeProbe && requests.length === completed, 'one original finite model intent');
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
        assert.ok(length <= 1024 * 1024); chunks.push(bytes);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.model, intent.model); assert.equal(body.reasoning_effort, undefined);
      assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0);
      assert.equal(request.headers.authorization, 'Bearer ' + intent.key);
      const promptMatched = JSON.stringify(body.messages).includes('Reply only OK. Do not use tools, access files or run commands.');
      assert.equal(promptMatched, true);
      for (const secret of [desktopV2SelectedKey, desktopV2RejectedKey, 'agentTeamsCredential', 'credentialId', 'scopeDigest'])
        assert.equal(text.includes(secret), false, 'private credential evidence never enters model context');
      await observeProbe(intent.step);
      assert.equal(active, intent, 'the original UI intent remains selected while its native process is observed');
      requests.push({ step: intent.step, model: intent.model, tools: 0,
        authorizationMatched: true, promptMatched, outcome: intent.outcome });
      if (intent.outcome === 'refused') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'TEST controlled model refusal',
          type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      const event = (delta: Record<string, unknown>, finish: string | null) => ({
        id: 'TEST-desktop-v2-management-reply', object: 'chat.completion.chunk', created: 1700000000,
        model: intent.model, choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('TEST_desktop_v2_management_request_refused');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST Desktop model refused request');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`, requests, failures,
    setProbeObserver(observer: (step: DesktopV2ManagementStep) => Promise<void>) {
      assert.equal(observeProbe, undefined); observeProbe = observer;
    },
    begin(step: DesktopV2ManagementStep) {
      assert.deepEqual(failures, []); assert.equal(active, undefined);
      assert.equal(requests.length, completed); assert.equal(expected[completed]?.step, step);
      active = expected[completed];
    },
    finish(step: DesktopV2ManagementStep) {
      assert.deepEqual(failures, []); assert.equal(active?.step, step);
      assert.equal(requests.length, completed + 1); assert.equal(requests.at(-1)!.step, step);
      completed++; active = undefined;
    },
    assertPassive(count: number) {
      assert.deepEqual(failures, []); assert.equal(active, undefined);
      assert.equal(requests.length, count); assert.equal(completed, count);
    },
    assertComplete() { this.assertPassive(expected.length); },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
export type DesktopV2ManagementModel = Awaited<ReturnType<typeof startDesktopV2ManagementModel>>;
