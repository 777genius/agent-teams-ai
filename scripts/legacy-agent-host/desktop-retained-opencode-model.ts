import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** A finite inference oracle. Only the genuine selected engines execute tools or write history. */
export async function startRetainedOpenCodeModel() {
  const observations: { owner: 'legacy' | 'host'; marker: string | null; tools: string[];
    strictLaunch?: { model: string; challenge: string } }[] = [];
  const failures: string[] = [];
  const markers = new Set<string>();
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'seal after the first model contract failure');
      const owner = request.url?.startsWith('/legacy/') ? 'legacy' :
        request.url?.startsWith('/host/') ? 'host' : null;
      assert.ok(owner, 'one selected owner-specific inference endpoint');
      if (request.method === 'GET' && request.url === `/${owner}/v1/models`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'TEST-model', object: 'model' }] }));
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `/${owner}/v1/chat/completions`);
      assert.ok(observations.length < 32, 'finite preflight plus business inference budget');
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array); size += chunk.length;
        assert.ok(size <= 2_000_000); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const messages = body.messages as { role: string; content: unknown }[];
      assert.ok(Array.isArray(messages));
      assert.equal(body.model, 'TEST-model');
      const ownPrefix = owner === 'legacy' ? 'TEST_RETAINED_V1_' : 'TEST_OWNED_V2_';
      const otherPrefix = owner === 'legacy' ? 'TEST_OWNED_V2_' : 'TEST_RETAINED_V1_';
      assert.equal(JSON.stringify(messages).includes(otherPrefix), false,
        'no business input or history crosses the original owner boundary');
      const lastUserContent = messages.findLast(message => message.role === 'user')?.content;
      const lastUser = JSON.stringify(lastUserContent);
      const marker = [...lastUser?.matchAll(/TEST_(?:RETAINED_V1|OWNED_V2)_(?:HISTORY|FIRST|AFTER_STOP)/g) ?? []].at(-1)?.[0] ?? null;
      if (marker) {
        assert.ok(marker.startsWith(ownPrefix));
        assert.equal(markers.has(marker), false, 'no repeated business inference'); markers.add(marker);
      } else assert.equal(owner, 'legacy', 'new Host receives no unrequested inference');
      const tools = Array.isArray(body.tools) ? body.tools.map(value => {
        const tool = value as { function?: { name?: unknown } };
        assert.equal(typeof tool.function?.name, 'string'); return tool.function!.name as string;
      }) : [];
      let strictLaunch: { model: string; challenge: string } | undefined;
      if (lastUser?.includes('STRICT_LAUNCH_')) {
        assert.equal(owner, 'legacy'); assert.equal(marker, null);
        assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0,
          'strict launch inference advertises no tools');
        const prompt = typeof lastUserContent === 'string' ? lastUserContent :
          Array.isArray(lastUserContent) && lastUserContent.length === 1 &&
          lastUserContent[0]?.type === 'text' ? lastUserContent[0].text : undefined;
        assert.equal(typeof prompt, 'string');
        const match = /^Output only this exact token: (STRICT_LAUNCH_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(prompt);
        assert.ok(match && match[0] === prompt, 'only the original exact native strict-launch request');
        strictLaunch = { model: body.model, challenge: match[1]! };
      }
      observations.push({ owner, marker, tools, ...(strictLaunch ? { strictLaunch } : {}) });
      const content = marker ? `REPLY_${marker}` : strictLaunch?.challenge ?? 'PONG';
      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']] as const)
          response.write(`data: ${JSON.stringify({ id: `TEST-${owner}-${observations.length}`,
            object: 'chat.completion.chunk', created: 1700000000, model: 'TEST-model',
            choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `TEST-${owner}-${observations.length}`, object: 'chat.completion',
          model: 'TEST-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      }
    })().catch(error => {
      failures.push(error instanceof Error ? error.message : 'model contract failure');
      if (!response.headersSent) response.writeHead(500); response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, observations, failures, markers,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      });
    },
  };
}
