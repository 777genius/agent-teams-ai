import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const SOURCE_SELECTION_MARKERS = [
  'TEST_SOURCE_INSTALL_B', 'TEST_SOURCE_PATH_A', 'TEST_SOURCE_LIVE_A', 'TEST_SOURCE_UPDATE_B',
] as const;
type SourceMarker = (typeof SOURCE_SELECTION_MARKERS)[number];

/** A finite inference oracle. Only the genuine selected engines execute tools or write history. */
export async function startRetainedOpenCodeModel(options: { sourceSelection?: true } = {}) {
  const observations: { owner: 'legacy' | 'host'; marker: string | null; tools: string[];
    strictLaunch?: { model: string; challenge: string }; sourcePreflight?: true;
    preparationCommandId?: 'TEST-coexist-launch-once' }[] = [];
  const failures: string[] = [];
  const markers = new Set<string>();
  let expectedSource: SourceMarker | undefined;
  let hostPreparation: { active: boolean; consumed: number } | undefined;
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
      const lastUserContent = messages.findLast(message => message.role === 'user')?.content;
      const lastUser = JSON.stringify(lastUserContent);
      let marker: string | null = null, tools: string[] = [];
      let strictLaunch: { model: string; challenge: string } | undefined;
      let sourcePreflight: true | undefined;
      let preparationCommandId: 'TEST-coexist-launch-once' | undefined;
      if (options.sourceSelection) {
        assert.equal(owner, 'host', 'source-selection inputs belong to the original Host');
        assert.equal(JSON.stringify(messages).includes('TEST_RETAINED_V1_'), false);
        assert.equal(JSON.stringify(messages).includes('TEST_OWNED_V2_'), false);
        const matches = [...lastUser?.matchAll(/TEST_SOURCE_(?:INSTALL_B|PATH_A|LIVE_A|UPDATE_B)/g) ?? []];
        assert.ok(matches.length <= 1, 'one original business marker');
        marker = matches[0]?.[0] ?? null;
        tools = Array.isArray(body.tools) ? body.tools.map(value => {
          const tool = value as { function?: { name?: unknown } };
          assert.equal(typeof tool.function?.name, 'string'); return tool.function!.name as string;
        }) : [];
        if (marker) {
          assert.equal(marker, expectedSource, 'one explicitly armed original UI input');
          assert.equal(markers.has(marker), false, 'no repeated business inference');
          const allowed = marker === 'TEST_SOURCE_LIVE_A'
            ? ['TEST_SOURCE_PATH_A', 'TEST_SOURCE_LIVE_A'] : [marker];
          for (const other of SOURCE_SELECTION_MARKERS)
            if (!allowed.includes(other)) assert.equal(JSON.stringify(messages).includes(other), false,
              'new captures never adopt another Team history');
          if (marker === 'TEST_SOURCE_LIVE_A') assert.ok(messages.slice(0, -1).some(message =>
            message.role === 'assistant' && JSON.stringify(message.content).includes('REPLY_TEST_SOURCE_PATH_A')),
          'the same original A session retains its actual first native reply');
          markers.add(marker); expectedSource = undefined;
        } else {
          assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0,
            'original model preflight advertises no tools');
          const prompt = typeof lastUserContent === 'string' ? lastUserContent :
            Array.isArray(lastUserContent) && lastUserContent.length === 1 &&
            lastUserContent[0]?.type === 'text' ? lastUserContent[0].text : undefined;
          assert.equal(prompt, 'Reply only OK. Do not use tools, access files or run commands.');
          assert.equal(messages.filter(message => message.role === 'user').length, 1);
          assert.ok(messages.every(message => message.role === 'user' || message.role === 'system'));
          sourcePreflight = true;
        }
      } else {
        const ownPrefix = owner === 'legacy' ? 'TEST_RETAINED_V1_' : 'TEST_OWNED_V2_';
        const otherPrefix = owner === 'legacy' ? 'TEST_OWNED_V2_' : 'TEST_RETAINED_V1_';
        assert.equal(JSON.stringify(messages).includes(otherPrefix), false,
          'no business input or history crosses the original owner boundary');
        marker = [...lastUser?.matchAll(/TEST_(?:RETAINED_V1|OWNED_V2)_(?:HISTORY|FIRST|AFTER_STOP)/g) ?? []].at(-1)?.[0] ?? null;
        if (marker) {
          assert.ok(owner !== 'host' || !hostPreparation?.active, 'Host business input cannot replace preparation');
          assert.ok(marker.startsWith(ownPrefix));
          assert.equal(markers.has(marker), false, 'no repeated business inference'); markers.add(marker);
        } else if (owner === 'host' && hostPreparation?.active) {
          assert.equal(hostPreparation.consumed, 0, 'one original Host preparation only');
          assert.equal(/TEST_(?:RETAINED_V1|OWNED_V2|SOURCE)_/.test(JSON.stringify(messages)), false,
            'business markers cannot be disguised as preparation');
          assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0,
            'original Host preparation advertises no tools');
          const prompt = typeof lastUserContent === 'string' ? lastUserContent :
            Array.isArray(lastUserContent) && lastUserContent.length === 1 &&
            lastUserContent[0]?.type === 'text' ? lastUserContent[0].text : undefined;
          assert.equal(prompt, 'Reply only OK. Do not use tools, access files or run commands.');
          assert.equal(messages.filter(message => message.role === 'user').length, 1);
          assert.ok(messages.every(message => message.role === 'user' || message.role === 'system'));
          hostPreparation.consumed = 1;
          // TEST window attribution only; the native request does not echo this command.
          preparationCommandId = 'TEST-coexist-launch-once';
        } else assert.equal(owner, 'legacy', 'new Host receives no unrequested inference');
        tools = Array.isArray(body.tools) ? body.tools.map(value => {
          const tool = value as { function?: { name?: unknown } };
          assert.equal(typeof tool.function?.name, 'string'); return tool.function!.name as string;
        }) : [];
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
      }
      observations.push({ owner, marker, tools, ...(strictLaunch ? { strictLaunch } : {}),
        ...(sourcePreflight ? { sourcePreflight } : {}), ...(preparationCommandId ? { preparationCommandId } : {}) });
      const content = marker ? `REPLY_${marker}` : sourcePreflight || preparationCommandId ? 'OK' : strictLaunch?.challenge ?? 'PONG';
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
    armHostPreparation(commandId: 'TEST-coexist-launch-once') {
      assert.equal(options.sourceSelection, undefined, 'initial preparation is unavailable in source-selection mode');
      assert.equal(commandId, 'TEST-coexist-launch-once');
      assert.equal(hostPreparation, undefined, 'the original preparation window cannot be rearmed');
      assert.equal(failures.length, 0);
      assert.equal(observations.some(row => row.preparationCommandId !== undefined), false);
      const original = { active: true, consumed: 0 };
      hostPreparation = original;
      return { get consumed() { return original.consumed; }, disarm() { original.active = false; } };
    },
    expectSourceInput(marker: SourceMarker) {
      assert.equal(options.sourceSelection, true); assert.equal(expectedSource, undefined);
      assert.equal(failures.length, 0); assert.equal(markers.has(marker), false);
      assert.ok(SOURCE_SELECTION_MARKERS.includes(marker)); expectedSource = marker;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      });
    },
  };
}
