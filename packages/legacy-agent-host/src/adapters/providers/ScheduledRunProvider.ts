import { createClaudeDriverFactory } from '@agent-teams/provider-implementations/claude';
import { captureCodexExtraArgs, codexMcpPolicyArgs, createCodexDriverFactory } from '@agent-teams/provider-implementations/codex';
import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { capturedMcpServersSchema } from '../../mcp-catalog/capturedServer.js';
import { capturedNativeProcessFactory } from './capturedNativeProcessFactory.js';
import { ClaudeSubagentLogProjection } from './ClaudeSubagentLogProjection.js';
import { codexByteTransport } from './codexByteTransport.js';
import { codexExternalMcpPolicy } from './codexMcpPolicy.js';
import { readCodexMcpCatalog } from './readCodexMcpCatalog.js';
import type { ClaudeConfig, ClaudeSubagentPort } from '@agent-teams/provider-implementations/claude';
import type { DriverFactory, OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { RuntimeMemberProfile } from '../../composition/runtimeProfile.js';
import type { ProcessCustody } from '../../composition/processCustody.js';
import type { RuntimeBinding } from '../../runtime/contracts.js';
import type { HostWindowsLaunch } from '../../owned-process/HostWindowsLaunch.js';
import type { RuntimeSourceProcessOrigin } from '../../composition/runtimeSourceProcessOrigin.js';

export interface ScheduledRunProviderContext {
  profile: RuntimeMemberProfile;
  request: OpenConfig;
  binding: RuntimeBinding;
  subagents?: ClaudeSubagentPort;
  disallowedTools?: readonly string[];
  processCustody?: ProcessCustody;
  retainedWindowsLaunch?: HostWindowsLaunch;
  processOrigin?: RuntimeSourceProcessOrigin;
  isCurrent(): boolean;
  onProgress(): void;
}
export interface ScheduledRunProvider {
  factory: DriverFactory;
  seal(): void;
  cleanup(): Promise<boolean>;
}

/** A finite standalone session: no Team MCP endpoint, hidden member, bootstrap or checkpoint. */
export function createScheduledRunProvider(context: ScheduledRunProviderContext): ScheduledRunProvider {
  const { profile, request } = context;
  if (profile.provider === 'opencode') throw new Error('Scheduled standalone provider unsupported');
  let allocated = false;
  let sealed = false;
  const current = () => !sealed && context.isCurrent() && capturedMcpSourceCurrent(profile);
  const custody = capturedNativeProcessFactory(context.retainedWindowsLaunch, context.processOrigin)(profile, current, context.processCustody);
  const childLogs = new ClaudeSubagentLogProjection(context.binding);
  const selected = (value: OpenConfig) => current() &&
    JSON.stringify(value) === JSON.stringify(request) && value.checkpointRef === undefined;
  const readCheckpoint = async () => undefined;
  let factory: DriverFactory;
  if (profile.provider === 'claude') {
    const externalMcp: ClaudeConfig['mcpServers'] = {};
    for (const [name, server] of Object.entries(capturedMcpServersSchema.parse(profile.capturedMcpServers ?? {})))
      externalMcp[name] = server.type === 'stdio'
        ? { type: 'stdio', command: server.command, ...(server.args ? { args: [...server.args] } : {}),
            ...(server.env ? { env: { ...server.env } } : {}) }
        : { type: server.type, url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) };
    const config: ClaudeConfig = {
      sessionRef: profile.sessionId,
      trustedBinding: `scheduled/${request.tenantId}/${request.projectId}/${request.sessionId}`,
      cwd: profile.cwd, model: profile.model, accountBinding: profile.accountBinding,
      executablePath: profile.executable.path,
      configRevision: profile.configRevision, environment: { ...profile.environment },
      sessionPersistence: 'ephemeral',
      ...(profile.configNamespace ? { configNamespace: profile.configNamespace } : {}),
      ...(profile.extraArgs ? { extraArgs: [...profile.extraArgs] } : {}),
      nativeOptions: {
        ...(profile.nativeOptions?.permissionMode === undefined ? {} : { permissionMode: profile.nativeOptions.permissionMode }),
        ...(profile.nativeOptions?.allowDangerouslySkipPermissions === undefined ? {} : { allowDangerouslySkipPermissions: profile.nativeOptions.allowDangerouslySkipPermissions }),
        ...(profile.nativeOptions?.settingSources === undefined ? {} : { settingSources: [...profile.nativeOptions.settingSources] }),
        ...(profile.nativeOptions?.effort === undefined ? {} : { effort: profile.nativeOptions.effort }),
        ...(profile.nativeOptions?.fastMode === undefined ? {} : { fastMode: profile.nativeOptions.fastMode }),
        ...(profile.nativeOptions?.context === undefined ? {} : { context: profile.nativeOptions.context }),
        ...(profile.nativeOptions?.projectInstructions?.append === undefined ? {} :
          { projectInstructions: { append: profile.nativeOptions.projectInstructions.append } }),
      },
      ...(context.subagents ? { subagents: context.subagents } : {}),
      nativeTools: [...new Set([...profile.nativeTools, ...(context.subagents ? ['Agent'] : [])])],
      autoAllowedTools: [...profile.autoAllowedTools],
      ...(context.disallowedTools !== undefined ? { disallowedTools: [...context.disallowedTools] } : {}),
      mcpServers: externalMcp,
      requiredTools: {}, limits: { ...profile.limits }, probe: async () => current(),
      sessionExists: async () => false,
      custody: { launch: custody.launch, confirmStopped: () => custody.confirmStopped() },
    };
    factory = createClaudeDriverFactory({ capabilities: ['session.conversation', ...(context.subagents ? ['session.subagents'] : [])],
      resolveConfiguration: async value => {
        if (allocated || !selected(value)) return undefined;
        allocated = true;
        return config;
      }, readCheckpoint });
  } else {
    const policy = codexExternalMcpPolicy(profile);
    const verifyMcpCatalog = async (signal?: AbortSignal) => {
      if (!policy) return current();
      const assertCurrent = () => { if (!current()) throw new Error('Scheduled source changed'); };
      try {
        const observed = await readCodexMcpCatalog(profile, assertCurrent, signal, context.retainedWindowsLaunch, context.processOrigin);
        return current() && observed.digest === policy.catalog.digest;
      } catch { return false; }
    };
    factory = createCodexDriverFactory({ capabilities: ['text', 'tools'], readCheckpoint,
      resolveConfiguration: async value => {
        if (allocated || !selected(value) || !(await verifyMcpCatalog())) return undefined;
        if (!selected(value)) return undefined;
        allocated = true;
        const child = custody.launch({ command: profile.executable.path, cwd: profile.cwd,
          args: [...(policy ? codexMcpPolicyArgs(policy) : []), 'app-server', '--listen', 'stdio://',
            ...captureCodexExtraArgs(profile.extraArgs)] });
        return {
          binding: { tenantId: value.tenantId, projectId: value.projectId,
            sessionId: value.sessionId, generation: value.generation },
          configRevision: profile.configRevision, protocolRevision: profile.protocolRevision,
          trustedBinding: `scheduled/${value.tenantId}/${value.projectId}/${value.sessionId}`,
          accountBinding: profile.accountBinding, transport: codexByteTransport(child),
          initialize: { clientInfo: { name: 'legacy-agent-host', version: '0.1.0' },
            capabilities: { experimentalApi: true } },
          threadParams: { ephemeral: true, cwd: profile.cwd, model: profile.model,
            approvalPolicy: profile.nativeOptions.approvalPolicy, sandbox: profile.nativeOptions.sandbox,
            ...(profile.nativeOptions.fastMode === true ? { serviceTier: 'fast' } : {}),
            ...(profile.nativeOptions.modelProvider ? { modelProvider: profile.nativeOptions.modelProvider } : {}),
            ...(profile.nativeOptions.developerInstructions ? { developerInstructions: profile.nativeOptions.developerInstructions } : {}) },
          ...(profile.nativeOptions.reasoningEffort ? { turnParams: { effort: profile.nativeOptions.reasoningEffort } } : {}),
          ...(policy ? { mcpPolicy: policy, verifyMcpCatalog } : {}),
          requiredMcpTools: {}, limits: { ...profile.limits },
          probe: async () => current() && custody.isRunning(),
          confirmStopped: async () => { child.stdin.end(); return custody.confirmStopped(); },
        };
      } });
  }
  return {
    seal() { sealed = true; },
    cleanup: () => custody.confirmStopped(),
    factory: {
    async open(value) {
      try {
        const opened = await factory.open(value), source = opened.driver;
        const driver: Session = {
          sessionRef: source.sessionRef,
          submit: input => source.submit(input),
          async *observe() {
            try { for await (const event of source.observe()) {
              yield context.subagents ? childLogs.project(event) : event;
              context.onProgress();
            } }
            finally { context.onProgress(); }
          },
          respondToInteraction: (ref, reply) => source.respondToInteraction(ref, reply),
          interrupt: ref => source.interrupt(ref), checkReadiness: () => source.checkReadiness(),
          checkpoint: () => ({ ok: false, code: 'unsupported' }), close: () => source.close(),
        };
        return { ...opened, driver, capabilities: opened.capabilities.filter(cap => cap !== 'checkpoint') };
      } catch {
        await custody.confirmStopped();
        throw new Error('Scheduled native session unavailable');
      }
    },
    },
  };
}
