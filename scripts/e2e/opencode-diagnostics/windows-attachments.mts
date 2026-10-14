// Coordinator-owned, zero paid inference. The loopback responder never reads a saved file.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp, waitFor } from '../release-updater/cdp.mts';
import type {
  AttachmentPayload,
  InboxMessage,
  TeamCreateRequest,
  TeamAgentRuntimeSnapshot,
} from '../../../src/shared/types/team.ts';

const MODEL = 'openrouter/openai/gpt-5.4-mini';
const NATIVE_SHA = 'bb731f311416df16691fa16763eb87657c4a5f5f3bcff5202718c416e8f7ab1a';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const harness = path.join(repo, 'scripts/e2e/opencode-diagnostics-desktop.mjs');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
interface Identity {
  pid: number;
  birth: string;
  parent?: number;
}
interface Manifest {
  packaged: boolean;
  root: string;
  home: string;
  project: string;
  userData: string;
  launcher?: Identity;
  artifact: {
    renderer: string;
    orchestrator: { path: string; sha256: string };
    candidate: Record<string, unknown>;
  };
}
interface Host {
  hostKey: string;
  profileRootKey: string;
  projectPath: string;
  baseUrl: string;
  pid: number;
  port: number;
  version: string;
}
interface Session {
  teamId: string;
  memberName: string;
  projectPath: string;
  selectedModel: string;
  hostKey: string;
  profileRootKey: string;
  opencodeSessionId: string;
}
interface Tool {
  function: { name: string; parameters?: unknown };
}
interface ModelMessage {
  role: string;
  tool_call_id?: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface ModelRequest {
  stream?: boolean;
  model: string;
  messages: ModelMessage[];
  tools?: Tool[];
}
interface ReadObservation {
  nonce: string;
  callId: string;
  result: string;
  savedPath: string;
  imageSha256: string;
  originalMessageId: string;
}
const textContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('\n');
  return '';
};

