import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { createClaudeDriverFactory } from '@agent-teams/provider-implementations/claude';
import { CONTEXT_MARKER, REQUIRED_TOOLS, record } from './model.ts';
import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { DriverFactory, Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { ChildProcess } from 'node:child_process';
import type { TeamMcpEndpoint } from '../../../dist/mcp/index.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Trusted TEST composition only. SDK/CLI/MCP remain the actual public D path. */
export function nativeTeamDriver(options: {
  root: string;
  node: string;
  modelUrl: string;
  endpoint: TeamMcpEndpoint;
  currentBinding(): boolean;
}) {
  const children: ChildProcess[] = [];
  const events: Event[] = [];
  const submitted: Input[] = [];
  const launches: { command: string }[] = [];
  const configurationProofs: {
    sessionRef: string;
    configRevision: string;
    initialize: true;
    contextBound: boolean;
  }[] = [];
  let ready = false;
  let diagnostic = '';
  const environment = {
    HOME: join(options.root, 'home'),
    CLAUDE_CONFIG_DIR: join(options.root, 'config'),
    TMPDIR: join(options.root, 'tmp'),
    XDG_CONFIG_HOME: join(options.root, 'xdg-config'),
    XDG_DATA_HOME: join(options.root, 'xdg-data'),
    XDG_CACHE_HOME: join(options.root, 'xdg-cache'),
    PATH: `${dirname(options.node)}:/usr/bin:/bin`,
    ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY',
    ANTHROPIC_BASE_URL: options.modelUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const config: ClaudeConfig = {
    sessionRef: `TEST-native-team-${basename(options.root)}`,
    trustedBinding: `TEST-alice-generation-1-${basename(options.root)}`,
    cwd: join(options.root, 'workspace'),
    model: 'claude-sonnet-4-6',
    accountBinding: 'TEST-dummy-account',
    configRevision: 'TEST-native-team-config-1',
    environment,
    nativeTools: ['Bash'],
    nativeOptions: {
      projectInstructions: {
        append: `${CONTEXT_MARKER}. You are alice, member of test-native-team, working only in ${join(options.root, 'workspace')}.`,
      },
    },
    autoAllowedTools: ['Bash', ...REQUIRED_TOOLS.map((name) => `mcp__team__${name}`)],
    mcpServers: {
      team: {
        type: 'http',
        url: options.endpoint.url,
        headers: { Authorization: `Bearer ${options.endpoint.bearerToken}` },
      },
    },
    requiredTools: { team: REQUIRED_TOOLS },
    probe: async () => options.currentBinding(),
    sessionExists: async () => false,
    limits: {
      queuedInputs: 2,
      inputBytes: 8192,
      outputEvents: 1500,
      outputBytes: 2_000_000,
      pendingInteractions: 4,
      timeoutMs: 45_000,
    },
    custody: {
      launch(launch) {
        launches.push({ command: launch.command });
        assert.equal(launch.cwd, config.cwd);
        const child = spawn(launch.command, launch.args, {
          cwd: launch.cwd,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: launch.signal,
        });
        children.push(child);
        // SDK 0.3.305 sends system options in initialize, not CLI flags. Observe
        // the emitted stream without changing bytes/args/receiver/return/callback.
        // Raw initialize frames contain a private MCP capability and never leave
        // this bounded transient buffer; retain only the narrow proof facts.
        let pending = '';
        let observing = true;
        const sourceWrite = child.stdin.write;
        child.stdin.write = new Proxy(sourceWrite, {
          apply(target, receiver, args) {
            if (observing) {
              const chunk: unknown = args[0];
              const text =
                typeof chunk === 'string'
                  ? chunk
                  : chunk instanceof Uint8Array
                    ? Buffer.from(chunk).toString('utf8')
                    : '';
              if (Buffer.byteLength(pending) + Buffer.byteLength(text) > 512 * 1024) {
                pending = '';
                observing = false;
              } else {
                pending += text;
                let newline = pending.indexOf('\n');
                while (newline >= 0) {
                  const line = pending.slice(0, newline);
                  pending = pending.slice(newline + 1);
                  try {
                    const frame = record(JSON.parse(line) as unknown);
                    const request = record(frame.request);
                    if (frame.type === 'control_request' && request.subtype === 'initialize') {
                      configurationProofs.push({
                        sessionRef: config.sessionRef,
                        configRevision: config.configRevision,
                        initialize: true,
                        contextBound:
                          typeof request.appendSystemPrompt === 'string' &&
                          request.appendSystemPrompt.includes(CONTEXT_MARKER),
                      });
                      pending = '';
                      observing = false;
                      break;
                    }
                  } catch {
                    /* An incomplete/unknown frame does not establish proof. */
                  }
                  newline = pending.indexOf('\n');
                }
              }
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString('utf8')).slice(-6000);
        });
        return child;
      },
      async confirmStopped() {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (children.every((child) => child.exitCode !== null || child.signalCode !== null))
            return true;
          await tick();
        }
        return false;
      },
    },
  };
  const native = createClaudeDriverFactory({
    capabilities: ['session.conversation'],
    resolveConfiguration: async (request) =>
      request.sessionId === config.sessionRef && request.configRevision === config.configRevision
        ? config
        : undefined,
    readCheckpoint: async () => undefined,
  });
  const factory: DriverFactory = {
    async open(request) {
      const opened = await native.open(request);
      const source = opened.driver;
      const driver: Session = {
        sessionRef: source.sessionRef,
        submit: async (input) => {
          submitted.push(structuredClone(input));
          return source.submit(input);
        },
        async *observe() {
          for await (const event of source.observe()) {
            events.push(event);
            yield event;
          }
        },
        respondToInteraction: (ref, reply) => source.respondToInteraction(ref, reply),
        interrupt: (operation) => source.interrupt(operation),
        checkReadiness: async () => {
          const proof = await source.checkReadiness();
          ready =
            proof.ok &&
            options.currentBinding() &&
            launches.length === 1 &&
            configurationProofs.length === 1 &&
            configurationProofs[0]?.contextBound === true;
          return proof;
        },
        checkpoint: () => source.checkpoint(),
        close: () => source.close(),
      };
      return { driver, capabilities: opened.capabilities };
    },
  };
  return {
    factory,
    events,
    submitted,
    launches,
    configurationProofs,
    config,
    canDispatch: () => ready && options.currentBinding(),
    childFacts: () =>
      children.map((child) => ({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      })),
    safeDiagnostic: () =>
      diagnostic
        .replaceAll(options.endpoint.bearerToken, '[TEST capability redacted]')
        .replaceAll(options.endpoint.url, '[private TEST MCP endpoint]')
        .replaceAll(environment.ANTHROPIC_API_KEY, '[TEST dummy key redacted]'),
    async cleanupCapturedChildren() {
      // Failure cleanup addresses only handles returned by this launch callback.
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
      let deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        children.some((child) => child.exitCode === null && child.signalCode === null)
      )
        await tick();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        children.some((child) => child.exitCode === null && child.signalCode === null)
      )
        await tick();
      assert.ok(
        children.every((child) => child.exitCode !== null || child.signalCode !== null),
        'all captured native children have confirmed exit'
      );
    },
  };
}
