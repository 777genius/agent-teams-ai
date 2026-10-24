import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createCodexDriverFactory } from '@agent-teams/provider-implementations/codex';
import { CONTEXT_MARKER, REQUIRED_TOOLS, record } from './model.ts';
import type { CodexAppServerTransport, CodexDriverConfig } from '@agent-teams/provider-implementations/codex';
import type { DriverFactory, Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { TeamMcpEndpoint } from '../../../dist/mcp/index.js';
import type { ChildProcess } from 'node:child_process';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));

export async function cleanupCapturedCodexChild(child: ChildProcess): Promise<void> {
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  child.stdin?.end();
  if (alive()) child.kill('SIGTERM');
  let deadline = Date.now() + 3000;
  while (Date.now() < deadline && alive()) await tick();
  if (alive()) child.kill('SIGKILL');
  deadline = Date.now() + 3000;
  while (Date.now() < deadline && alive()) await tick();
  assert.equal(alive(), false, 'captured Codex child exit confirmed');
}

/** Only process IO/custody and read-only wire observations live here; D owns RPC. */
export async function nativeCodexDriver(options: {
  root: string; binary: string; modelUrl: string; endpoint: TeamMcpEndpoint;
  currentBinding(): boolean;
  onCapturedChild(child: ChildProcess): void;
}) {
  // Factory construction validates the actual public Codex capability vocabulary
  // before allocating a native process. The configuration callback is lazy.
  const native = createCodexDriverFactory({ capabilities: ['text', 'tools'],
    resolveConfiguration: async request => request.sessionId === config.binding.sessionId ? config : undefined,
    readCheckpoint: async () => undefined });
  const root = options.root;
  const workspace = join(root, 'workspace');
  const environment = { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home'),
    TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    PATH: '/usr/bin:/bin', SHELL: '/bin/sh', TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
    TEST_TEAM_MCP_TOKEN: options.endpoint.bearerToken };
  // Native provider and shell configuration from the retained 0.162.0 P1 oracle.
  // The private endpoint bearer is environment-only, not serialized to this file.
  await writeFile(join(root, 'codex-home/config.toml'), `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(environment.HOME)}, TMPDIR = ${JSON.stringify(environment.TMPDIR)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST local fixture"
base_url = ${JSON.stringify(options.modelUrl + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.team]
url = ${JSON.stringify(options.endpoint.url)}
bearer_token_env_var = "TEST_TEAM_MCP_TOKEN"
startup_timeout_sec = 15
tool_timeout_sec = 15
enabled_tools = ${JSON.stringify(REQUIRED_TOOLS)}
${REQUIRED_TOOLS.map(name => `[mcp_servers.team.tools.${name}]\napproval_mode = "approve"`).join('\n')}
`, { mode: 0o600 });
  const child = spawn(options.binary, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  options.onCapturedChild(child);
  let diagnostic = '';
  child.once('error', () => { diagnostic = 'Captured Codex child process failed'; });
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-6000); });
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const facts = { contextSent: false, threadAccepted: false, threadId: '', mcpReady: false,
    mcpTools: [] as string[], errors: [] as { method: string; code: unknown }[],
    sentMethods: [] as string[], openFailure: '' };
  const pendingFacts = new Map<string, { method: string; threadId?: string }>();
  let pendingBytes = '';
  const inspect = (frame: Record<string, unknown>) => {
    if (frame.method || frame.id === undefined) return;
    const request = pendingFacts.get(String(frame.id));
    if (!request) return;
    pendingFacts.delete(String(frame.id));
    if (frame.error) { facts.errors.push({ method: request.method, code: record(frame.error).code }); return; }
    const result = record(frame.result);
    if (request.method === 'thread/start') {
      const thread = record(result.thread);
      facts.threadAccepted = typeof thread.id === 'string' && result.cwd === workspace;
      facts.threadId = typeof thread.id === 'string' ? thread.id : '';
    }
    if (request.method === 'mcpServerStatus/list' && request.threadId === facts.threadId) {
      const servers = Array.isArray(result.data) ? result.data.map(record) : [];
      const team = servers.find(server => server.name === 'team');
      if (team) {
        facts.mcpTools = Object.keys(record(team.tools));
        facts.mcpReady = team.runtimeStatus === 'connected' && !team.toolsError &&
          REQUIRED_TOOLS.every(name => facts.mcpTools.includes(name));
      }
    }
  };
  const transport: CodexAppServerTransport = {
    async *read(signal) {
      const abort = () => { child.stdin.end(); child.stdout.destroy(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        for await (const raw of child.stdout) {
          const chunk = Buffer.from(raw as Uint8Array);
          pendingBytes += chunk.toString('utf8');
          if (Buffer.byteLength(pendingBytes) > 1024 * 1024) throw new Error('TEST native observation frame budget');
          let newline = pendingBytes.indexOf('\n');
          while (newline >= 0) {
            const line = pendingBytes.slice(0, newline); pendingBytes = pendingBytes.slice(newline + 1);
            inspect(record(JSON.parse(line) as unknown));
            newline = pendingBytes.indexOf('\n');
          }
          yield chunk;
        }
      } finally { signal.removeEventListener('abort', abort); }
    },
    write(frame, signal) {
      if (signal.aborted) throw new Error('TEST write aborted');
      const value = record(JSON.parse(frame) as unknown);
      if (typeof value.method === 'string') {
        assert.ok(facts.sentMethods.length < 128, 'finite native method observation budget');
        facts.sentMethods.push(value.method);
      }
      if (value.method === 'thread/start') {
        facts.contextSent = record(value.params).developerInstructions ===
          `${CONTEXT_MARKER}. You are bob in test-codex-team; work only in ${workspace}.`;
      }
      if (value.id !== undefined && typeof value.method === 'string') {
        assert.ok(pendingFacts.size < 64, 'bounded read-only request fact correlation');
        const threadId = record(value.params).threadId;
        pendingFacts.set(String(value.id), { method: value.method,
          ...(typeof threadId === 'string' ? { threadId } : {}) });
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(frame, error => error ? reject(error) : resolve());
      });
    },
  };
  const config: CodexDriverConfig = {
    binding: { tenantId: 'TEST-tenant', projectId: 'TEST-project',
      sessionId: `TEST-codex-${basename(root)}`, generation: 1 },
    configRevision: 'TEST-codex-config-1', protocolRevision: '0.162.0',
    trustedBinding: `TEST-bob-${basename(root)}`, accountBinding: 'TEST-dummy-codex-account',
    transport, initialize: { clientInfo: { name: 'TEST-native-team', version: '1' }, capabilities: { experimentalApi: true } },
    threadParams: { cwd: workspace, model: 'mock-model', approvalPolicy: 'never', sandbox: 'workspace-write',
      developerInstructions: `${CONTEXT_MARKER}. You are bob in test-codex-team; work only in ${workspace}.` },
    requiredMcpTools: { team: REQUIRED_TOOLS },
    limits: { queuedInputs: 2, inputBytes: 8192, outputEvents: 1500,
      outputBytes: 1_000_000, pendingInteractions: 4, timeoutMs: 30_000 },
    probe: async () => alive() && options.currentBinding() && facts.contextSent && facts.threadAccepted,
    async confirmStopped() {
      child.stdin.end();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && alive()) await tick();
      return !alive();
    },
  };
  const events: Event[] = []; const submitted: Input[] = [];
  let ready = false;
  const factory: DriverFactory = { async open(request) {
    const opened = await native.open(request).catch((error: unknown) => {
      const code = record(error).code;
      const message = error instanceof Error ? error.message : '';
      const safe = typeof code === 'string' ? code : message;
      facts.openFailure = /^codex\.[a-zA-Z0-9.-]{1,160}$/.test(safe) ? safe : 'unclassified-open-failure';
      throw error;
    });
    const source = opened.driver;
    const driver: Session = {
      sessionRef: source.sessionRef,
      submit: input => { submitted.push(structuredClone(input)); return source.submit(input); },
      async *observe() { for await (const event of source.observe()) { events.push(event); yield event; } },
      respondToInteraction: (ref, reply) => source.respondToInteraction(ref, reply),
      interrupt: operation => source.interrupt(operation),
      checkReadiness: async () => {
        const proof = await source.checkReadiness();
        ready = proof.ok && facts.mcpReady && facts.contextSent && facts.threadAccepted && options.currentBinding();
        return proof;
      }, checkpoint: () => source.checkpoint(), close: () => source.close(),
    };
    return { driver, capabilities: opened.capabilities };
  } };
  return { factory, config, facts, events, submitted,
    canDispatch: () => ready && alive() && options.currentBinding(),
    childFacts: () => [{ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }],
    safeDiagnostic: () => diagnostic.replaceAll(options.endpoint.bearerToken, '[TEST capability redacted]')
      .replaceAll(options.endpoint.url, '[private TEST MCP endpoint]')
      .replaceAll(environment.TEST_CODEX_FIXTURE_KEY, '[TEST dummy key redacted]'),
    cleanup: () => cleanupCapturedCodexChild(child),
  };
}