// No expected nonce or saved bytes are passed here. Only real incoming tool results can supply it.
function loopbackResponder(releaseRead: Promise<void>) {
  const requests: Array<Record<string, unknown>> = [];
  let readObservation: ReadObservation | undefined;
  let failure: Error | undefined;
  let imageSha256 = '';
  let savedPath = '';
  let originalMessageId = '';
  let issuedRead = false;
  const emit = (
    res: ServerResponse,
    body: ModelRequest,
    content: string | null,
    call?: { id: string; name: string; input: unknown }
  ) => {
    const message = {
      role: 'assistant',
      content,
      ...(call
        ? {
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : {}),
    };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'TEST-completion',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = {
      role: 'assistant',
      ...(content === null ? {} : { content }),
      ...(call ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : {}),
    };
    for (const [value, finish] of [
      [delta, null],
      [{}, call ? 'tool_calls' : 'stop'],
    ] as const)
      res.write(
        `data: ${JSON.stringify({ id: 'TEST-completion', object: 'chat.completion.chunk', model: body.model, created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`
      );
    res.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    try {
      assert(request.socket.remoteAddress === '127.0.0.1', 'Only local native model requests');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ object: 'list', data: [{ id: 'openai/gpt-5.4-mini', object: 'model' }] })
        );
        return;
      }
      assert(
        request.method === 'POST' && request.url === '/v1/chat/completions',
        'Unexpected model route'
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        assert(size <= 8 * 1024 * 1024);
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest;
      assert(body.model === 'openai/gpt-5.4-mini' && Array.isArray(body.messages));
      const text = body.messages.map((message) => textContent(message.content)).join('\n');
      const arrays = text.match(/\[\{[^\r\n]+\}\]/g) ?? [];
      const descriptors = arrays.flatMap((array) => {
        try {
          return JSON.parse(array) as Array<{ path?: string; sha256?: string }>;
        } catch {
          return [];
        }
      });
      const descriptor = descriptors.find(
        (item) => typeof item.path === 'string' && typeof item.sha256 === 'string'
      );
      if (!descriptor) {
        emit(response, body, /PONG/i.test(text) ? 'PONG' : 'READY');
        return;
      }
      assert(typeof descriptor.path === 'string');
      if (!savedPath) {
        savedPath = descriptor.path;
        originalMessageId = text.match(/^Original User MessageId: ([a-f0-9-]+)$/m)?.[1] ?? '';
        assert(
          originalMessageId && !/NONCE [a-f0-9]{32}/.test(text),
          'Nonce leaked before native read'
        );
      }
      assert(descriptor.path === savedPath);
      for (const message of body.messages)
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (!part || typeof part !== 'object' || !('image_url' in part)) continue;
            const url = part.image_url as { url?: string };
            const match = url.url?.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
            if (match) imageSha256 = hash(Buffer.from(match[1]!, 'base64'));
          }
        }
      const result = body.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'TEST-saved-read'
      );
      const resultText = textContent(result?.content);
      const nonce = resultText.match(/NONCE ([a-f0-9]{32})/)?.[1];
      requests.push({
        model: body.model,
        originalMessageId,
        savedPath,
        imageSha256,
        toolResultSeen: !!result,
        nativeNonceSeen: !!nonce,
      });
      if (!issuedRead) {
        assert(imageSha256, 'Native image absent from actual model request');
        const readTool = body.tools?.find((tool) => tool.function.name === 'read');
        assert(readTool, 'Native Read tool not offered');
        await releaseRead;
        issuedRead = true;
        emit(response, body, null, {
          id: 'TEST-saved-read',
          name: readTool.function.name,
          input: { filePath: savedPath },
        });
        return;
      }
      assert(nonce && result, 'Actual native Read result did not contain nonce');
      readObservation = {
        nonce,
        result: resultText,
        callId: result.tool_call_id!,
        savedPath,
        imageSha256,
        originalMessageId,
      };
      const relayResult = body.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'TEST-user-relay'
      );
      if (relayResult) {
        assert(
          /deliveredToInbox/.test(textContent(relayResult.content)),
          'MCP user relay did not persist'
        );
        emit(response, body, 'DONE');
        return;
      }
      const relay = body.tools?.find((tool) => /message_send$/.test(tool.function.name));
      assert(relay, 'Actual Agent Teams message_send not offered');
      emit(response, body, null, {
        id: 'TEST-user-relay',
        name: relay.function.name,
        input: {
          teamName: text.match(/teamName="([^"]+)"/)?.[1],
          to: 'user',
          from: 'worker',
          text: JSON.stringify({ NONCE: nonce, image_sha256: imageSha256 }),
          summary: 'TEST saved-copy and native image observed',
          source: 'runtime_delivery',
          relayOfMessageId: originalMessageId,
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error('loopback_request_failed');
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'TEST responder contract failed' } }));
    }
  });
  return { server, requests, observation: () => readObservation, failure: () => failure };
}

