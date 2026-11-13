/** Actual pinned D/Claude SDK under the existing Windows owned-process TEST gate. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createClaudeDriverFactory, type ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { Event, Session } from '@agent-teams/provider-session-contracts';
import type { ServerResponse } from 'node:http';

export interface NativeWindowsClaudeObservation {
  phase: 'opening' | 'observing' | 'ready' | 'start' | 'background' | 'continuation' | 'completed';
  model: { backgroundTool: number; backgroundResult: number; continuation: number;
    tokenRequests: number; failures: number };
  events: Record<Event['kind'], number>;
  unknownKinds: number;
  diagnostics: { unknownEvent: number; other: number };
  start: { matchingOperation: number; matchingInput: number; text: number; result: number; succeeded: number };
  continuation: { matchingOperation: number; matchingInput: number; text: number; result: number; succeeded: number };
  observerFailed: boolean;
  permissionReplies: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function responseFrame(response: ServerResponse, sequence: number, block: Record<string, unknown>): void {
  const tool = block.type === 'tool_use';
  const emit = (type: string, value: Record<string, unknown>) =>
    response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit('message_start', { message: { id: 'msg_TEST_vendor_' + sequence, type: 'message',
    role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 0 } } });
  emit('content_block_start', { index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 15 } });
  emit('message_stop', {}); response.end();
}

async function vendorModel(options: { command: string; nonce: string }) {
  const requests: string[] = [], failures: string[] = [];
  let counts = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.deepEqual(failures, []);
      assert.equal(request.method, 'POST');
      const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
      assert.ok(pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length;
        assert.ok(bytes <= 2_000_000); chunks.push(chunk);
      }
      if (pathname.endsWith('/count_tokens')) {
        assert.ok(++counts <= 8);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"input_tokens":20}'); return;
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.ok(requests.length < 3, 'One tool call, its native result and one continuation');
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const user = messages.toReversed().filter(row => row.role === 'user')
        .map(row => JSON.stringify(row.content) ?? '').find(text =>
          text.includes('TEST_WINDOWS_VENDOR_START:' + options.nonce) ||
          text.includes('TEST_WINDOWS_VENDOR_CONTINUE:' + options.nonce));
      assert.ok(user);
      const continuing = user.includes('TEST_WINDOWS_VENDOR_CONTINUE:' + options.nonce);
      if (requests.length === 0) {
        assert.equal(continuing, false);
        assert.ok((Array.isArray(body.tools) ? body.tools : []).map(record).some(tool => tool.name === 'Bash'));
        requests.push('native_background_tool');
        responseFrame(response, 1, { type: 'tool_use', id: 'TEST_vendor_bash', name: 'Bash',
          input: { command: options.command, description: 'Start the isolated TEST service tree',
            run_in_background: true } });
      } else if (requests.length === 1) {
        assert.equal(continuing, false);
        const results = messages.filter(row => row.role === 'user')
          .flatMap(row => Array.isArray(row.content) ? row.content.map(record) : [])
          .filter(row => row.type === 'tool_result' && row.tool_use_id === 'TEST_vendor_bash');
        assert.equal(results.length, 1);
        assert.notEqual(results[0]!.is_error, true, 'Genuine native Bash succeeded');
        requests.push('native_background_result');
        responseFrame(response, 2, { type: 'text', text: 'TEST_WINDOWS_VENDOR_STARTED' });
      } else {
        assert.equal(continuing, true);
        requests.push('same_session_after_scoped_stop');
        responseFrame(response, 3, { type: 'text', text: 'TEST_WINDOWS_VENDOR_CONTINUED' });
      }
    })().catch(() => {
      failures.push('TEST_native_vendor_oracle_refused');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST native vendor oracle refused');
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', done);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: 'http://127.0.0.1:' + address.port, requests, failures, tokenRequests: () => counts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    } };
}

export async function runNativeWindowsClaude(options: {
  root: string; executable: string; bash: string;
  fixture: string; marker: string; output: string; nonce: string;
  custody: ClaudeConfig['custody'];
  afterBackground(): Promise<void>;
  observe(snapshot: NativeWindowsClaudeObservation): void;
}) {
  assert.equal(process.platform, 'win32');
  const systemRoot = process.env.SystemRoot!;
  assert.ok(/^[a-z]:\\/i.test(systemRoot));
  for (const name of ['home', 'tmp', 'config', 'workspace', 'appdata', 'localdata'])
    await mkdir(join(options.root, name), { recursive: true });
  const command = [options.fixture, 'vendor-tree', options.marker, options.nonce]
    .map(value => quote(value.replaceAll('\\', '/'))).join(' ') +
    ' > ' + quote(options.output.replaceAll('\\', '/'));
  const model = await vendorModel({ command, nonce: options.nonce });
  const events: Event[] = [];
  let observation: Promise<void> | undefined, session: Session | undefined, observerFailure: unknown;
  let originalFailure: unknown, cleanup = false, permissionReplies = 0;
  let phase: NativeWindowsClaudeObservation['phase'] = 'opening';
  const currentPhase = () => phase;
  const cleanupErrors: unknown[] = [];
  try {
    const config: ClaudeConfig = {
      sessionRef: 'TEST-native-vendor-' + options.nonce, trustedBinding: 'TEST-vendor-' + options.nonce,
      cwd: join(options.root, 'workspace'), executablePath: options.executable,
      model: 'claude-sonnet-4-6', accountBinding: 'TEST-localhost-only', configRevision: 'TEST-native-vendor-1',
      environment: {
        HOME: join(options.root, 'home'), USERPROFILE: join(options.root, 'home'),
        CLAUDE_CONFIG_DIR: join(options.root, 'config'), TEMP: join(options.root, 'tmp'), TMP: join(options.root, 'tmp'),
        APPDATA: join(options.root, 'appdata'), LOCALAPPDATA: join(options.root, 'localdata'),
        SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(systemRoot, 'System32/cmd.exe'),
        PATH: [dirname(options.bash), dirname(process.execPath), join(systemRoot, 'System32')].join(delimiter),
        CLAUDE_CODE_GIT_BASH_PATH: options.bash, OWNED_PROCESS_VENDOR_TEST_GO: '1',
        ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1',
        NO_COLOR: '1', TERM: 'dumb',
      },
      nativeTools: ['Bash'], autoAllowedTools: ['Bash'], mcpServers: {}, requiredTools: {},
      nativeOptions: { settingSources: [] }, probe: async () => true, sessionExists: async () => false,
      limits: { queuedInputs: 1, inputBytes: 8192, outputEvents: 1000, outputBytes: 2_000_000,
        pendingInteractions: 2, timeoutMs: 45_000 },
      custody: options.custody,
    };
    const factory = createClaudeDriverFactory({ capabilities: ['session.conversation'],
      resolveConfiguration: async request => request.sessionId === config.sessionRef &&
        request.configRevision === config.configRevision ? config : undefined,
      readCheckpoint: async () => undefined });
    session = (await factory.open({ tenantId: 'TEST-tenant', projectId: 'TEST-project',
      sessionId: config.sessionRef, generation: 1, configRevision: config.configRevision,
      requiredCapabilities: ['session.conversation'] })).driver;
    const original = session;
    phase = 'observing';
    observation = (async () => {
      for await (const event of original.observe()) {
        assert.ok(events.length < 1000);
        events.push(event);
        if (event.kind === 'interaction') {
          assert.ok(permissionReplies === 0 && currentPhase() === 'start' &&
            event.sessionRef === original.sessionRef && event.operationRef === 'TEST-vendor-START' &&
            event.inputId === 'TEST-vendor-START-input', 'One original START permission only');
          assert.ok(event.request.kind === 'permission', 'Only the captured TEST Bash permission');
          assert.ok(event.request.tool === 'Bash' && isDeepStrictEqual(event.request.input, {
            command, description: 'Start the isolated TEST service tree', run_in_background: true,
          }), 'Permission input matches the exact captured TEST command');
          const reply = await original.respondToInteraction(event.interactionRef,
            { kind: 'permission', decision: 'allow' });
          assert.equal(reply.ok, true, 'Original one-shot permission reply accepted');
          permissionReplies++;
        }
      }
    })().catch(error => { observerFailure = error; });
    assert.equal((await session.checkReadiness()).ok, true, 'Actual SDK readiness completed');
    phase = 'ready';
    for (const [label, expected] of [
      ['START', 'TEST_WINDOWS_VENDOR_STARTED'], ['CONTINUE', 'TEST_WINDOWS_VENDOR_CONTINUED'],
    ] as const) {
      const operationRef = 'TEST-vendor-' + label, inputId = operationRef + '-input';
      phase = label === 'START' ? 'start' : 'continuation';
      assert.equal((await session.submit({ inputId, operationRef,
        content: 'TEST_WINDOWS_VENDOR_' + label + ':' + options.nonce })).ok, true);
      const deadline = Date.now() + (label === 'START' ? 35_000 : 7000);
      for (;;) {
        assert.equal(observerFailure, undefined);
        assert.deepEqual(model.failures, []);
        const terminal = events.find(event => event.kind === 'result' && event.operationRef === operationRef);
        if (terminal?.kind === 'result') {
          assert.equal(terminal.outcome, 'succeeded');
          assert.ok(events.some(event => event.kind === 'text' &&
            event.operationRef === operationRef && event.text.includes(expected)));
          break;
        }
        assert.ok(Date.now() < deadline, 'Bounded genuine SDK result');
        await new Promise<void>(done => setTimeout(done, 20));
      }
      if (label === 'START') { phase = 'background'; await options.afterBackground(); }
    }
    assert.deepEqual(model.requests, ['native_background_tool', 'native_background_result', 'same_session_after_scoped_stop']);
    phase = 'completed';
  } catch (error) { originalFailure = error; }
  finally {
    // Capture the failure boundary before close can add cancellation/result events.
    // Only finite counters leave this TEST fixture; payload, paths, IDs and error text stay private.
    try {
      const kinds: Record<Event['kind'], number> = {
        compaction: 0, text: 0, tool: 0, 'tool-result': 0, usage: 0, result: 0, interaction: 0, diagnostic: 0,
      };
      for (const kind of Object.keys(kinds) as Event['kind'][])
        kinds[kind] = events.filter(event => event.kind === kind).length;
      const count = (label: 'START' | 'CONTINUE') => {
        const operationRef = 'TEST-vendor-' + label;
        const matching = events.filter(event => event.operationRef === operationRef);
        return { matchingOperation: matching.length,
          matchingInput: events.filter(event => event.inputId === operationRef + '-input').length,
          text: matching.filter(event => event.kind === 'text').length,
          result: matching.filter(event => event.kind === 'result').length,
          succeeded: matching.filter(event => event.kind === 'result' && event.outcome === 'succeeded').length };
      };
      const unknownEvent = events.filter(event => event.kind === 'diagnostic' &&
        event.code === 'unknown-event').length;
      options.observe({ phase,
        model: { backgroundTool: model.requests.filter(value => value === 'native_background_tool').length,
          backgroundResult: model.requests.filter(value => value === 'native_background_result').length,
          continuation: model.requests.filter(value => value === 'same_session_after_scoped_stop').length,
          tokenRequests: model.tokenRequests(), failures: model.failures.length },
        events: kinds, unknownKinds: events.length - Object.values(kinds).reduce((sum, value) => sum + value, 0),
        diagnostics: { unknownEvent, other: kinds.diagnostic - unknownEvent },
        start: count('START'), continuation: count('CONTINUE'),
        observerFailed: observerFailure !== undefined, permissionReplies });
    } catch (error) { cleanupErrors.push(error); }
    try {
      if (session) {
        const closed = await session.close();
        assert.equal(closed.cleanup, 'confirmed', 'Original broker whole-Job proof and release, not SDK exit');
        cleanup = true;
      }
      if (observation) {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('Native observer did not close')), 5000);
          void observation!.then(() => { clearTimeout(timer); done(); }, error => { clearTimeout(timer); reject(error); });
        });
        assert.equal(observerFailure, undefined);
      }
    } catch (error) { cleanupErrors.push(error); }
    try { await model.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (originalFailure !== undefined || cleanupErrors.length)
    throw new AggregateError([...(originalFailure === undefined ? [] : [originalFailure]), ...cleanupErrors],
      'Actual Windows vendor compatibility or original cleanup failed');
  assert.equal(cleanup, true);
  assert.deepEqual(model.failures, []);
  return { requests: model.requests, failures: model.failures, cleanup,
    providerEntry: import.meta.resolve('@agent-teams/provider-implementations/claude') };
}
