// Coordinator-owned, zero paid inference. The loopback responder never reads a saved file.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, realpath, rm, writeFile, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp, waitFor } from '../release-updater/cdp.mts';
import type {
  AttachmentPayload,
  InboxMessage,
  SendMessageResult,
  OpenCodeRuntimeDeliveryStatus,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
  MemberSpawnStatusesSnapshot,
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
  executable?: string;
}
interface Manifest {
  packaged: boolean;
  root: string;
  home: string;
  project: string;
  userData: string;
  launcher?: Identity;
  artifact: {
    app: { path: string; sha256: string };
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
  processStartedAtMs: number;
  leases: Record<
    string,
    {
      leaseKey: string;
      teamId: string;
      laneId: string;
      memberName: string;
      runId: string;
      sessionId: string;
    }
  >;
}
interface Session {
  teamId: string;
  runId: string;
  laneId: string;
  stoppedAt?: string;
  providerId: string;
  opencodeVersion: string;
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
        const challenges = body.messages.flatMap((message) =>
          [
            ...textContent(message.content).matchAll(
              /(?:^|\n)Output only this exact token: (STRICT_LAUNCH_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?=\s*$)/g
            ),
          ].map((match) => match[1]!)
        );
        assert(challenges.length <= 1, 'Ambiguous strict-launch directive');
        const challenge = challenges[0];
        const responseClass = challenge
          ? 'strict-launch-echo'
          : /PONG/i.test(text)
            ? 'pong'
            : 'ready';
        assert(requests.length < 500, 'Model request observation bound exceeded');
        requests.push({
          kind: 'preflight',
          model: body.model,
          challengeClass: challenge ? 'strict-launch-uuid' : 'none',
          responseClass,
          stream: body.stream === true,
        });
        emit(response, body, challenge ?? (/PONG/i.test(text) ? 'PONG' : 'READY'));
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
      assert(requests.length < 500, 'Model request observation bound exceeded');
      requests.push({
        kind: 'attachment',
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
  const packageRoot = path.dirname(data.artifact.app.path);
  const binaryIdentity = async (file: string, namespace: string) => {
    const relative = path.relative(namespace, file);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    let current = namespace;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part);
      const info = await lstat(current);
      assert(!info.isSymbolicLink() && (current === file ? info.isFile() : info.isDirectory()));
    }
    const canonical = await realpath(file);
    assert(canonical.startsWith((await realpath(namespace)) + path.sep));
    const handle = await open(file, 'r');
    try {
      const before = await handle.stat(),
        leaf = await lstat(file);
      assert(
        before.isFile() &&
          before.size <= 512 * 1024 * 1024 &&
          leaf.dev === before.dev &&
          leaf.ino === before.ino &&
          !leaf.isSymbolicLink()
      );
      const digest = createHash('sha256'),
        bytes = Buffer.alloc(65536);
      let position = 0;
      while (position < before.size) {
        const chunk = await handle.read(
          bytes,
          0,
          Math.min(bytes.length, before.size - position),
          position
        );
        assert(chunk.bytesRead > 0);
        digest.update(bytes.subarray(0, chunk.bytesRead));
        position += chunk.bytesRead;
      }
      const after = await lstat(file),
        final = await handle.stat();
      assert(
        !after.isSymbolicLink() &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          after.size === before.size &&
          final.size === before.size &&
          final.mtimeMs === before.mtimeMs &&
          (await realpath(file)) === canonical
      );
      current = namespace;
      for (const part of ['', ...relative.split(path.sep)]) {
        if (part) current = path.join(current, part);
        const info = await lstat(current);
        assert(!info.isSymbolicLink() && (current === file ? info.isFile() : info.isDirectory()));
      }
      return { path: canonical, sha256: digest.digest('hex') };
    } finally {
      await handle.close();
    }
  };
  const expectedWrapperPath = path.join(
    packageRoot,
    'resources/runtime/opencode-console/opencode.exe'
  );
  const wrapper = await binaryIdentity(expectedWrapperPath, packageRoot);
  assert(wrapper.path.toLowerCase() === expectedWrapperPath.toLowerCase());
  receipt.consoleWrapper = { ...wrapper, provenance: 'APP-BUILD-wrapper', boundBeforeLaunch: true };
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
    $schema: 'https://opencode.ai/config.json',
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
  let launchRun: TeamCreateResponse | undefined;
  let retainDispatchDiagnostics: (() => Promise<void>) | undefined;
  let observeDelivery: (() => Promise<void>) | undefined;
  let deliveryMessageId: string | undefined;
  let retainLaunchDiagnostics: (() => Promise<void>) | undefined;
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
    const registry = path.join(data.home, 'AppData/Local/claude-multimodel-nodejs/Data/opencode');
    const readManaged = async (
      name: 'session-store.json' | 'host-registry.json' | 'command-outcomes.json'
    ) => {
      const rootReal = await realpath(root);
      const file = path.join(registry, name),
        relative = path.relative(root, file);
      assert(!relative.startsWith('..') && !path.isAbsolute(relative));
      let current = root;
      for (const part of ['', ...relative.split(path.sep)]) {
        if (part) current = path.join(current, part);
        const info = await lstat(current);
        assert(
          !info.isSymbolicLink() &&
            (current === file ? info.isFile() && info.size <= 2 * 1024 * 1024 : info.isDirectory())
        );
      }
      const canonical = await realpath(file);
      assert(canonical.startsWith(rootReal + path.sep));
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat(),
          leaf = await lstat(file);
        assert(
          info.isFile() &&
            info.size <= 2 * 1024 * 1024 &&
            info.dev === leaf.dev &&
            info.ino === leaf.ino &&
            !leaf.isSymbolicLink()
        );
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        assert(read.bytesRead <= 2 * 1024 * 1024);
        const after = await lstat(file);
        assert(
          !after.isSymbolicLink() &&
            after.dev === info.dev &&
            after.ino === info.ino &&
            (await realpath(file)) === canonical
        );
        return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
      } finally {
        await handle.close();
      }
    };
    const ownedNativeSession = async () => {
      assert(launchRun?.runId);
      const platform = (await import(
        pathToFileURL(path.join(repo, 'scripts/e2e/opencode-diagnostics/platform.mjs')).href
      )) as { processes(): Identity[] };
      const resolve = async () => {
        const sessions = (await readManaged('session-store.json')) as {
          schemaVersion: number;
          records: Record<string, Session>;
        };
        assert(
          sessions.schemaVersion === 1 && Object.keys(sessions.records).length <= 10000,
          'unknown-session-schema'
        );
        const matching = Object.values(sessions.records).filter(
          (row) =>
            row.teamId === team &&
            row.runId === launchRun!.runId &&
            row.laneId === 'primary' &&
            row.memberName === member &&
            row.projectPath === data.project &&
            !row.stoppedAt
        );
        assert(matching.length === 1, 'no-exact-active-session');
        const session = matching[0]!;
        assert(
          session.providerId === 'opencode' &&
            session.selectedModel === MODEL &&
            session.opencodeSessionId.length <= 128 &&
            /^ses_[A-Za-z0-9]+$/.test(session.opencodeSessionId),
          'session-identity-mismatch'
        );
        const registry = (await readManaged('host-registry.json')) as {
          schemaVersion: number;
          processIdentityFormat: string;
          hosts: Record<string, Host>;
        };
        assert(
          registry.schemaVersion === 1 && registry.processIdentityFormat === 'platform-native-v2',
          'unknown-host-schema'
        );
        const host = registry.hosts[session.hostKey];
        assert(
          host &&
            host.hostKey === session.hostKey &&
            host.profileRootKey === session.profileRootKey &&
            host.projectPath === data.project &&
            host.version === '1.19.0',
          'host-identity-mismatch'
        );
        const key = `${team}::${session.laneId}::${member}`,
          lease = host.leases?.[key];
        assert(
          lease &&
            (!lease.leaseKey || lease.leaseKey === key) &&
            lease.teamId === team &&
            lease.laneId === session.laneId &&
            lease.memberName === member &&
            lease.runId === launchRun!.runId &&
            lease.sessionId === session.opencodeSessionId,
          'no-exact-host-lease'
        );
        assert(
          Number.isSafeInteger(host.pid) &&
            host.pid > 0 &&
            Number.isFinite(host.processStartedAtMs) &&
            host.processStartedAtMs > 0,
          'unknown-host-birth'
        );
        assert(
          Number.isSafeInteger(host.port) &&
            host.port > 0 &&
            host.port <= 65535 &&
            host.baseUrl === `http://127.0.0.1:${host.port}`,
          'invalid-host-endpoint'
        );
        const snapshot = platform.processes(),
          identity = snapshot.find((row) => row.pid === host.pid);
        const observedBranch =
          identity?.executable?.toLowerCase() === native.binaryPath.toLowerCase()
            ? 'direct-native'
            : identity?.executable?.toLowerCase() === wrapper.path.toLowerCase()
              ? 'packaged-console-wrapper'
              : 'unknown-executable';
        receipt.nativeOwnershipComparison = {
          at: Date.now(),
          hostPid: host.pid,
          storedBirthMs: host.processStartedAtMs,
          observedBirth: identity?.birth ?? null,
          branch: observedBranch,
          executableUnavailable: !identity?.executable,
          observedExecutable:
            observedBranch === 'direct-native'
              ? native.binaryPath
              : observedBranch === 'packaged-console-wrapper'
                ? wrapper.path
                : null,
          nativePath: native.binaryPath,
          nativeSha256: NATIVE_SHA,
          wrapperPath: wrapper.path,
          wrapperSha256: wrapper.sha256,
        };
        assert(identity, 'host-absent');
        assert(
          Date.parse(identity.birth) === host.processStartedAtMs,
          'host-pid-reused-or-birth-unknown'
        );
        assert(observedBranch !== 'unknown-executable', 'host-executable-mismatch');
        const installed = await binaryIdentity(native.binaryPath, data.userData);
        assert(
          installed.path.toLowerCase() === native.binaryPath.toLowerCase() &&
            installed.sha256 === NATIVE_SHA,
          'native-binary-changed'
        );
        let child: Identity | undefined;
        if (observedBranch === 'packaged-console-wrapper') {
          const currentWrapper = await binaryIdentity(wrapper.path, packageRoot);
          assert(
            currentWrapper.sha256 === wrapper.sha256 && currentWrapper.path === wrapper.path,
            'wrapper-binary-changed'
          );
          const children = snapshot.filter(
            (row) =>
              row.parent === identity.pid &&
              row.executable?.toLowerCase() === installed.path.toLowerCase() &&
              Number.isSafeInteger(row.pid) &&
              row.pid > 0 &&
              Number.isFinite(Date.parse(row.birth)) &&
              Date.parse(row.birth) >= host.processStartedAtMs
          );
          receipt.nativeOwnershipComparison = {
            ...(receipt.nativeOwnershipComparison as Record<string, unknown>),
            directNativeChildCount: children.length,
          };
          assert(children.length === 1, 'no-unique-direct-native-child');
          child = children[0]!;
          receipt.nativeOwnershipComparison = {
            ...(receipt.nativeOwnershipComparison as Record<string, unknown>),
            child: {
              pid: child.pid,
              parent: child.parent,
              birth: child.birth,
              executable: installed.path,
            },
          };
        }
        const current = platform.processes(),
          liveParent = current.find((row) => row.pid === identity.pid);
        assert(
          liveParent?.birth === identity.birth &&
            liveParent.executable?.toLowerCase() === identity.executable?.toLowerCase(),
          'registered-host-changed'
        );
        if (child) {
          const liveChild = current.find((row) => row.pid === child!.pid);
          assert(
            liveChild?.birth === child.birth &&
              liveChild.parent === identity.pid &&
              liveChild.executable?.toLowerCase() === installed.path.toLowerCase(),
            'native-child-changed'
          );
        }
        return {
          session,
          host,
          identity,
          child,
          branch: observedBranch,
          binding: JSON.stringify([
            observedBranch,
            child ? [child.pid, child.parent, child.birth, child.executable] : null,
            session.hostKey,
            session.profileRootKey,
            session.opencodeSessionId,
            session.runId,
            session.laneId,
            host.pid,
            host.processStartedAtMs,
            host.baseUrl,
            [lease.teamId, lease.laneId, lease.memberName, lease.runId, lease.sessionId],
          ]),
        };
      };
      const view = await resolve();
      const recheck = async () => {
        assert((await resolve()).binding === view.binding, 'session-host-lease-changed');
      };
      const read = async <T,>(suffix: string, deadline = Date.now() + 5000) => {
        assert(
          suffix === '/agent' ||
            suffix === '/session/status' ||
            suffix === `/session/${view.session.opencodeSessionId}/message` ||
            new RegExp(
              `^/session/${view.session.opencodeSessionId}/message/msg_[A-Za-z0-9]+$`
            ).test(suffix)
        );
        await recheck();
        const timeout = deadline - Date.now();
        assert(timeout > 0, 'native-observation-deadline');
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), Math.min(timeout, 5000));
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await fetch(new URL(suffix, view.host.baseUrl), {
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok) return { status: response.status, value: null };
          reader = response.body?.getReader();
          assert(reader);
          const chunks: Buffer[] = [];
          let bytes = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            assert(bytes <= 2 * 1024 * 1024, 'native-response-byte-cap');
            chunks.push(Buffer.from(part.value));
          }
          return {
            status: response.status,
            value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
          };
        } finally {
          clearTimeout(timer);
          controller.abort();
          try {
            await reader?.cancel();
          } catch {
            // Cancellation can reject after abort; the identity recheck still runs below.
          }
          reader?.releaseLock();
          await recheck();
        }
      };
      return { ...view, read, recheck };
    };
    let statusKey: string | undefined,
      statusStartedAt = 0;
    observeDelivery = async () => {
      if (!deliveryMessageId) return;
      try {
        if (!statusKey && Date.now() - statusStartedAt >= 1000) {
          statusStartedAt = Date.now();
          statusKey = await begin(
            `window.electronAPI.teams.getOpenCodeRuntimeDeliveryStatus(${literal(team)}, ${literal(deliveryMessageId)})`
          );
        }
        if (!statusKey) return;
        const state = await evaluate<{
          done: boolean;
          error?: string;
          value?: OpenCodeRuntimeDeliveryStatus | null;
        }>(`window[${literal(statusKey)}]`);
        if (!state.done) return;
        const value = state.value;
        if (value) assert(value.messageId === deliveryMessageId);
        receipt.deliveryObservation = {
          observationOnly: true,
          at: Date.now(),
          messageId: deliveryMessageId,
          collectionFailed: Boolean(state.error),
          value: value
            ? {
                messageId: value.messageId,
                accepted: value.accepted,
                delivered: value.delivered,
                responsePending: value.responsePending,
                responseState: value.responseState,
                acceptanceUnknown: value.acceptanceUnknown,
                ledgerStatus: value.ledgerStatus,
                laneId: value.laneId,
                ledgerRecordId: value.ledgerRecordId,
                reason: value.reason?.slice(0, 512),
                diagnostics: value.diagnostics?.slice(0, 16).map((v) => v.slice(0, 512)),
              }
            : null,
        };
        statusKey = undefined;
      } catch {
        statusKey = undefined;
        receipt.deliveryObservation = { observationOnly: true, collectionFailed: true };
      }
    };
    retainDispatchDiagnostics = async () => {
      if (!deliveryMessageId || !launchRun) return;
      const collected: Record<string, unknown> = {
        observationOnly: true,
        messageId: deliveryMessageId,
        runId: launchRun.runId,
        member,
        at: Date.now(),
      };
      try {
        await observeDelivery!();
        if (statusKey)
          await waitFor(
            async () => {
              await observeDelivery!();
              return !statusKey ? true : null;
            },
            'delivery observation',
            5000
          );
        try {
          const outcomes = (await readManaged('command-outcomes.json')) as {
            schemaVersion: number;
            records: Record<string, Record<string, unknown>>;
          };
          assert(outcomes.schemaVersion === 1 && Object.keys(outcomes.records).length <= 10000);
          const records = Object.values(outcomes.records).filter(
            (row) =>
              row.schemaVersion === 1 &&
              row.command === 'opencode.sendMessage' &&
              row.teamName === team &&
              row.teamId === team &&
              row.runId === launchRun!.runId &&
              row.memberName === member &&
              row.messageId === deliveryMessageId &&
              row.projectPath === data.project
          );
          const stages = [
            'received',
            'preconditions_checked',
            'session_resolved',
            'mcp_ready',
            'prompt_submitting',
            'prompt_accepted',
            'turn_observed',
            'reconciled',
            'failed_before_accept',
            'failed_after_accept',
          ];
          const safe = (value: unknown) =>
            typeof value === 'string' && value.length <= 256 ? value : null;
          collected.commandOutcomes = records.slice(0, 16).map((row) => ({
            requestId: safe(row.requestId),
            deliveryAttemptId: safe(row.deliveryAttemptId),
            runId: safe(row.runId),
            messageId: safe(row.messageId),
            sessionId: safe(row.sessionId),
            status: stages.includes(String(row.status)) ? row.status : 'unknown',
            runtimePid:
              typeof row.runtimePid === 'number' && Number.isSafeInteger(row.runtimePid)
                ? row.runtimePid
                : null,
            safeToRetry: typeof row.safeToRetry === 'boolean' ? row.safeToRetry : null,
            prePromptCursor: safe(row.prePromptCursor),
            runtimePromptMessageId: safe(row.runtimePromptMessageId),
            acceptedAt: safe(row.acceptedAt),
            turnObservedAt: safe(row.turnObservedAt),
            completedAt: safe(row.completedAt),
            createdAt: safe(row.createdAt),
            updatedAt: safe(row.updatedAt),
          }));
          collected.commandOutcomeOverflow = records.length > 16;
        } catch (error) {
          const code =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^[A-Z0-9_]{1,64}$/.test(error.code)
              ? error.code
              : null;
          collected.commandOutcomeObservation = {
            state: code === 'ENOENT' ? 'missing-unknown' : 'collection-failed',
            code,
          };
        }
        try {
          const view = await ownedNativeSession(),
            { session, host, identity } = view;
          collected.session = {
            sessionId: session.opencodeSessionId,
            runId: session.runId,
            laneId: session.laneId,
            hostKey: session.hostKey,
            profileRootKey: session.profileRootKey,
          };
          collected.host = {
            pid: host.pid,
            birthMs: host.processStartedAtMs,
            version: host.version,
            owner: 'exact-lease-and-fresh-native-identity',
            identity,
          };
          const accepted = (
            collected.commandOutcomes as
              | Array<{
                  sessionId: string;
                  runtimePromptMessageId: string;
                  safeToRetry: boolean;
                  createdAt: string | null;
                }>
              | undefined
          )?.find(
            (row) =>
              row.sessionId === session.opencodeSessionId &&
              row.safeToRetry === false &&
              /^msg_[A-Za-z0-9]+$/.test(row.runtimePromptMessageId)
          );
          const attemptCreatedAt = accepted?.createdAt ? Date.parse(accepted.createdAt) : NaN;
          collected.nativeAsyncLogObservation = { state: 'unknown' };
          try {
            assert(/^[A-Za-z0-9_-]{1,128}$/.test(session.profileRootKey), 'unsafe-profile-key');
            await view.recheck();
            const log = path.join(
              registry,
              'profiles',
              session.profileRootKey,
              'data/opencode/log/opencode.log'
            );
            const rootReal = await realpath(root),
              relative = path.relative(root, log);
            assert(!relative.startsWith('..') && !path.isAbsolute(relative));
            let component = root;
            for (const part of ['', ...relative.split(path.sep)]) {
              if (part) component = path.join(component, part);
              const info = await lstat(component);
              assert(
                !info.isSymbolicLink() && (component === log ? info.isFile() : info.isDirectory())
              );
            }
            const canonical = await realpath(log);
            assert(canonical.startsWith(rootReal + path.sep));
            const handle = await open(log, 'r');
            try {
              const before = await handle.stat(),
                leaf = await lstat(log);
              assert(
                Number.isSafeInteger(before.size) &&
                  before.size >= 0 &&
                  before.isFile() &&
                  !leaf.isSymbolicLink() &&
                  leaf.dev === before.dev &&
                  leaf.ino === before.ino
              );
              const length = Math.min(before.size, 65536),
                bytes = Buffer.alloc(length);
              const read = await handle.read(bytes, 0, length, Math.max(0, before.size - length));
              const after = await lstat(log);
              assert(
                !after.isSymbolicLink() &&
                  after.dev === before.dev &&
                  after.ino === before.ino &&
                  (await realpath(log)) === canonical
              );
              component = root;
              for (const part of ['', ...relative.split(path.sep)]) {
                if (part) component = path.join(component, part);
                const info = await lstat(component);
                assert(
                  !info.isSymbolicLink() && (component === log ? info.isFile() : info.isDirectory())
                );
              }
              await view.recheck();
              const tail = bytes.subarray(0, read.bytesRead).toString('utf8');
              const complete = tail.split(/\r?\n/),
                lines = complete.slice(before.size > length ? 1 : 0, -1);
              const collectedAt = Date.now();
              let matched = 0,
                otherSession = 0,
                malformed = 0,
                unfenced = 0;
              const categories = new Set<string>();
              for (const line of lines) {
                if (line.length > 8192) {
                  malformed++;
                  continue;
                }
                const token = /([A-Za-z0-9_.-]+)=("(?:\\.|[^"\\])*"|[^\s="\\]+)(?: +|$)/gy;
                let offset = 0;
                const fields = new Map<string, string[]>();
                try {
                  while (offset < line.length) {
                    token.lastIndex = offset;
                    const part = token.exec(line);
                    assert(part);
                    const value = part[2]!.startsWith('"')
                      ? (JSON.parse(part[2]!) as string)
                      : part[2]!;
                    fields.set(part[1]!, [...(fields.get(part[1]!) ?? []), value]);
                    offset = token.lastIndex;
                  }
                  const messages = fields.get('message'),
                    sessions = fields.get('sessionID');
                  if (messages?.length !== 1 || (sessions && sessions.length !== 1)) {
                    malformed++;
                    continue;
                  }
                  if (messages[0] === 'prompt_async failed') {
                    if (sessions?.[0] === session.opencodeSessionId) {
                      const timestamps = fields.get('timestamp'),
                        timestamp = timestamps?.length === 1 ? Date.parse(timestamps[0]!) : NaN;
                      if (
                        !Number.isFinite(attemptCreatedAt) ||
                        !Number.isFinite(timestamp) ||
                        timestamp < attemptCreatedAt ||
                        timestamp > collectedAt
                      ) {
                        unfenced++;
                        continue;
                      }
                      matched++;
                      const cause = [...fields]
                        .filter(([key]) => key === 'cause' || key.startsWith('cause.'))
                        .flatMap(([, values]) => values)
                        .join(' ');
                      for (const match of cause.matchAll(
                        /\b(ImageDecodeError|ImageInvalidDataUrlError|ImageSizeError|ImageResizerUnavailableError|ENOENT|EACCES|EINVAL)\b/g
                      ))
                        categories.add(match[1]!);
                    } else otherSession++;
                  }
                } catch {
                  malformed++;
                }
              }
              collected.nativeAsyncLogObservation = {
                state: 'tail-read',
                bytes: read.bytesRead,
                truncated: before.size > length,
                incompleteTrailingRecord: Boolean(complete.at(-1)),
                matched,
                otherSession,
                malformed,
                unfenced,
                attemptReceiveTimeFenced: Number.isFinite(attemptCreatedAt),
                collectionTime: collectedAt,
                sessionCorrelation: matched
                  ? 'exact-message-session-and-attempt-time'
                  : unfenced
                    ? 'unknown-unfenced-record'
                    : 'unknown-no-match-in-bounded-tail',
                causeCategories: categories.size ? [...categories] : ['unknown-cause-format'],
              };
            } finally {
              await handle.close();
            }
          } catch (error) {
            const code =
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string' &&
              ['ENOENT', 'EACCES', 'EINVAL'].includes(error.code)
                ? error.code
                : null;
            collected.nativeAsyncLogObservation = {
              state: code === 'ENOENT' ? 'unavailable' : 'collection-failed',
              code,
              sessionCorrelation: 'unknown',
            };
          } finally {
            try {
              await view.recheck();
            } catch {
              collected.nativeAsyncLogObservation = {
                state: 'unknown-owner-changed',
                sessionCorrelation: 'unknown',
              };
            }
          }
          const deadline = Date.now() + 5000;
          const project = (value: unknown) => {
            const message = value as {
              info?: {
                id?: string;
                sessionID?: string;
                role?: string;
                modelID?: string;
                providerID?: string;
                finish?: string;
                error?: { name?: string };
              };
              parts?: unknown[];
            };
            const info = message?.info;
            assert(
              info && info.sessionID === session.opencodeSessionId && typeof info.id === 'string',
              'foreign-native-message'
            );
            return {
              id: info?.id?.slice(0, 128),
              sessionId: info?.sessionID?.slice(0, 128),
              role: info?.role?.slice(0, 32),
              model: info?.modelID?.slice(0, 128),
              provider: info?.providerID?.slice(0, 64),
              finish: info?.finish?.slice(0, 64),
              errorClass: info?.error
                ? /^[A-Za-z0-9_]{1,64}$/.test(info.error.name ?? '')
                  ? info.error.name
                  : 'unknown-error'
                : null,
              partsCount: Array.isArray(message?.parts) ? message.parts.length : null,
            };
          };
          if (accepted) {
            const anchor = await view.read<unknown>(
              `/session/${session.opencodeSessionId}/message/${accepted.runtimePromptMessageId}`,
              deadline
            );
            const metadata = anchor.value ? project(anchor.value) : null;
            collected.acceptedAnchor = {
              messageId: accepted.runtimePromptMessageId,
              status: anchor.status,
              present:
                metadata?.id === accepted.runtimePromptMessageId &&
                metadata.sessionId === session.opencodeSessionId,
              metadata,
            };
          } else collected.acceptedAnchor = { state: 'no-matching-accepted-anchor-receipt' };
          const status = await view.read<Record<string, { type?: string }>>(
            '/session/status',
            deadline
          );
          const ownStatus = status.value?.[session.opencodeSessionId]?.type;
          collected.nativeStatus = {
            status: status.status,
            sessionId: session.opencodeSessionId,
            type: ['idle', 'busy', 'retry'].includes(ownStatus ?? '')
              ? ownStatus
              : 'unknown-or-sparse-absent',
          };
          const history = await view.read<unknown[]>(
            `/session/${session.opencodeSessionId}/message`,
            deadline
          );
          assert(history.value === null || Array.isArray(history.value));
          collected.nativeHistory = {
            status: history.status,
            entries: history.value?.slice(-32).map(project),
            truncated: (history.value?.length ?? 0) > 32,
          };
        } catch (error) {
          const classes = [
            'unknown-session-schema',
            'no-exact-active-session',
            'session-identity-mismatch',
            'unknown-host-schema',
            'host-identity-mismatch',
            'no-exact-host-lease',
            'unknown-host-birth',
            'invalid-host-endpoint',
            'host-absent',
            'host-pid-reused-or-birth-unknown',
            'host-executable-mismatch',
            'native-binary-changed',
            'wrapper-binary-changed',
            'no-unique-direct-native-child',
            'registered-host-changed',
            'native-child-changed',
            'session-host-lease-changed',
          ];
          collected.nativeSessionObservation = {
            state: 'unknown',
            classification:
              error instanceof Error && classes.includes(error.message)
                ? error.message
                : 'collection-failed',
          };
        }
      } catch {
        collected.collectionFailed = true;
      }
      receipt.dispatchFailureObservation = collected;
    };
    retainLaunchDiagnostics = async () => {
      const runId = launchRun?.runId;
      if (!runId) {
        receipt.launchFailureObservation = { observationOnly: true, runBinding: 'unknown' };
        return;
      }
      try {
        const key = await begin(`Promise.allSettled([
          window.electronAPI.teams.getProvisioningStatus(${literal(runId)}).then(p => {
            if (p.runId !== ${literal(runId)} || p.teamName !== ${literal(team)}) throw new Error('Own provisioning binding mismatch');
            return {runId:p.runId,teamName:p.teamName,state:p.state,configReady:p.configReady,
              error:p.error?.slice(0,512),launchDiagnostics:p.launchDiagnostics?.slice(0,32).map(d => ({code:d.code,severity:d.severity,memberName:d.memberName?.slice(0,128),label:d.label.slice(0,256),detail:d.detail?.slice(0,512),observedAt:d.observedAt})),cliLogsTail:p.cliLogsTail?.slice(-4096)};
          }), window.electronAPI.teams.getLaunchFailureDiagnostics(${literal(team)}, ${literal(runId)}).then(p => {
            if (p.runId !== ${literal(runId)} || p.teamName !== ${literal(team)}) throw new Error('Own diagnostics binding unavailable');
            return {runId:p.runId,teamName:p.teamName,classification:p.classification ? {code:p.classification.code?.slice(0,128),confidence:p.classification.confidence,evidence:p.classification.evidence?.slice(0,8).map(v => v.slice(0,512))} : null,
              bootstrapTransportBreadcrumb:p.bootstrapTransportBreadcrumb ? {lastTransportStage:p.bootstrapTransportBreadcrumb.lastTransportStage?.slice(0,128),submitRejected:p.bootstrapTransportBreadcrumb.submitRejected,retryable:p.bootstrapTransportBreadcrumb.retryable,noStdinWarning:p.bootstrapTransportBreadcrumb.noStdinWarning,bootstrapSubmitted:p.bootstrapTransportBreadcrumb.bootstrapSubmitted,evidence:p.bootstrapTransportBreadcrumb.evidence?.slice(0,8).map(v => v.slice(0,512))} : null,
              files:p.files.slice(0,8).map(f => ({label:f.label.slice(0,128),path:f.path.slice(0,1024),content:f.content?.slice(-4096),issue:f.issue?.slice(0,256)}))};
          })]).then(results => results.map(r => r.status === 'fulfilled' ? r : {status:r.status,reason:String(r.reason).slice(0,512)}))`);
        const observed = await waitFor(
          async () => {
            const value = await evaluate<{ done: boolean; value?: unknown; error?: string }>(
              `window[${literal(key)}]`
            );
            return value.done ? value : null;
          },
          'owned launch failure observation',
          5000
        );
        receipt.launchFailureObservation = {
          observationOnly: true,
          runId,
          teamName: team,
          ...observed,
        };
      } catch {
        receipt.launchFailureObservation = {
          observationOnly: true,
          runId,
          teamName: team,
          collectionFailed: true,
        };
      }
    };
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
    launchRun = await api<TeamCreateResponse>(
      `window.electronAPI.teams.createTeam(${literal(request)})`,
      'compiled legacy team launch'
    );
    receipt.launch = launchRun;
    assert(typeof launchRun.runId === 'string' && launchRun.runId.length > 0);
    await waitFor(
      async () => {
        check();
        const progress = await api<TeamProvisioningProgress>(
          `window.electronAPI.teams.getProvisioningStatus(${literal(launchRun!.runId)})`,
          'own provisioning readiness'
        );
        assert(
          progress.teamName === team && progress.runId === launchRun!.runId,
          'Own provisioning run mismatch'
        );
        receipt.provisioningReadiness = {
          runId: progress.runId,
          teamName: progress.teamName,
          state: progress.state,
        };
        assert(!['failed', 'cancelled'].includes(progress.state), `Provisioning ${progress.state}`);
        const statuses = await api<MemberSpawnStatusesSnapshot>(
          `window.electronAPI.teams.getMemberSpawnStatuses(${literal(team)})`,
          'own bootstrap readiness'
        );
        const worker = statuses.statuses[member];
        receipt.bootstrapReadiness = {
          runId: statuses.runId,
          worker: worker
            ? {
                status: worker.status,
                launchState: worker.launchState,
                bootstrapConfirmed: worker.bootstrapConfirmed,
                hardFailure: worker.hardFailure,
                skippedForLaunch: worker.skippedForLaunch,
                pendingPermissionRequestIds: worker.pendingPermissionRequestIds?.slice(0, 16),
              }
            : null,
        };
        return progress.state === 'ready' &&
          statuses.runId === launchRun!.runId &&
          worker?.launchState === 'confirmed_alive' &&
          worker.bootstrapConfirmed === true &&
          !worker.hardFailure &&
          !worker.pendingPermissionRequestIds?.length &&
          !worker.skippedForLaunch &&
          worker.status !== 'skipped'
          ? true
          : null;
      },
      'committed own-run native bootstrap',
      180000
    );
    try {
      const runtime = await api<TeamAgentRuntimeSnapshot>(
        `window.electronAPI.teams.getTeamAgentRuntime(${literal(team)})`,
        'runtime diagnostic'
      );
      receipt.runtimeActor = runtime.members[member];
    } catch {
      receipt.runtimeActorObservationFailed = true;
    }
    const binaryBytes = Buffer.from(
      `TEST arbitrary reference\nNONCE ${randomBytes(16).toString('hex')}\n`
    );
    const expectedNonce = binaryBytes.toString('utf8').match(/NONCE ([a-f0-9]{32})/)![1];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
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
    deliveryMessageId = messageId;
    receipt.phase = 'attachment_admission';
    const sentKey = await begin(
      `window.electronAPI.teams.sendMessage(${literal(team)}, ${literal({ member, messageId, text: 'Read the saved arbitrary file with the native Read tool, then reply to user via message_send with the NONCE and image SHA. Do not execute or extract either attachment.', attachments: payloads })})`
    );
    const inboxPath = path.join(teamDir, 'inboxes', `${member}.json`);
    const original = await waitFor(
      async () => {
        const admission = await evaluate<{
          done: boolean;
          error?: string;
          value?: SendMessageResult;
        }>(`window[${literal(sentKey)}]`);
        const value = admission.value,
          delivery = value?.runtimeDelivery;
        receipt.admission = {
          at: Date.now(),
          done: admission.done,
          error: admission.error?.slice(0, 512),
          value: value
            ? {
                messageId: value.messageId.slice(0, 128),
                deliveredToInbox: value.deliveredToInbox,
                runtimeDelivery: delivery
                  ? {
                      accepted: delivery.accepted,
                      delivered: delivery.delivered,
                      responsePending: delivery.responsePending,
                      responseState: delivery.responseState,
                      acceptanceUnknown: delivery.acceptanceUnknown,
                      reason: delivery.reason?.slice(0, 512),
                      diagnostics: delivery.diagnostics
                        ?.slice(0, 16)
                        .map((item) => item.slice(0, 512)),
                    }
                  : null,
              }
            : null,
        };
        assert(
          !(admission.done && admission.error),
          `Attachment admission failed: ${admission.error?.slice(0, 512)}`
        );
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
    const nativeView = await ownedNativeSession();
    const { session, host, identity: hostIdentity } = nativeView;
    const initialMessages = await nativeView.read<unknown[]>(
      `/session/${session.opencodeSessionId}/message`
    );
    assert(initialMessages.status === 200 && initialMessages.value);
    let messages = initialMessages.value as Array<{
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
    await nativeView.recheck();
    const agentResponse = await nativeView.read<unknown[]>('/agent');
    assert(agentResponse.status === 200 && agentResponse.value);
    const agents = agentResponse.value as Array<{
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
        const current = await nativeView.read<typeof messages>(
          `/session/${session.opencodeSessionId}/message`
        );
        assert(current.status === 200 && current.value);
        messages = current.value;
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
    await nativeView.recheck();
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
    if (primaryFailure && cdp && teamAttempted) {
      await retainDispatchDiagnostics?.();
      await retainLaunchDiagnostics?.();
    }
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
    try {
      const actualConfig = await readFile(path.join(data.project, 'opencode.json'));
      receipt.postConfigObservation = {
        observationOnly: true,
        sha256: hash(actualConfig),
        schemaPresent: typeof JSON.parse(actualConfig.toString('utf8')).$schema === 'string',
      };
    } catch {
      receipt.postConfigObservation = { observationOnly: true, collectionFailed: true };
    }
    await persist();
    assert(
      !primaryFailure && receipt.passed === true && cleanup.passed === true,
      `Windows attachment proof failed; receipt ${root}`
    );
  }
}
await main();
