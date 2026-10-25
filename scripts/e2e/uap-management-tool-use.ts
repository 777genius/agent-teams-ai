// Scripted loopback provider, real pinned OpenCode and MCP dispatch; no model credentials.
// Protocol fixture follows UAP's agentplugins_opencode_collision_native_test.go.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const serverName = 'desktop_probe';
const toolName = `${serverName}_inspect_runtime`;
export const toolPluginName = 'uap-desktop-tool-proof';
export const toolArchivePath = '/desktop-tool-proof.tar.gz';

export async function createNativeToolProof(root: string, native: string, env: NodeJS.ProcessEnv) {
  const version = (await run(native, ['--version'], { env, timeout: 30_000 })).stdout.trim();
  assert.equal(version, '1.18.34', 'Native protocol proof requires the reviewed OpenCode pin');
  const nonce = randomUUID();
  const marker = `native-dispatch:${serverName}:${nonce}`;
  const newStage = () => ({
    status: 'running',
    methods: [] as string[],
    mcpRequests: 0,
    calls: [] as unknown[],
    offered: [] as string[],
    providerRequests: [] as { tools: string[]; toolResults: unknown[] }[],
    returnedToolResult: false,
    errors: [] as string[],
  });
  let stage = newStage();
  const evidence = {
    model: 'scripted_loopback_no_real_model',
    oauth: 'not_evaluated',
    version,
    nativeSHA256: createHash('sha256')
      .update(await readFile(native))
      .digest('hex'),
    nonce,
    stages: {} as Record<string, ReturnType<typeof newStage>>,
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.url === '/mcp') stage.mcpRequests++;
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        assert(size <= 4 * 1024 * 1024, 'Bounded disposable protocol request');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/mcp') {
        stage.methods.push(body.method);
        if (body.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (body.method === 'initialize') {
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: '1.0.0' },
          };
        } else if (body.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'inspect_runtime',
                description: 'Return disposable test identity',
                inputSchema: {
                  type: 'object',
                  properties: { nonce: { type: 'string' } },
                  required: ['nonce'],
                },
              },
            ],
          };
        } else if (body.method === 'tools/call') {
          assert.equal(body.params?.name, 'inspect_runtime');
          assert.deepEqual(body.params?.arguments, { nonce });
          stage.calls.push(body.params);
          result = { content: [{ type: 'text', text: marker }] };
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      const names: string[] = (body.tools ?? [])
        .map((tool: { function: { name: string } }) => tool.function.name)
        .filter((name: string) => name.startsWith(`${serverName}_`));
      const results: unknown[] = (body.messages ?? [])
        .filter((message: { role: string }) => message.role === 'tool')
        .map((message: { content: unknown }) => message.content);
      stage.providerRequests.push({ tools: names, toolResults: results });
      assert(stage.providerRequests.length <= 12, 'Unexpected native provider loop');
      stage.offered = [...new Set([...stage.offered, ...names])];
      const done =
        stage.calls.length === 1 && results.some((value) => JSON.stringify(value).includes(marker));
      stage.returnedToolResult ||= done;
      response.setHeader('Content-Type', 'text/event-stream');
      const emit = (delta: unknown, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'uap-scripted',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        );
      if (!done && names.length === 1) {
        emit(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'uap-call',
                type: 'function',
                function: { name: names[0], arguments: JSON.stringify({ nonce }) },
              },
            ],
          },
          null
        );
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: 'Disposable scripted provider complete.' }, null);
        emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      stage.errors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end('Disposable protocol fixture failed');
    });
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const project = path.join(root, 'native-tool-project');
    const packageRoot = path.join(root, 'native-tool-package');
    await Promise.all([project, packageRoot].map((dir) => mkdir(dir, { recursive: true })));
    const config = path.join(env.OPENCODE_CONFIG_DIR!, 'opencode.json');
    // Only the model transport is seeded. MCP configuration is written exclusively by UAP.
    await writeFile(
      config,
      JSON.stringify({
        provider: {
          'uap-fixture': {
            name: 'Disposable fixture',
            npm: '@ai-sdk/openai-compatible',
            env: [],
            models: {
              fixture: {
                name: 'Fixture',
                tool_call: true,
                limit: { context: 32000, output: 1024 },
              },
            },
            options: { apiKey: 'disposable-not-a-secret', baseURL: `${origin}/v1` },
          },
        },
        model: 'uap-fixture/fixture',
        small_model: 'uap-fixture/fixture',
        permission: 'allow',
      }),
      { flag: 'wx' }
    );
    await writeFile(
      path.join(packageRoot, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: toolPluginName,
        version: '1.0.0',
        description: 'Disposable native MCP dispatch proof',
      })
    );
    await writeFile(
      path.join(packageRoot, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { [serverName]: { type: 'streamable-http', url: `${origin}/mcp` } },
      })
    );
    const archiveFile = path.join(root, 'desktop-tool-proof.tar.gz');
    await run('tar', ['-czf', archiveFile, '-C', packageRoot, 'plugin.json', 'mcp.json']);
    const archive = await readFile(archiveFile);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    return {
      archive,
      sha256,
      config,
      mcpURL: `${origin}/mcp`,
      serverName,
      evidence,
      close,
      async probe(removed: boolean) {
        stage = newStage();
        const label = removed ? 'removed' : 'installed';
        evidence.stages[label] = stage;
        try {
          const execution = run(
            native,
            [
              'run',
              '--model',
              'uap-fixture/fixture',
              '--format',
              'json',
              'Call the fixture inspect_runtime tool once if available, then finish.',
            ],
            {
              cwd: project,
              env,
              timeout: 90_000,
              maxBuffer: 4 * 1024 * 1024,
              killSignal: 'SIGKILL',
            }
          );
          // OpenCode reads non-TTY input even when the prompt is passed in argv.
          // This owned non-interactive child has no input; deliver EOF before awaiting exit.
          execution.child.stdin?.end();
          const output = await execution;
          await writeFile(
            path.join(root, `desktop-native-${label}.log`),
            output.stdout + output.stderr
          );
          assert.deepEqual(stage.errors, []);
          assert(
            stage.providerRequests.length > 0,
            'Real native session must contact the controlled provider'
          );
          if (removed) {
            assert.deepEqual(stage.offered, []);
            assert.deepEqual(stage.calls, []);
            assert.equal(stage.mcpRequests, 0, 'Removed plugin must cause no MCP connection');
          } else {
            assert.deepEqual(stage.offered, [toolName]);
            assert.equal(stage.calls.length, 1);
            assert(
              stage.returnedToolResult,
              'Native tool result must return to the provider with the exact nonce'
            );
            for (const method of ['initialize', 'tools/list', 'tools/call']) {
              assert(stage.methods.includes(method), `Missing native MCP ${method}`);
            }
          }
          stage.status = 'passed';
        } catch (error) {
          stage.status = 'failed';
          const output = error as { stdout?: string; stderr?: string };
          stage.errors.push(String(error));
          await writeFile(
            path.join(root, `desktop-native-${label}.log`),
            `\n${String(error)}\n${output.stdout ?? ''}${output.stderr ?? ''}`,
            { flag: 'a' }
          );
          throw error;
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