const command = (mode: string, args: string[], timeout = 120000) => {
  const result = spawnSync(process.execPath, [harness, mode, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Owned packaged ${mode} failed`);
  return result.stdout.trim();
};
async function main() {
  assert(process.platform === 'win32' && process.arch === 'x64');
  const [executable, candidateFile, ...extra] = process.argv.slice(2);
  assert(executable && candidateFile && extra.length === 0);
  const root = command('seed-packaged', [
    '--packaged-executable',
    executable,
    '--runtime-setup',
    'app-install',
    '--candidate-evidence',
    candidateFile,
  ]);
  const data = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  assert(data.packaged === true && data.artifact.candidate?.testOnly === true);
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    passed: false,
    root,
    model: MODEL,
    compiledRuntime: data.artifact.orchestrator,
    candidate: data.artifact.candidate,
    cleanup: { passed: false },
  };
  const persist = () =>
    writeFile(path.join(root, 'windows-attachments.json'), JSON.stringify(receipt, null, 2));
  await persist();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = loopbackResponder(gate);
  await new Promise<void>((resolve) => model.server.listen(0, '127.0.0.1', resolve));
  const address = model.server.address();
  assert(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const config = {
    provider: {
      openrouter: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL, apiKey: 'TEST-loopback-only' },
        models: {
          'openai/gpt-5.4-mini': {
            name: 'TEST native image model',
            attachment: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    },
    model: MODEL,
    small_model: MODEL,
    enabled_providers: ['openrouter'],
  };
  await writeFile(path.join(data.project, 'opencode.json'), JSON.stringify(config));
  receipt.configSha256 = hash(Buffer.from(JSON.stringify(config)));
  receipt.modelEndpoint = baseURL;
  const team = `test-win-attachments-${randomBytes(6).toString('hex')}`;
  const member = 'worker';
  const teamDir = path.join(data.home, '.claude/teams', team);
  const launcher = spawn(process.execPath, [harness, 'start', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp: Cdp | undefined;
  let primaryFailure: unknown;
  let teamAttempted = false;
  const check = () => {
    const failure = model.failure();
    if (failure) throw failure;
  };
  try {
    await waitFor(
      async () => {
        try {
          command('inspect', [root], 30000);
          return true;
        } catch {
          return false;
        }
      },
      'owned packaged renderer',
      120000
    );
    const targets = (await fetch('http://127.0.0.1:9222/json/list').then((response) =>
      response.json()
    )) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const packaged = (await import(
      pathToFileURL(path.join(repo, 'scripts/e2e/opencode-diagnostics/packaged.mjs')).href
    )) as {
      packagedTarget(
        targets: unknown,
        renderer: string,
        owned: boolean,
        paths: typeof path.win32
      ): { webSocketDebuggerUrl: string };
    };
    const target = packaged.packagedTarget(targets, data.artifact.renderer, true, path.win32);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const evaluate = async <T,>(expression: string): Promise<T> => {
      command('inspect', [root], 30000);
      return cdp!.evaluate<T>(expression);
    };
    const begin = async (expression: string) => {
      const key = `__TEST_${randomUUID().replace(/-/g, '')}`;
      await evaluate(
        `(() => { window[${literal(key)}] = {done:false}; Promise.resolve(${expression}).then(value => {window[${literal(key)}] = {done:true,value};}, error => {window[${literal(key)}] = {done:true,error:String(error)};}); return true; })()`
      );
      return key;
    };
    const finish = async <T,>(key: string, label: string): Promise<T> => {
      const result = await waitFor(
        async () => {
          check();
          const state = await evaluate<{ done: boolean; value?: T; error?: string }>(
            `window[${literal(key)}]`
          );
          return state.done ? state : null;
        },
        label,
        180000
      );
      assert(!result.error, `${label} IPC failed`);
      return result.value!;
    };
    const api = async <T,>(expression: string, label: string) =>
      finish<T>(await begin(expression), label);
    await api('window.electronAPI.openCodeRuntime.install()', 'app managed native install');
    const native = await api<{ installed: boolean; version: string; binaryPath: string }>(
      'window.electronAPI.openCodeRuntime.getStatus()',
      'native identity'
    );
    assert(native.installed && native.version === '1.19.0');
    assert((await realpath(native.binaryPath)).startsWith(await realpath(data.userData)));
    assert.equal(hash(await readFile(native.binaryPath)), NATIVE_SHA);
    receipt.native = { version: native.version, path: native.binaryPath, sha256: NATIVE_SHA };
    const request: TeamCreateRequest = {
      teamName: team,
      cwd: data.project,
      providerId: 'opencode',
      model: MODEL,
      syncModelsWithLead: true,
      prompt:
        'TEST-only: reply READY and wait. Do not create tasks or inspect files before a user message.',
      members: [
        { name: member, providerId: 'opencode', model: MODEL, role: 'TEST attachment observer' },
      ],
    };
    teamAttempted = true;
    receipt.phase = 'launch';
    receipt.launch = await api(
      `window.electronAPI.teams.createTeam(${literal(request)})`,
      'compiled legacy team launch'
    );
    const runtime = await waitFor(
      async () => {
        check();
        const snapshot = await api<TeamAgentRuntimeSnapshot>(
          `window.electronAPI.teams.getTeamAgentRuntime(${literal(team)})`,
          'actual runtime actor'
        );
        return snapshot.members[member]?.alive ? snapshot : null;
      },
      'live native OpenCode worker',
      180000
    );
    receipt.runtimeActor = runtime.members[member];
    const binaryBytes = Buffer.from(
      `TEST arbitrary reference\nNONCE ${randomBytes(16).toString('hex')}\n`
    );
    const expectedNonce = binaryBytes.toString('utf8').match(/NONCE ([a-f0-9]{32})/)![1];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPfoAAAAASUVORK5CYII=',
      'base64'
    );
    const source = path.join(root, 'original.unknown');
    await writeFile(source, binaryBytes);
    const payloads: AttachmentPayload[] = [
      {
        id: 'native-image',
        filename: 'native.png',
        mimeType: 'image/png',
        size: png.length,
        data: png.toString('base64'),
      },
      {
        id: 'arbitrary-file',
        filename: 'original.unknown',
        mimeType: 'application/octet-stream',
        size: binaryBytes.length,
        data: binaryBytes.toString('base64'),
      },
    ];
    const messageId = randomUUID();
    receipt.phase = 'attachment_admission';
    const sentKey = await begin(
      `window.electronAPI.teams.sendMessage(${literal(team)}, ${literal({ member, messageId, text: 'Read the saved arbitrary file with the native Read tool, then reply to user via message_send with the NONCE and image SHA. Do not execute or extract either attachment.', attachments: payloads })})`
    );
    const inboxPath = path.join(teamDir, 'inboxes', `${member}.json`);
    const original = await waitFor(
      async () => {
        check();
        const rows = JSON.parse(
          await readFile(inboxPath, 'utf8').catch(() => '[]')
        ) as InboxMessage[];
        return (
          rows.find(
            (row) =>
              row.messageId === messageId && row.fileReferences?.length && row.attachments?.length
          ) ?? null
        );
      },
      'actual app-owned saved metadata',
      120000
    );
    const reference = original.fileReferences![0]!;
    const image = original.attachments![0]!;
    assert(
      reference.id === 'arbitrary-file' &&
        image.id === 'native-image' &&
        reference.filePath &&
        image.filePath
    );
    const savedBytes = await readFile(reference.filePath),
      savedImage = await readFile(image.filePath);
    assert(savedBytes.equals(binaryBytes) && savedImage.equals(png));
    assert.equal(hash(savedBytes), reference.sha256);
    assert.equal(hash(savedImage), image.sha256);
    assert(reference.filePath.startsWith(path.join(data.userData, 'data/attachments')));
    await writeFile(source, 'changed original');
    await rm(source);
    receipt.savedCopy = { reference, image, originalRemovedBeforeRead: true };
    receipt.phase = 'native_read_and_reply';
    release();
    receipt.send = await finish(sentKey, 'actual native attachment dispatch');
    await waitFor(
      async () => {
        check();
        const observation = model.observation();
        const userRows = JSON.parse(
          await readFile(path.join(teamDir, 'inboxes/user.json'), 'utf8').catch(() => '[]')
        ) as InboxMessage[];
        const reply = userRows.find(
          (row) =>
            row.from === member &&
            row.to === 'user' &&
            row.relayOfMessageId === messageId &&
            row.source === 'runtime_delivery'
        );
        if (!observation || !reply) return null;
        assert.equal(observation.nonce, expectedNonce);
        assert.equal(observation.savedPath, reference.filePath);
        assert.equal(observation.imageSha256, hash(savedImage));
        assert.equal(observation.originalMessageId, messageId);
        const parsed = JSON.parse(reply.text) as { NONCE: string; image_sha256: string };
        assert.equal(parsed.NONCE, observation.nonce);
        assert.equal(parsed.image_sha256, observation.imageSha256);
        receipt.nativeRead = observation;
        receipt.persistedReply = reply;
        return true;
      },
      'native read result and persisted correlated reply',
      180000
    );
    receipt.phase = 'effective_native_agent';
    const registry = path.join(data.home, 'AppData/Local/claude-multimodel-nodejs/Data/opencode');
    const sessions = JSON.parse(
      await readFile(path.join(registry, 'session-store.json'), 'utf8')
    ) as { records: Record<string, Session> };
    const session = Object.values(sessions.records).find(
      (row) => row.teamId === team && row.memberName === member && row.projectPath === data.project
    );
    assert(session && session.selectedModel === MODEL);
    const hosts = JSON.parse(await readFile(path.join(registry, 'host-registry.json'), 'utf8')) as {
      hosts: Record<string, Host>;
    };
    const host = hosts.hosts[session.hostKey];
    assert(
      host &&
        host.version === '1.19.0' &&
        host.profileRootKey === session.profileRootKey &&
        host.projectPath === data.project
    );
    const url = new URL(host.baseUrl);
    assert(url.hostname === '127.0.0.1' && Number(url.port) === host.port);
    const platform = (await import(
      pathToFileURL(path.join(repo, 'scripts/e2e/opencode-diagnostics/platform.mjs')).href
    )) as {
      processes(): Identity[];
      ownedTree(snapshot: Identity[], launcher: Identity): Identity[];
      sameIdentity(expected: Identity, current: Identity | undefined): void;
    };
    const currentManifest = JSON.parse(
      await readFile(path.join(root, 'manifest.json'), 'utf8')
    ) as Manifest;
    assert(currentManifest.launcher);
    const owned = platform.ownedTree(platform.processes(), currentManifest.launcher);
    const hostIdentity = owned.find((row) => row.pid === host.pid);
    assert(hostIdentity, 'Native host must belong to the owned packaged app');
    let messages = (await fetch(new URL(`/session/${session.opencodeSessionId}/message`, url)).then(
      (response) => {
        assert(response.ok);
        return response.json();
      }
    )) as Array<{
      info: { role: string; agent: string; sessionID: string; finish?: string };
      parts: Array<{
        type: string;
        text?: string;
        tool?: string;
        state?: { status: string; input: { filePath?: string }; output?: string };
      }>;
    }>;
    const actualRead = messages.find(
      (message) =>
        message.info.role === 'assistant' &&
        message.info.sessionID === session.opencodeSessionId &&
        message.parts.some(
          (part) =>
            part.type === 'tool' &&
            part.tool === 'read' &&
            part.state?.status === 'completed' &&
            part.state.input.filePath === reference.filePath &&
            part.state.output?.includes(expectedNonce)
        )
    );
    assert(actualRead, 'Actual selected native session must retain completed saved-path Read');
    platform.sameIdentity(
      hostIdentity,
      platform.processes().find((row) => row.pid === host.pid)
    );
    const agents = (await fetch(new URL('/agent', url)).then((response) => {
      assert(response.ok);
      return response.json();
    })) as Array<{
      name: string;
      permission: Array<{ permission: string; pattern: string; action: string }>;
    }>;
    const agent = agents.find((entry) => entry.name === actualRead.info.agent);
    assert(agent && Array.isArray(agent.permission));
    receipt.nativeSession = {
      sessionId: session.opencodeSessionId,
      selectedModel: session.selectedModel,
      hostKey: host.hostKey,
      profileRootKey: host.profileRootKey,
      hostIdentity,
      read: actualRead,
      effectiveAgent: {
        name: agent.name,
        permission: agent.permission.filter((rule) =>
          ['read', 'external_directory'].includes(rule.permission)
        ),
      },
    };
    await waitFor(
      async () => {
        platform.sameIdentity(
          hostIdentity,
          platform.processes().find((row) => row.pid === host.pid)
        );
        messages = (await fetch(new URL(`/session/${session.opencodeSessionId}/message`, url)).then(
          (response) => {
            assert(response.ok);
            return response.json();
          }
        )) as typeof messages;
        return messages.some(
          (message) =>
            message.info.role === 'assistant' &&
            message.info.sessionID === session.opencodeSessionId &&
            message.info.finish === 'stop' &&
            message.parts.some((part) => part.type === 'text' && part.text === 'DONE')
        )
          ? true
          : null;
      },
      'native completion after successful MCP relay',
      30000
    );
    platform.sameIdentity(
      hostIdentity,
      platform.processes().find((row) => row.pid === host.pid)
    );
    receipt.actualRequests = model.requests;
    receipt.passed = true;
  } catch (error) {
    primaryFailure = error;
    receipt.failure = {
      class: 'windows_attachment_boundary_failed',
      phase: receipt.phase,
      assertion: error instanceof Error ? error.message.slice(0, 512) : 'non_error_failure',
    };
  } finally {
    release();
    const cleanup: Record<string, unknown> = { passed: false };
    let cleanupFailed = false;
    if (cdp && teamAttempted) {
      for (const method of ['stop', 'deleteTeam']) {
        try {
          command('inspect', [root], 30000);
          const key = `__TEST_cleanup_${method}`;
          await cdp.evaluate(
            `(() => { window[${literal(key)}] = {done:false}; window.electronAPI.teams.${method}(${literal(team)}).then(() => window[${literal(key)}] = {done:true}, () => window[${literal(key)}] = {done:true,failed:true}); return true; })()`
          );
          const result = await waitFor(
            async () => {
              command('inspect', [root], 30000);
              const state = await cdp!.evaluate<{ done: boolean; failed?: boolean }>(
                `window[${literal(key)}]`
              );
              return state.done ? state : null;
            },
            `owned team ${method}`,
            120000
          );
          assert(!result.failed);
          cleanup[method] = true;
        } catch {
          cleanupFailed = true;
          cleanup[method] = 'failed';
        }
      }
    }
    try {
      cdp?.close();
    } catch {
      cleanupFailed = true;
      cleanup.cdp = 'close_failed';
    }
    try {
      command('stop', [root], 60000);
    } catch {
      cleanupFailed = true;
      cleanup.appStop = 'failed';
    }
    try {
      const identities = JSON.parse(
        await readFile(path.join(root, 'cleanup-identities.json'), 'utf8')
      ) as Identity[];
      const packaged = (await import(
        pathToFileURL(path.join(repo, 'scripts/e2e/opencode-diagnostics/packaged.mjs')).href
      )) as {
        packagedDrainSnapshot(
          ids: Identity[],
          snapshot: Identity[],
          listeners: number[]
        ): { drained: boolean };
      };
      const platform = (await import(
        pathToFileURL(path.join(repo, 'scripts/e2e/opencode-diagnostics/platform.mjs')).href
      )) as { processes(): Identity[]; listeners(): number[] };
      const drain = await waitFor(
        async () => {
          const value = packaged.packagedDrainSnapshot(
            identities,
            platform.processes(),
            platform.listeners()
          );
          return value.drained ? value : null;
        },
        'owned Windows process and CDP drain',
        15000
      );
      Object.assign(cleanup, { passed: !cleanupFailed, identities, drain });
    } catch {
      cleanupFailed = true;
      cleanup.failure = 'owned_cleanup_unproven';
      launcher.unref();
    }
    if (cleanupFailed) cleanup.failure = 'owned_cleanup_unproven';
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
    receipt.actualRequests = model.requests;
    receipt.modelObservation = { observationOnly: true, value: model.observation() };
    receipt.cleanup = cleanup;
    await persist();
    assert(
      !primaryFailure && receipt.passed === true && cleanup.passed === true,
      `Windows attachment proof failed; receipt ${root}`
    );
  }
}
await main();
